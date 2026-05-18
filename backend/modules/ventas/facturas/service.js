/**
 * backend/modules/ventas/facturas/service.js
 *
 * Lógica fiscal del módulo Facturas. NO conoce req/res.
 *
 * Operaciones:
 *   - emitirFacturaDesdeOT: credito-check + tx (NCF B01/B02 via ncfService +
 *     totales + crear factura + marcar OT Completada). Email PDF fire-and-forget.
 *   - revertirFactura (God Mode): Pagada/Anulada → Borrador + restore stock.
 *   - emitirNotaCredito (B04): anula origen + restaura stock (si origen Pagada)
 *     + crea NC con totales idénticos + AuditCaja inmutable.
 *   - emitirNotaDebito (B03): carga adicional contra origen, NO anula, NO toca
 *     inventario. Monto INPUT del usuario + ITBIS opcional.
 *   - patchCondiciones: edición rápida de condiciones comerciales por doc.
 *
 * NCF: TODA secuencia NCF se obtiene via deps.ncfService.nextNcfSequence —
 * acceso directo a prisma.configuracionNCF PROHIBIDO (audit-leak risk).
 *
 * AuditCaja: hash-chain append-only. Inicio cada AppendAuditCaja lee el
 * último hash, computa HMAC-SHA256(payload | prevHash, AUDIT_SECRET).
 *
 * Factory: createFacturasService({ repo, auditReq, ncfService,
 *   generarSiguienteCodigo, persistirVerifyHash, buildFacturaPDFBuffer,
 *   sendFacturaPDF, pdfService })
 */

const crypto = require('crypto');

class FacturaError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code   = code;
  }
}

function _resolveAuditSecret() {
  return process.env.AUDIT_SECRET ?? process.env.JWT_SECRET ?? 'change-me-audit-secret';
}

function _canonicalizarCaja(row) {
  const safe = {
    tipo:       row.tipo       ?? '',
    empleadoId: row.empleadoId ?? null,
    facturaId:  row.facturaId  ?? null,
    monto:      row.monto      != null ? String(row.monto) : null,
    descPct:    row.descPct    != null ? String(row.descPct) : null,
    detalle:    row.detalle    ?? '',
    ip:         row.ip         ?? null,
    createdAt:  row.createdAt  ? new Date(row.createdAt).toISOString() : new Date().toISOString(),
  };
  return JSON.stringify(safe, Object.keys(safe).sort());
}

