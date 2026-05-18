/**
 * backend/modules/ventas/cotizaciones/service.js
 *
 * Lógica del módulo Cotizaciones + listado/cambio-de-estado de Facturas.
 * 2FA umbral RD$50K para anulación; cambio Pagada/Vencida sincroniza
 * MikroTik fire-and-forget. Pipeline Kanban con RBAC owner-vs-vendedor.
 *
 * Factory: createCotizacionesService({ repo, auditReq, decryptTOTP,
 *   authenticator, syncMikrotik, persistirVerifyHash, procesarFacturaPOS,
 *   pdfService, totalLinea })
 */

class CotError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code   = code;
    if (extra) this.extra = extra;
  }
}

function createCotizacionesService(deps) {
  const { cotEventoSvc, ownerAlerts } = deps;
  const {
    repo, auditReq, decryptTOTP, authenticator, syncMikrotik,
    persistirVerifyHash, procesarFacturaPOS, pdfService, totalLinea,
  } = deps;
  if (!repo)                                      throw new Error('createCotizacionesService: repo required');
  if (typeof auditReq !== 'function')             throw new Error('createCotizacionesService: auditReq required');
  if (typeof totalLinea !== 'function')           throw new Error('createCotizacionesService: totalLinea required');

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

  // ─── List cotizaciones ───────────────────────────────────────────────────
  async function listarCotizaciones(query) {
    const where = { esCotizacion: true, deletedAt: null };
    if (query.clienteId) where.clienteId = query.clienteId;
    if (query.search)    where.noFactura = { contains: query.search, mode: 'insensitive' };
    const clienteAnd = [];
    if (query.clienteCodigo) clienteAnd.push({ noCliente:   { contains: query.clienteCodigo, mode: 'insensitive' } });
    if (query.clienteNombre) clienteAnd.push({ razonSocial: { contains: query.clienteNombre, mode: 'insensitive' } });
    if (clienteAnd.length > 0) where.cliente = { AND: clienteAnd };
    if (query.desde || query.hasta) {
      where.fechaEmision = {};
      if (query.desde) where.fechaEmision.gte = new Date(query.desde);
      if (query.hasta) { const h = new Date(query.hasta); h.setHours(23, 59, 59, 999); where.fechaEmision.lte = h; }
    }
    const [total, data] = await repo.listCotizaciones(where, parseInt(query.limit, 10), parseInt(query.offset, 10));
    return { status: 200, body: { data, total } };
  }

  // ─── Revivir cotización ──────────────────────────────────────────────────
  async function revivirCotizacion(id, dto, user, reqMeta) {
    const { emitir } = dto;
    const original = await repo.findCotizacionFull(id);
    if (!original || !original.esCotizacion) throw new CotError(404, 'NOT_FOUND', 'Cotización no encontrada.');

    const productoIds = original.lineas.map(l => l.productoId).filter(Boolean);
    const prods = await repo.findProductosForRevivir(productoIds);
    const pMap = Object.fromEntries(prods.map(p => [p.id, p]));

    const lineasRevividas = original.lineas.map(l => {
      if (l.productoId) {
        const actual = pMap[l.productoId];
        const precioActual = actual ? Number(actual.precio) : Number(l.precioUnitario);
        return {
          productoId:          l.productoId,
          descripcion:         l.descripcion,
          cantidad:            l.cantidad,
          precioUnitario:      precioActual,
          descuentoPorcentaje: Number(l.descuentoPorcentaje ?? 0),
          descuentoMonto:      Number(l.descuentoMonto ?? 0),
          _meta: {
            descripcion:        l.descripcion,
            precioEnCotizacion: Number(l.precioUnitario),
            precioActual,
            precioActualizado:  actual !== null && precioActual !== Number(l.precioUnitario),
            stockDisponible:    actual?.stockActual ?? null,
            tipoItem:           actual?.tipoItem ?? null,
          },
        };
      }
      const storedPrice = Number(l.precioUnitario);
      return {
        productoId:          null,
        descripcion:         l.descripcion,
        cantidad:            l.cantidad,
        precioUnitario:      storedPrice,
        descuentoPorcentaje: Number(l.descuentoPorcentaje ?? 0),
        descuentoMonto:      Number(l.descuentoMonto ?? 0),
        _meta: {
          descripcion:        l.descripcion,
          precioEnCotizacion: storedPrice,
          precioActual:       storedPrice,
          precioActualizado:  false,
          stockDisponible:    null,
          tipoItem:           'SERVICIO',
        },
      };
    });

    const sub = Math.round(lineasRevividas.reduce((s, l) => s + totalLinea(l.precioUnitario, l.descuentoPorcentaje, l.descuentoMonto, l.cantidad), 0) * 100) / 100;
    const itb = Number(original.itbis) > 0 ? Math.round(sub * 0.18 * 100) / 100 : 0;

    if (!emitir) {
      return {
        status: 200,
        body: {
          original:           { id: original.id, noFactura: original.noFactura, createdAt: original.createdAt },
          lineas:             lineasRevividas,
          totales:            { subtotal: sub, itbis: itb, total: Math.round((sub + itb) * 100) / 100 },
          hayActualizaciones: lineasRevividas.some(l => l._meta.precioActualizado),
        },
      };
    }

    if (typeof procesarFacturaPOS !== 'function') {
      throw new CotError(503, 'PROCESADOR_POS_NO_DISPONIBLE', 'procesarFacturaPOS no inyectado en deps.');
    }
    const lineasParaProcesar = lineasRevividas.map(({ _meta, ...rest }) => rest);
    const permisos = Array.isArray(user?.permisos) ? user.permisos : [];
    const puedeOverride = permisos.includes('sistema:owner') || permisos.includes('pos:override_precio');
    const nuevaFactura = await procesarFacturaPOS({
      inputClienteId: original.clienteId,
      applyItbis:     Number(original.itbis) > 0,
      diasVence:      original.fechaVence ? Math.max(0, Math.round((new Date(original.fechaVence) - Date.now()) / 86_400_000)) : 30,
      esCotizacion:   false,
      lineas:         lineasParaProcesar,
      puedeOverridePrecio: puedeOverride,
      empleadoId:          user?.sub ?? null,
    });
    if (typeof persistirVerifyHash === 'function') await persistirVerifyHash(nuevaFactura);
    auditReq('cotizacion:revivir', _fakeReqForAudit(reqMeta, user), { originalId: original.id, nuevaId: nuevaFactura.id });
    return { status: 201, body: { factura: nuevaFactura, lineas: lineasRevividas } };
  }

  // ─── Factura by id / list ───────────────────────────────────────────────
  async function getFacturaById(id) {
    const f = await repo.findFacturaFullById(id);
    if (!f) throw new CotError(404, 'NOT_FOUND', 'Factura no encontrada.');
    return { status: 200, body: f };
  }

  async function listarFacturas(query) {
    const where = { deletedAt: null };
    if (query.incluirCotizaciones !== 'true') where.esCotizacion = false;
    if (query.estado)    where.estado    = query.estado;
    if (query.clienteId) where.clienteId = query.clienteId;
    if (query.search)    where.OR = [
      { noFactura: { contains: query.search, mode: 'insensitive' } },
      { ncf:       { contains: query.search, mode: 'insensitive' } },
    ];
    const clienteAnd = [];
    if (query.clienteCodigo) clienteAnd.push({ noCliente:   { contains: query.clienteCodigo, mode: 'insensitive' } });
    if (query.clienteNombre) clienteAnd.push({ razonSocial: { contains: query.clienteNombre, mode: 'insensitive' } });
    if (clienteAnd.length > 0) where.cliente = { AND: clienteAnd };
    if (query.desde || query.hasta) {
      where.fechaEmision = {};
      if (query.desde) where.fechaEmision.gte = new Date(query.desde);
      if (query.hasta) { const h = new Date(query.hasta); h.setHours(23, 59, 59, 999); where.fechaEmision.lte = h; }
    }
    const [total, data] = await repo.listFacturas(where, parseInt(query.limit, 10), parseInt(query.offset, 10));
    return { status: 200, body: { data, total } };
  }

  // ─── Cambio estado factura con 2FA umbral ───────────────────────────────
  async function cambiarEstadoFactura(id, dto, user, reqMeta) {
    const { estado, totp } = dto;
    const existing = await repo.findFacturaForEstadoChange(id);
    if (!existing)                     throw new CotError(404, 'NOT_FOUND', 'Factura no encontrada.');
    if (existing.estado === 'Anulada') throw new CotError(409, 'YA_ANULADA', 'Factura ya anulada. No se puede modificar.');
    if (existing.estado === estado)    throw new CotError(409, 'NO_CHANGE', `Factura ya está en estado ${estado}.`);

    if (estado === 'Anulada') {
      const permisos = Array.isArray(user?.permisos) ? user.permisos : [];
      const puedeAnular = permisos.includes('sistema:owner') || permisos.includes('factura:anular');
      if (!puedeAnular) {
        auditReq('factura:anular_denied_perm', _fakeReqForAudit(reqMeta, user), { facturaId: existing.id, total: Number(existing.total) });
        throw new CotError(403, 'ANULAR_PERMISSION', 'Anular factura requiere permiso "factura:anular".');
      }
      const UMBRAL_2FA_ANULACION = Number(process.env.UMBRAL_2FA_ANULACION ?? 50000);
      if (Number(existing.total) > UMBRAL_2FA_ANULACION) {
        const emp = await repo.findEmpleadoTwoFactor(user.sub);
        if (!emp?.twoFactorEnabled || !emp?.twoFactorSecret) {
          throw new CotError(403, 'TWOFA_REQUIRED_ACCOUNT',
            `Anular factura de RD$${Number(existing.total).toFixed(2)} requiere 2FA activo en tu cuenta.`);
        }
        if (!totp || !/^\d{6}$/.test(String(totp))) {
          throw new CotError(401, 'TWOFA_PIN_REQUIRED', 'Anular factura de alto monto requiere PIN 2FA.');
        }
        try {
          const secret = decryptTOTP(emp.twoFactorSecret);
          if (!authenticator.verify({ token: String(totp), secret })) {
            auditReq('factura:anular_2fa_fail', _fakeReqForAudit(reqMeta, user), { facturaId: existing.id, total: Number(existing.total) });
            throw new CotError(401, 'TWOFA_INVALID', 'PIN 2FA inválido.');
          }
        } catch (err) {
          if (err instanceof CotError) throw err;
          throw new CotError(500, 'TWOFA_ERROR', 'Error validando 2FA.');
        }
        auditReq('factura:anular_2fa_ok', _fakeReqForAudit(reqMeta, user), { facturaId: existing.id, total: Number(existing.total) });
      }
    }

    const data = { estado, pdfUrl: null };
    if (estado === 'Pagada') data.fechaPago = new Date();
    const factura = await repo.updateFacturaEstado(id, data);

    pdfService?.invalidarPdfCache?.(factura.id).catch(() => {});
    auditReq('factura:estado', _fakeReqForAudit(reqMeta, user), { facturaId: factura.id, estado, ncf: factura.ncf });
    if (estado === 'Anulada') {
      auditReq('factura:anulada', _fakeReqForAudit(reqMeta, user), { facturaId: factura.id, ncf: factura.ncf, total: Number(existing.total) });
      await repo.crearAuditCaja({
        tipo:       'anulacion',
        empleadoId: user?.sub ?? null,
        facturaId:  factura.id,
        monto:      Number(existing.total),
        detalle:    `Anulación · NCF ${factura.ncf ?? '—'} · ${factura.noFactura}`,
        ip:         reqMeta?.ip,
        ua:         String(reqMeta?.ua ?? '').slice(0, 200),
      }).catch(() => {});
      // Mejora #5 — Owner God-Mode Alert. Anulación directa (no via NC) es
      // un evento crítico: la factura desaparece del Pagada pipeline sin
      // contrapartida documental DGII. Severidad alta.
      if (ownerAlerts) {
        ownerAlerts.tryEmit({
          tipo:         'factura.anulada',
          severity:     Number(existing.total) > 50000 ? 'critical' : 'warn',
          resourceType: 'factura',
          resourceId:   String(factura.id),
          payload: {
            facturaId:    factura.id,
            noFactura:    factura.noFactura,
            ncf:          factura.ncf,
            total:        Number(existing.total),
            estadoPrev:   existing.estado,
            via:          'cambio-estado-directo',
            requirio2FA:  Number(existing.total) > Number(process.env.UMBRAL_2FA_ANULACION ?? 50000),
          },
          user, reqMeta,
        });
      }
    }

    // Fire-and-forget MikroTik sync (Pagada → activo / Vencida → moroso).
    if ((estado === 'Pagada' || estado === 'Vencida') && factura.ordenId && typeof syncMikrotik === 'function') {
      setImmediate(async () => {
        try {
          const ot = await repo.findOTForMikrotik(factura.ordenId);
          const ip = ot?.tipoOT === 'ISP' ? ot.metadatos?.ip : null;
          if (ip) await syncMikrotik(ip, estado === 'Pagada' ? 'activo' : 'moroso');
        } catch (e) { console.error('[MIKROTIK FF]', e.message); }
      });
    }

    return { status: 200, body: factura };
  }

  // ─── Pipeline Kanban etapa ──────────────────────────────────────────────
  async function cambiarEtapaCotizacion(id, dto, user, reqMeta) {
    const { etapa } = dto;
    const permisos = Array.isArray(user?.permisos) ? user.permisos : [];
    const puedeGestionarTodas = permisos.includes('sistema:owner') || permisos.includes('venta:gestionar_todas');
    const factura = await repo.findCotizacionLight(id);
    if (!factura)              throw new CotError(404, 'NOT_FOUND',    'Cotización no encontrada.');
    if (!factura.esCotizacion) throw new CotError(400, 'NOT_COTIZACION','Solo cotizaciones tienen etapa pipeline.');
    if (!puedeGestionarTodas && factura.empleadoId && factura.empleadoId !== user.sub) {
      auditReq('cotizacion:etapa_denied', _fakeReqForAudit(reqMeta, user), { id: factura.id, owner: factura.empleadoId, etapaIntento: etapa });
      throw new CotError(403, 'NOT_OWNER', 'No puedes mover cotizaciones de otros vendedores.');
    }

    const f = await repo.updateCotizacionEtapa(id, etapa);
    let reservasLiberadas = 0;
    if (etapa === 'Perdida' || etapa === 'Aceptada' || etapa === 'Convertida') {
      const r = await repo.deleteReservasFactura(f.id);
      reservasLiberadas = r.count;
      if (reservasLiberadas > 0) {
        auditReq('cotizacion:reservas_liberadas', _fakeReqForAudit(reqMeta, user), { id: f.id, etapa, count: reservasLiberadas });
      }
    }
    auditReq('cotizacion:etapa', _fakeReqForAudit(reqMeta, user), { id: f.id, etapa, reservasLiberadas });

    // Mejora #4 — append-evento al hash-chain. Map etapa → accion canónica.
    if (cotEventoSvc) {
      const ETAPA_TO_ACCION = {
        'Enviada':     'enviar',
        'Aceptada':    'aceptar',
        'Perdida':     'perder',
        'Convertida':  'convertir',
        'Negociacion': 'editar',
        'Borrador':    'editar',
      };
      const accion = ETAPA_TO_ACCION[etapa] ?? 'editar';
      try {
        await cotEventoSvc.appendEvento({
          cotizacionId: f.id,
          accion,
          snapshot: cotEventoSvc.snapshotFromFactura(f),
          user,
          reqMeta,
        });
      } catch (e) {
        // No bloquea la operación de etapa — el hash-chain es para auditoría
        // post-hoc. Loggeamos y seguimos.
        console.error('[COT EVENTO chain]', e.message);
      }
    }
    return { status: 200, body: { ...f, reservasLiberadas } };
  }

  return {
    CotError,
    listarCotizaciones,
    revivirCotizacion,
    getFacturaById,
    listarFacturas,
    cambiarEstadoFactura,
    cambiarEtapaCotizacion,
  };
}

module.exports = createCotizacionesService;
module.exports.CotError = CotError;