function createFacturasService(deps) {
  const {
    repo, auditReq, ncfService,
    generarSiguienteCodigo, persistirVerifyHash,
    buildFacturaPDFBuffer, sendFacturaPDF, pdfService,
    ownerAlerts,
  } = deps;
  if (!repo)                                          throw new Error('createFacturasService: repo required');
  if (typeof auditReq !== 'function')                 throw new Error('createFacturasService: auditReq required');
  if (!ncfService || typeof ncfService.nextNcfSequence !== 'function') {
    throw new Error('createFacturasService: ncfService.nextNcfSequence required (shared/services/ncf.service)');
  }
  if (typeof generarSiguienteCodigo !== 'function')   throw new Error('createFacturasService: generarSiguienteCodigo required');
  if (typeof persistirVerifyHash !== 'function')      throw new Error('createFacturasService: persistirVerifyHash required');

  function _fakeReqForAudit(reqMeta, user) {
    return {
      headers: {
        'x-forwarded-for': reqMeta?.ip ?? null,
        'user-agent':      reqMeta?.ua ?? null,
      },
      socket: { remoteAddress: reqMeta?.ip ?? null },
      user:   user ?? null,
    };
  }

  /** Append-only AuditCaja con hash-chain HMAC-SHA256. */
  async function _appendAuditCaja(data) {
    const last     = await repo.findLastAuditCajaHash();
    const prevHash = last?.hash ?? 'GENESIS';
    const payload  = _canonicalizarCaja({ ...data, createdAt: data.createdAt ?? new Date() });
    const hash     = crypto.createHmac('sha256', _resolveAuditSecret()).update(payload + '|' + prevHash).digest('hex');
    return repo.crearAuditCaja({ ...data, prevHash, hash });
  }

  // ─── Revertir (God Mode) ─────────────────────────────────────────────────
  async function revertirFactura(id, dto, user, reqMeta, deps) {
    const { prisma } = deps;
    const { motivo } = dto;
    const existing = await repo.findFacturaWithLineasProducto(id);
    if (!existing) throw new FacturaError(404, 'NOT_FOUND', 'Factura no encontrada.');
    if (!['Pagada', 'Anulada'].includes(existing.estado)) {
      throw new FacturaError(409, 'ESTADO_INVALIDO', `No se puede revertir factura en estado ${existing.estado}.`);
    }

    const resultado = await prisma.$transaction(async (tx) => {
      let stockRestaurado = 0;
      // Restaurar stock SOLO si Pagada (la salida había ocurrido al emitir).
      // Si Anulada, NO restaurar (ya volvió cuando se anuló, o nunca salió).
      if (existing.estado === 'Pagada') {
        for (const l of existing.lineas) {
          if (l.productoId && l.producto?.tipoItem !== 'SERVICIO' && Number(l.cantidad) > 0) {
            await repo.restaurarStockTx(tx, l.productoId, l.cantidad);
            await repo.crearKardexEntradaTx(tx, l.productoId, l.cantidad);
            stockRestaurado++;
          }
        }
      }
      const updated = await repo.updateFacturaToBorradorTx(tx, existing.id);
      return { updated, stockRestaurado };
    });

    auditReq('factura:revertida_god_mode', _fakeReqForAudit(reqMeta, user), {
      facturaId: existing.id, estadoAnterior: existing.estado, motivo, stockRestaurado: resultado.stockRestaurado,
    });
    await _appendAuditCaja({
      tipo:       'factura_revertida',
      empleadoId: user?.sub ?? null,
      facturaId:  existing.id,
      monto:      Number(existing.total),
      detalle:    `God Mode: ${existing.estado} → Borrador. Stock restaurado: ${resultado.stockRestaurado}. Motivo: ${motivo}`,
      ip:         reqMeta?.ip,
      ua:         String(reqMeta?.ua ?? '').slice(0, 200),
    }).catch(() => {});

    return { status: 200, body: { ok: true, factura: resultado.updated, stockRestaurado: resultado.stockRestaurado } };
  }

  // ─── Nota de Crédito B04 ─────────────────────────────────────────────────
  async function emitirNotaCredito(id, dto, user, reqMeta, deps) {
    const { prisma } = deps;
    const { motivo, pinSupervisor } = dto;
    const permisos = Array.isArray(user?.permisos) ? user.permisos : [];
    const puedeAnular = permisos.includes('sistema:owner') || permisos.includes('factura:anular');
    if (!puedeAnular) {
      auditReq('nc:denied_perm', _fakeReqForAudit(reqMeta, user), { facturaId: id });
      throw new FacturaError(403, 'NC_PERMISSION', 'Emitir Nota de Crédito requiere permiso "factura:anular".');
    }

    // PIN compare timing-safe (igual padrón que pos/service.verifyPin).
    const empPin = await _getEmpresaPin(deps);
    const a = Buffer.from(String(pinSupervisor).padEnd(16, '\0'));
    const b = Buffer.from(String(empPin).padEnd(16, '\0'));
    const okPin = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!okPin) {
      auditReq('nc:pin_fail', _fakeReqForAudit(reqMeta, user), { facturaId: id });
      throw new FacturaError(401, 'NC_PIN_INVALID', 'PIN de supervisor inválido.');
    }

    const origen = await repo.findFacturaWithLineasProducto(id);
    if (!origen)                       throw new FacturaError(404, 'NOT_FOUND',        'Factura origen no encontrada.');
    if (origen.esCotizacion)           throw new FacturaError(409, 'IS_COTIZACION',    'No se puede emitir NC sobre una cotización.');
    if (origen.esNotaCredito)          throw new FacturaError(409, 'IS_NC',            'No se puede emitir NC sobre otra Nota de Crédito.');
    if (origen.esNotaDebito)           throw new FacturaError(409, 'IS_ND',            'No se puede emitir NC sobre una Nota de Débito (emite NC contra la factura original).');
    if (origen.estado === 'Anulada')   throw new FacturaError(409, 'YA_ANULADA',       'La factura origen ya está Anulada.');
    if (origen.estado === 'Borrador')  throw new FacturaError(409, 'EN_BORRADOR',      'La factura origen aún está en Borrador, no requiere NC.');

    const resultado = await prisma.$transaction(async (tx) => {
      // 1. Secuencia NCF B04 via shared service (bootstrap idempotente +
      // atomic UPSERT-then-UPDATE-RETURNING).
      const { ncf: ncfNC } = await ncfService.nextNcfSequence({ tipoNcf: 'Nota de Crédito', tx });
      const noFacturaNC = await generarSiguienteCodigo('notaCredito', tx);

      // 2. Restaurar stock SOLO si origen estaba Pagada.
      let stockRestaurado = 0;
      if (origen.estado === 'Pagada') {
        for (const l of origen.lineas) {
          if (l.productoId && l.producto?.tipoItem !== 'SERVICIO' && Number(l.cantidad) > 0) {
            await repo.restaurarStockTx(tx, l.productoId, l.cantidad);
            await repo.crearKardexEntradaTx(tx, l.productoId, l.cantidad);
            stockRestaurado++;
          }
        }
      }

      // 3. Crear NC (Factura esNotaCredito=true) con líneas idénticas al origen.
      const nc = await repo.crearNotaCreditoTx(tx, {
        noFactura:         noFacturaNC,
        clienteId:         origen.clienteId,
        ordenId:           origen.ordenId,
        empleadoId:        user?.sub ?? null,
        estado:            'Emitida',
        subtotal:          origen.subtotal,
        itbis:             origen.itbis,
        total:             origen.total,
        ncf:               ncfNC,
        tipoNcf:           'Nota de Crédito',
        fechaEmision:      new Date(),
        fechaVence:        null,
        esNotaCredito:           true,
        facturaOrigenId:         origen.id,
        motivoNotaModificatoria: motivo,
        notas: `Anula a ${origen.noFactura}${origen.ncf ? ` (NCF ${origen.ncf})` : ''}. Motivo: ${motivo}`,
        lineas: {
          create: origen.lineas.map(l => ({
            productoId:          l.productoId ?? null,
            descripcion:         l.descripcion,
            cantidad:            l.cantidad,
            precioUnitario:      l.precioUnitario,
            descuentoPorcentaje: l.descuentoPorcentaje,
            descuentoMonto:      l.descuentoMonto,
          })),
        },
      });

      // 4. Anular factura origen + invalidar cache PDF.
      const origenAnulada = await repo.updateFacturaToAnuladaTx(tx, origen.id);
      return { nc, origenAnulada, stockRestaurado };
    });

    // Fire-and-forget cache invalidation post-commit.
    pdfService?.invalidarPdfCache?.(resultado.nc.id).catch(() => {});
    pdfService?.invalidarPdfCache?.(resultado.origenAnulada.id).catch(() => {});

    auditReq('nc:emitida', _fakeReqForAudit(reqMeta, user), {
      ncId:            resultado.nc.id,
      ncfNC:           resultado.nc.ncf,
      origenId:        origen.id,
      ncfOrigen:       origen.ncf,
      total:           Number(origen.total),
      stockRestaurado: resultado.stockRestaurado,
      motivo,
    });

    // Mejora #5 — Owner God-Mode Alert. NC emitida = factura origen anulada
    // + (típicamente) stock restaurado. Si stockRestaurado=false en una NC
    // que debería retornar productos, el owner debe enterarse YA — eso es
    // exactamente el fraude clásico "anulo factura, no devuelvo producto".
    if (ownerAlerts) {
      const stockProducts = Array.isArray(origen.lineas)
        ? origen.lineas.some(l => l.productoId && Number(l.cantidad) > 0)
        : false;
      const ncSinDevolucion = stockProducts && !resultado.stockRestaurado;
      ownerAlerts.tryEmit({
        tipo:         'nc.emitida',
        severity:     ncSinDevolucion ? 'critical' : 'warn',
        resourceType: 'factura',
        resourceId:   String(resultado.nc.id),
        payload: {
          ncId:            resultado.nc.id,
          ncfNC:           resultado.nc.ncf,
          origenId:        origen.id,
          ncfOrigen:       origen.ncf,
          noFacturaOrigen: origen.noFactura,
          total:           Number(origen.total),
          stockRestaurado: resultado.stockRestaurado,
          tieneProductos:  stockProducts,
          ncSinDevolucion,
          motivo:          motivo ?? null,
        },
        user, reqMeta,
      });
      // Y la factura origen quedó Anulada como consecuencia.
      ownerAlerts.tryEmit({
        tipo:         'factura.anulada',
        severity:     'warn',
        resourceType: 'factura',
        resourceId:   String(origen.id),
        payload: {
          facturaId:  origen.id,
          noFactura:  origen.noFactura,
          ncf:        origen.ncf,
          total:      Number(origen.total),
          via:        'nota-credito',
          ncIdRelacionada: resultado.nc.id,
          motivo:     motivo ?? null,
        },
        user, reqMeta,
      });
    }
    await _appendAuditCaja({
      tipo:       'nota_credito_emitida',
      empleadoId: user?.sub ?? null,
      facturaId:  resultado.nc.id,
      monto:      Number(origen.total),
      detalle:    `NC ${resultado.nc.ncf} anula a ${origen.noFactura} (NCF ${origen.ncf ?? '—'}). Stock restaurado: ${resultado.stockRestaurado}. Motivo: ${motivo}`,
      ip:         reqMeta?.ip,
      ua:         String(reqMeta?.ua ?? '').slice(0, 200),
    }).catch(() => {});

    return {
      status: 201,
      body: { ok: true, notaCredito: resultado.nc, origen: resultado.origenAnulada, stockRestaurado: resultado.stockRestaurado },
    };
  }

  // ─── Nota de Débito B03 ─────────────────────────────────────────────────
  async function emitirNotaDebito(id, dto, user, reqMeta, deps) {
    const { prisma } = deps;
    const { motivo, pinSupervisor, monto, aplicarItbis } = dto;
    const permisos = Array.isArray(user?.permisos) ? user.permisos : [];
    const puede = permisos.includes('sistema:owner') || permisos.includes('factura:anular');
    if (!puede) {
      auditReq('nd:denied_perm', _fakeReqForAudit(reqMeta, user), { facturaId: id });
      throw new FacturaError(403, 'ND_PERMISSION', 'Emitir Nota de Débito requiere permiso "factura:anular".');
    }

    const empPin = await _getEmpresaPin(deps);
    const a = Buffer.from(String(pinSupervisor).padEnd(16, '\0'));
    const b = Buffer.from(String(empPin).padEnd(16, '\0'));
    const okPin = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!okPin) {
      auditReq('nd:pin_fail', _fakeReqForAudit(reqMeta, user), { facturaId: id });
      throw new FacturaError(401, 'ND_PIN_INVALID', 'PIN de supervisor inválido.');
    }

    const origen = await repo.findFacturaForND(id);
    if (!origen)                       throw new FacturaError(404, 'NOT_FOUND',        'Factura origen no encontrada.');
    if (origen.esCotizacion)           throw new FacturaError(409, 'IS_COTIZACION',    'No se puede emitir ND sobre una cotización.');
    if (origen.esNotaCredito)          throw new FacturaError(409, 'IS_NC',            'No se puede emitir ND sobre una Nota de Crédito.');
    if (origen.esNotaDebito)           throw new FacturaError(409, 'IS_ND',            'No se puede emitir ND sobre otra Nota de Débito.');
    if (origen.estado === 'Anulada')   throw new FacturaError(409, 'YA_ANULADA',       'La factura origen está Anulada, no admite ajustes.');
    if (origen.estado === 'Borrador')  throw new FacturaError(409, 'EN_BORRADOR',      'La factura origen aún está en Borrador, no requiere ND.');

    // Totales del ND.
    const subtotal = Math.round(Number(monto) * 100) / 100;
    const itbis    = aplicarItbis ? Math.round(subtotal * 0.18 * 100) / 100 : 0;
    const total    = Math.round((subtotal + itbis) * 100) / 100;

    const resultado = await prisma.$transaction(async (tx) => {
      const { ncf: ncfND } = await ncfService.nextNcfSequence({ tipoNcf: 'Nota de Débito', tx });
      const noFacturaND = await generarSiguienteCodigo('notaDebito', tx);

      const nd = await repo.crearNotaDebitoTx(tx, {
        noFactura:    noFacturaND,
        clienteId:    origen.clienteId,
        ordenId:      origen.ordenId,
        empleadoId:   user?.sub ?? null,
        estado:       'Emitida',
        subtotal,
        itbis,
        total,
        ncf:          ncfND,
        tipoNcf:      'Nota de Débito',
        fechaEmision: new Date(),
        fechaVence:   new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        esNotaDebito:            true,
        facturaOrigenId:         origen.id,
        motivoNotaModificatoria: motivo,
        notas:                   `Cargo adicional contra ${origen.noFactura}${origen.ncf ? ` (NCF ${origen.ncf})` : ''}. Motivo: ${motivo}`,
        lineas: {
          create: [{
            descripcion:    `Ajuste / Cargo adicional · ${motivo}`,
            cantidad:       1,
            precioUnitario: subtotal,
          }],
        },
      });
      return { nd };
    });

    pdfService?.invalidarPdfCache?.(resultado.nd.id).catch(() => {});

    auditReq('nd:emitida', _fakeReqForAudit(reqMeta, user), {
      ndId: resultado.nd.id, ncfND: resultado.nd.ncf,
      origenId: origen.id, ncfOrigen: origen.ncf,
      monto: total, motivo,
    });
    await _appendAuditCaja({
      tipo:       'nota_debito_emitida',
      empleadoId: user?.sub ?? null,
      facturaId:  resultado.nd.id,
      monto:      total,
      detalle:    `ND ${resultado.nd.ncf} carga RD$${total.toFixed(2)} contra ${origen.noFactura} (NCF ${origen.ncf ?? '—'}). Motivo: ${motivo}`,
      ip:         reqMeta?.ip,
      ua:         String(reqMeta?.ua ?? '').slice(0, 200),
    }).catch(() => {});

    return { status: 201, body: { ok: true, notaDebito: resultado.nd } };
  }

  // ─── Emisión normal desde OT ─────────────────────────────────────────────
  async function emitirFacturaDesdeOT(dto, user, reqMeta, deps) {
    const { prisma } = deps;
    const { ordenId, forzarCredito } = dto;

    // ── Credit check pre-tx (fail rápido sin abrir transacción) ──
    const otPre = await repo.findOTForCreditCheck(ordenId);
    if (otPre && otPre.cliente && Number(otPre.cliente.limiteCredito) > 0) {
      const totalNueva = otPre.lineas.reduce((s, l) => s + Number(l.precioUnitario) * l.cantidad, 0) * 1.18;
      const deudaActual = await repo.aggregateDeudaActual(otPre.cliente.id);
      const deuda  = Number(deudaActual._sum.total ?? 0);
      const limite = Number(otPre.cliente.limiteCredito);
      if (deuda + totalNueva > limite) {
        const perms = Array.isArray(user?.permisos) ? user.permisos : [];
        const puedeForzar = perms.includes('ventas:forzar_credito') || perms.includes('sistema:owner');
        if (!puedeForzar || !forzarCredito) {
          auditReq('factura:credito_bloqueado', _fakeReqForAudit(reqMeta, user), {
            clienteId: otPre.cliente.id, deuda, limite, intento: totalNueva,
          });
          const err = new FacturaError(422, 'CREDIT_LIMIT_EXCEEDED',
            `Crédito excedido: ${otPre.cliente.razonSocial} debe RD$${deuda.toFixed(0)} de RD$${limite.toFixed(0)} permitidos. Esta factura suma RD$${totalNueva.toFixed(0)}.`);
          err.extra = { puedeForzar, detalle: { deudaActual: deuda, limiteCredito: limite, montoIntentado: totalNueva } };
          throw err;
        }
        auditReq('factura:credito_forzado', _fakeReqForAudit(reqMeta, user), {
          clienteId: otPre.cliente.id, deuda, limite, monto: totalNueva,
        });
      }
    }

    const factura = await prisma.$transaction(async (tx) => {
      const ot = await repo.findOTForEmissionTx(tx, ordenId);
      if (!ot || ot.deletedAt)       throw new FacturaError(404, 'OT_NOT_FOUND',     'Orden no encontrada.');
      if (ot.facturas.length > 0)    throw new FacturaError(409, 'OT_YA_FACTURADA',  'Esta orden ya tiene factura.');
      if (ot.estado === 'Cancelada') throw new FacturaError(422, 'OT_CANCELADA',    'No se puede facturar una OT cancelada.');

      const tipoNcf = ot.cliente.tipoNcf ?? 'Consumidor Final';
      const { ncf } = await ncfService.nextNcfSequence({ tipoNcf, tx });
      const noFactura = await generarSiguienteCodigo('factura', tx);

      // Cálculo totales — excluye consumoInterno (materiales gastados en
      // instalación que NO se facturan al cliente).
      const lineasFacturables = ot.lineas.filter(l => !l.consumoInterno);
      const subtotal = lineasFacturables.reduce((s, l) => s + Number(l.precioUnitario) * l.cantidad, 0);
      const itbis    = ot.cliente.itbis ? Math.round(subtotal * 0.18 * 100) / 100 : 0;
      const total    = Math.round((subtotal + itbis) * 100) / 100;

      const f = await repo.crearFacturaEmisionTx(tx, {
        noFactura,
        clienteId:  ot.clienteId,
        ordenId:    ot.id,
        empleadoId: user?.sub ?? null,
        estado:     'Emitida',
        subtotal, itbis, total,
        ncf, tipoNcf,
        fechaVence: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });

      await repo.marcarOTFacturadaTx(tx, ordenId);
      return repo.findFacturaForResponse(f.id, tx);
    });

    await persistirVerifyHash(factura);
    auditReq('factura:emitir', _fakeReqForAudit(reqMeta, user), {
      facturaId: factura.id, ncf: factura.ncf, total: Number(factura.total),
    });

    // Fire-and-forget PDF + email (no bloquea respuesta).
    if (typeof buildFacturaPDFBuffer === 'function' && typeof sendFacturaPDF === 'function') {
      setImmediate(async () => {
        try {
          const pdfBuf = await buildFacturaPDFBuffer(factura);
          await sendFacturaPDF(factura, pdfBuf);
        } catch (e) { console.error('[EMAIL FF]', e.message); }
      });
    }

    return { status: 201, body: factura };
  }

  // ─── PIN supervisor lookup helper (compartido con NC/ND) ─────────────────
  async function _getEmpresaPin({ prisma }) {
    const emp = await prisma.empresaPerfil.findUnique({ where: { id: 1 }, select: { pinSupervisor: true } });
    return emp?.pinSupervisor ?? '1234';
  }

  // ─── PATCH condiciones ──────────────────────────────────────────────────
  function _condFieldIsEmpty(v) {
    if (v == null) return true;
    if (typeof v === 'string') return v.trim() === '';
    if (typeof v === 'object') return !v.incluir || !String(v.texto ?? '').trim();
    return true;
  }

  async function patchCondiciones(id, dto, user, reqMeta) {
    const allEmpty = Object.values(dto).every(_condFieldIsEmpty);
    const factura  = await repo.patchCondicionesFactura(id, allEmpty ? null : dto);
    auditReq('factura:condiciones', _fakeReqForAudit(reqMeta, user), { id: factura.id, cleared: allEmpty });
    pdfService?.invalidarPdfCache?.(factura.id).catch(() => {});
    return { status: 200, body: factura };
  }

  return {
    FacturaError,
    revertirFactura,
    emitirNotaCredito,
    emitirNotaDebito,
    emitirFacturaDesdeOT,
    patchCondiciones,
  };
}

module.exports = createFacturasService;
module.exports.FacturaError = FacturaError;
