/**
 * backend/modules/ventas/pos/service.js
 *
 * Lógica de negocio del módulo POS. NO conoce req/res. Recibe DTOs planos
 * (validados por controller) + reqMeta (ip/ua para audit) + user.
 *
 * Owns:
 *   - verifyPin: timing-safe equal + audit trail.
 *   - totalLinea/efectivoUnitario: cálculo monetario sequential discounts.
 *   - expandirLineaAComponentes: BOM expansion (bundle/producto/linked).
 *   - procesarVentaPOS: flow completo del POST /pos/venta (gates, transaction,
 *     snapshot, NCF, stock post-commit, reservas para cotización).
 *   - procesarFacturaManual: factura manual desde lineas[productoId] con
 *     stock atómico DENTRO de la transacción (no post-commit).
 *
 * Factory: createPosService({ repo, auditReq, generarSiguienteCodigo,
 *   persistirVerifyHash, crypto })
 *
 * CRÍTICO — Cyber Neo:
 * - PIN compare: crypto.timingSafeEqual sobre buffers padeados a 16 bytes.
 *   Misma longitud constante para todos los inputs → timing attack imposible.
 * - Stock deduction: vía repo.deducirStockAtomico (UPDATE ... RETURNING).
 * - Descuento PIN gate: opera sobre descEfectivoPct = max(globalPct, montoComoPct).
 *   PIN solo se valida AL EMITIR — la pre-validación /verificar-pin no
 *   reemplaza esta segunda barrera (defense in depth).
 */

const crypto = require('crypto');

class PosError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code   = code;
    if (extra) this.extra = extra;
  }
}

// ─── Cálculos monetarios (puros) ──────────────────────────────────────────
function efectivoUnitario(pu, pct, monto) {
  const afterPct = pu * (1 - pct / 100);
  return Math.round(Math.max(0, afterPct - monto) * 100) / 100;
}

function totalLinea(pu, pct, monto, cant) {
  return Math.round(efectivoUnitario(pu, pct, monto) * cant * 100) / 100;
}

function createPosService(deps) {
  const { repo, auditReq, generarSiguienteCodigo, persistirVerifyHash } = deps;
  if (!repo)                                          throw new Error('createPosService: repo required');
  if (typeof auditReq !== 'function')                 throw new Error('createPosService: auditReq required');
  if (typeof generarSiguienteCodigo !== 'function')   throw new Error('createPosService: generarSiguienteCodigo required');
  if (typeof persistirVerifyHash !== 'function')      throw new Error('createPosService: persistirVerifyHash required');

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

  // ─── /pos/verificar-pin ──────────────────────────────────────────────────
  /**
   * Compara el PIN del cajero contra el PIN configurado en EmpresaPerfil
   * usando timingSafeEqual. Padding a 16 bytes garantiza longitud constante
   * — el atacante no puede inferir el largo del PIN real.
   */
  async function verifyPin({ pin }, reqMeta, user) {
    const empCfg = await repo.findEmpresaPinOnly();
    const pinReal = empCfg?.pinSupervisor ?? '1234';
    const a = Buffer.from(pin.padEnd(16, '\0'));
    const b = Buffer.from(String(pinReal).padEnd(16, '\0'));
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) {
      auditReq('pos:pin_invalid', _fakeReqForAudit(reqMeta, user));
      throw new PosError(401, 'PIN_INVALID', 'PIN inválido.', { valid: false });
    }
    auditReq('pos:pin_ok', _fakeReqForAudit(reqMeta, user));
    return { status: 200, body: { valid: true } };
  }

  // ─── BOM expansion ───────────────────────────────────────────────────────
  /**
   * Expande una línea a su lista de {productoId, cantidad} físicos.
   *   - productoId directo → [{ productoId, cantidad }]
   *   - itemCatalogo bundle → N entries (componente × line.qty)
   *   - itemCatalogo simple vinculado a Producto físico → 1 entry
   *   - servicio puro → []
   * Acepta tx para correr dentro de transacción.
   */
  async function expandirLineaAComponentes(linea, tx) {
    if (!linea || typeof linea !== 'object') return [];
    const cantidad = Number(linea.cantidad);
    if (!Number.isFinite(cantidad) || cantidad <= 0) return [];
    if (linea.productoId) {
      return [{ productoId: linea.productoId, cantidad, source: 'direct' }];
    }
    if (linea.itemCatalogoId) {
      let it;
      try {
        it = await repo.findItemCatalogoFullForExpansion(linea.itemCatalogoId, tx);
      } catch (e) {
        console.warn(`[expandirLineaAComponentes] lookup falló id=${linea.itemCatalogoId}:`, e.message);
        return [];
      }
      if (!it) return [];
      if (it.esBundle && Array.isArray(it.componentes) && it.componentes.length > 0) {
        return it.componentes
          .filter(c => c?.producto && c.producto.tipoItem !== 'SERVICIO' && Number(c.cantidad) > 0)
          .map(c => ({
            productoId:   c.productoId,
            cantidad:     Number(c.cantidad) * cantidad,
            nombre:       c.producto.nombre ?? 'Componente',
            source:       'bundle',
            bundleItemId: it.id,
          }));
      }
      if (it.productoId && it.producto?.tipoItem !== 'SERVICIO') {
        return [{
          productoId: it.productoId,
          cantidad,
          nombre:     it.producto?.nombre ?? it.nombre ?? 'Producto',
          source:     'linked',
        }];
      }
    }
    return [];
  }

  // ─── /pos/venta ──────────────────────────────────────────────────────────
  /**
   * Composición de descripción para snapshot fiel al PDF. Si el ItemCatalogo
   * trae descripcion estructurada {v:1,...} la pasa íntegra (renderer la
   * reconoce). Si es string legacy, prepende título en bold markdown.
   */
  function _composeDesc(titulo, descripcion) {
    const desc = (descripcion ?? '').trim();
    if (!desc) return titulo;
    if (desc.length > 1 && desc[0] === '{') {
      try {
        const obj = JSON.parse(desc);
        if (obj && obj.v === 1) {
          if (!obj.titulo || !obj.titulo.trim()) obj.titulo = titulo;
          return JSON.stringify(obj);
        }
      } catch { /* fall through */ }
    }
    return `**${titulo}**\n${desc}`;
  }

  /**
   * Pre-flight: chequea stock disponible vs cantidad requerida (post
   * expansión de bundles). Si insuficiente, lanza STOCK_INSUFICIENTE.
   * Solo aplica a facturas reales (cotizaciones reservan, no consumen).
   */
  async function _gateStockPreFlight({ lineas, esCotizacion, _prodGate, _itemFullMap }) {
    if (esCotizacion) return;
    const _stockMapDirect = Object.fromEntries(_prodGate.map(p => [p.id, p]));
    const requeridos    = {};
    const nombresPorPid = {};
    for (const l of lineas) {
      if (l.productoId) {
        const p = _stockMapDirect[l.productoId];
        if (!p || p.tipoItem === 'SERVICIO') continue;
        requeridos[p.id]    = (requeridos[p.id] ?? 0) + l.cantidad;
        nombresPorPid[p.id] = p.nombre;
      } else if (l.itemCatalogoId) {
        const it = _itemFullMap[l.itemCatalogoId];
        if (!it) continue;
        if (it.esBundle && Array.isArray(it.componentes) && it.componentes.length > 0) {
          for (const c of it.componentes) {
            if (!c.producto || c.producto.tipoItem === 'SERVICIO') continue;
            const cantTotal = c.cantidad * l.cantidad;
            requeridos[c.productoId]    = (requeridos[c.productoId] ?? 0) + cantTotal;
            nombresPorPid[c.productoId] = c.producto.nombre;
          }
        } else if (it.productoId && it.producto?.tipoItem !== 'SERVICIO') {
          requeridos[it.productoId]    = (requeridos[it.productoId] ?? 0) + l.cantidad;
          nombresPorPid[it.productoId] = it.producto?.nombre ?? it.nombre;
        }
      }
    }
    const pidsRequeridos = Object.keys(requeridos).map(Number);
    if (pidsRequeridos.length === 0) return;
    const stockActuales = await repo.findStockActualForProductos(pidsRequeridos);
    for (const p of stockActuales) {
      const req = requeridos[p.id];
      if (Number(p.stockActual) < req) {
        throw new PosError(422, 'STOCK_INSUFICIENTE',
          `Stock insuficiente para "${p.nombre}". Disponible: ${p.stockActual}, requerido: ${req} (incluye expansión de bundles).`,
          { productoId: p.id });
      }
    }
  }

  /**
   * PIN supervisor gate. Compara descuento efectivo (max entre % global y
   * monto-como-pct) contra maxDescuentoCajero. Si excede y el cajero no es
   * owner, exige PIN supervisor. Audita ambos resultados.
   */
  async function _gatePinSupervisor({ descuentoGlobalPct, descuentoGlobalMonto, lineas,
                                     _pMapGate, _iMapGate, puedeOverridePrecio, isOwner,
                                     pinSupervisor, esCotizacion, reqMeta, user }) {
    const empCfg = await repo.findEmpresaPosConfig();
    const maxDescuentoCajero = Number(empCfg?.maxDescuentoCajero ?? 15);

    let _subtotalBrutoGate = 0;
    for (const l of lineas) {
      const precioBase = l.productoId
        ? (puedeOverridePrecio && l.precioUnitario != null ? Number(l.precioUnitario) : (_pMapGate[l.productoId] ?? 0))
        : (puedeOverridePrecio && l.precioUnitario != null ? Number(l.precioUnitario) : (_iMapGate[l.itemCatalogoId] ?? 0));
      _subtotalBrutoGate += totalLinea(precioBase, l.descuentoPorcentaje ?? 0, l.descuentoMonto ?? 0, l.cantidad);
    }
    const _descMontoEfectivo = _subtotalBrutoGate > 0 ? Math.min(descuentoGlobalMonto, _subtotalBrutoGate) : 0;
    const _descMontoComoPct  = _subtotalBrutoGate > 0 ? (_descMontoEfectivo / _subtotalBrutoGate) * 100 : 0;
    const descEfectivoPct    = Math.max(descuentoGlobalPct, _descMontoComoPct);

    if (isOwner || esCotizacion || descEfectivoPct <= maxDescuentoCajero) return;

    const pinReal = empCfg?.pinSupervisor ?? '1234';
    if (!pinSupervisor || pinSupervisor !== pinReal) {
      auditReq('pos:descuento_pin_fail', _fakeReqForAudit(reqMeta, user), {
        descuentoPctEfectivo: descEfectivoPct.toFixed(2), max: maxDescuentoCajero,
      });
      await repo.crearAuditCaja({
        tipo:       'descuento_rechazado',
        empleadoId: user?.sub ?? null,
        descPct:    Math.round(descEfectivoPct * 100) / 100,
        detalle:    `Cajero intentó descuento efectivo ${descEfectivoPct.toFixed(2)}% (límite ${maxDescuentoCajero}%) sin PIN válido`,
        ip:         reqMeta?.ip,
        ua:         String(reqMeta?.ua ?? '').slice(0, 200),
      }).catch(() => {});
      throw new PosError(403, 'PIN_REQUIRED',
        `Descuento efectivo ${descEfectivoPct.toFixed(2)}% excede ${maxDescuentoCajero}%. Requiere PIN de supervisor.`);
    }
    auditReq('pos:descuento_pin_ok', _fakeReqForAudit(reqMeta, user), {
      descuentoPctEfectivo: descEfectivoPct.toFixed(2), max: maxDescuentoCajero,
    });
    await repo.crearAuditCaja({
      tipo:       'descuento_pin',
      empleadoId: user?.sub ?? null,
      descPct:    Math.round(descEfectivoPct * 100) / 100,
      detalle:    `PIN supervisor validó descuento efectivo ${descEfectivoPct.toFixed(2)}% (límite ${maxDescuentoCajero}%)`,
      ip:         reqMeta?.ip,
      ua:         String(reqMeta?.ua ?? '').slice(0, 200),
    }).catch(() => {});
  }

  /** Flow completo POST /pos/venta. */
  async function procesarVentaPOS(dto, user, reqMeta, deps) {
    const { prisma } = deps;
    const permisos    = Array.isArray(user?.permisos) ? user.permisos : [];
    const permReq     = dto.esCotizacion ? 'pos:cotizar' : 'pos:facturar';
    if (!permisos.includes('sistema:owner') && !permisos.includes(permReq)) {
      throw new PosError(403, 'PERM_DENIED', `Se requiere permiso "${permReq}".`);
    }
    const puedeOverridePrecio = permisos.includes('sistema:owner') || permisos.includes('pos:override_precio');
    const isOwner             = permisos.includes('sistema:owner');

    const _pidsForGate = [...new Set(dto.lineas.filter(l => l.productoId).map(l => l.productoId))];
    const _iidsForGate = [...new Set(dto.lineas.filter(l => l.itemCatalogoId).map(l => l.itemCatalogoId))];
    const [_prodGate, _itemGate] = await Promise.all([
      repo.findProductosForGate(_pidsForGate),
      repo.findItemCatalogosForGate(_iidsForGate),
    ]);
    const _pMapGate    = Object.fromEntries(_prodGate.map(p => [p.id, Number(p.precio)]));
    const _iMapGate    = Object.fromEntries(_itemGate.map(i => [i.id, Number(i.precio)]));
    const _itemFullMap = Object.fromEntries(_itemGate.map(i => [i.id, i]));

    await _gateStockPreFlight({ lineas: dto.lineas, esCotizacion: dto.esCotizacion, _prodGate, _itemFullMap });

    await _gatePinSupervisor({
      descuentoGlobalPct:   dto.descuentoGlobalPct,
      descuentoGlobalMonto: dto.descuentoGlobalMonto,
      lineas:               dto.lineas,
      _pMapGate, _iMapGate, puedeOverridePrecio, isOwner,
      pinSupervisor: dto.pinSupervisor,
      esCotizacion:  dto.esCotizacion,
      reqMeta, user,
    });

    const factura = await prisma.$transaction(async (tx) => {
      const cliente = await repo.findClienteByIdTx(tx, dto.clienteId);
      if (!cliente) throw new PosError(404, 'CLIENTE_NOT_FOUND', 'Cliente no encontrado en la base de datos.');

      const itemIds = [...new Set(dto.lineas.filter(l => l.itemCatalogoId).map(l => l.itemCatalogoId))];
      const prodIds = [...new Set(dto.lineas.filter(l => l.productoId).map(l => l.productoId))];
      const [items, prods] = await Promise.all([
        repo.findItemCatalogosForCreateTx(tx, itemIds),
        repo.findProductosForCreateTx(tx, prodIds),
      ]);
      const iMap = Object.fromEntries(items.map(i => [i.id, i]));
      const pMap = Object.fromEntries(prods.map(p => [p.id, p]));
      for (const l of dto.lineas) {
        if (l.itemCatalogoId && !iMap[l.itemCatalogoId]) throw new PosError(404, 'ITEM_NOT_FOUND', `Item catálogo ${l.itemCatalogoId} no encontrado.`);
        if (l.productoId     && !pMap[l.productoId])     throw new PosError(404, 'PROD_NOT_FOUND', `Producto ${l.productoId} no encontrado.`);
      }

      const lineasEnriquecidas = dto.lineas.map(l => {
        if (l.productoId) {
          const p = pMap[l.productoId];
          const pu = (puedeOverridePrecio && l.precioUnitario != null) ? Number(l.precioUnitario) : Number(p.precio);
          return {
            descripcion: _composeDesc(p.nombre, p.descripcion),
            cantidad: l.cantidad, precioUnitario: pu,
            productoId:  p.id,
            descuentoPorcentaje: l.descuentoPorcentaje ?? 0,
            descuentoMonto:      l.descuentoMonto ?? 0,
            _isProducto: true,
          };
        }
        const item = iMap[l.itemCatalogoId];
        const pu = (puedeOverridePrecio && l.precioUnitario != null) ? Number(l.precioUnitario) : Number(item.precio);
        return {
          descripcion: _composeDesc(item.nombre, item.descripcion),
          cantidad: l.cantidad, precioUnitario: pu,
          productoId:  item.productoId ?? null,
          descuentoPorcentaje: l.descuentoPorcentaje ?? 0,
          descuentoMonto:      l.descuentoMonto ?? 0,
        };
      });
      const subtotalBruto = Math.round(lineasEnriquecidas.reduce((s, l) => s + totalLinea(l.precioUnitario, l.descuentoPorcentaje, l.descuentoMonto, l.cantidad), 0) * 100) / 100;
      const globalDesc    = dto.descuentoGlobalPct > 0
        ? Math.round(subtotalBruto * (dto.descuentoGlobalPct / 100) * 100) / 100
        : Math.min(dto.descuentoGlobalMonto, subtotalBruto);
      const subtotal = Math.round((subtotalBruto - globalDesc) * 100) / 100;
      const itbisAmt = dto.applyItbis ? Math.round(subtotal * 0.18 * 100) / 100 : 0;
      const total    = Math.round((subtotal + itbisAmt) * 100) / 100;

      let ncf = null, noFactura, tipoNcf = 'Consumidor Final', estado;
      if (dto.esCotizacion) {
        noFactura = await generarSiguienteCodigo('cotizacion', tx);
        estado    = 'Borrador';
      } else {
        tipoNcf = dto.tipoNcf || (['PYME', 'Empresa'].includes(cliente.tipoEmpresa) ? 'Fiscal' : 'Consumidor Final');
        const row = await repo.nextNcfSeqTx(tx, tipoNcf);
        if (!row) throw new PosError(422, 'NCF_DEPLETED', `Sin secuencia NCF para "${tipoNcf}". Verifica Config NCF.`);
        ncf       = `${row.prefijo}${String(row.secuenciaActual).padStart(8, '0')}`;
        noFactura = await generarSiguienteCodigo('factura', tx);
        estado    = 'Emitida';
      }

      // Validación cobro mixto: suma de pagos === total (±0.01).
      let pagosValidados = null;
      if (!dto.esCotizacion && Array.isArray(dto.pagos) && dto.pagos.length > 0) {
        const suma = dto.pagos.reduce((s, p) => s + Number(p.monto), 0);
        if (Math.abs(suma - total) > 0.01) {
          throw new PosError(400, 'PAGOS_MISMATCH',
            `Suma de pagos (RD$ ${suma.toFixed(2)}) no coincide con total (RD$ ${total.toFixed(2)}).`);
        }
        pagosValidados = dto.pagos.map(p => ({ metodo: p.metodo, monto: Number(p.monto), refer: p.refer ?? null }));
      }

      const notasFinales = (dto.notasOverride !== undefined)
        ? (dto.notasOverride === '' ? null : dto.notasOverride)
        : (dto.esCotizacion
            ? `Cotización POS (catálogo) — ${dto.lineas.length} línea(s)`
            : `Factura POS (catálogo) — ${dto.lineas.length} línea(s)`);

      return repo.crearFacturaPos(tx, {
        noFactura, clienteId: cliente.id, estado, subtotal, itbis: itbisAmt, total,
        ncf, tipoNcf, esCotizacion: dto.esCotizacion,
        empleadoId:  user?.sub ?? null,
        pagos:       pagosValidados,
        notas:       notasFinales,
        condiciones: dto.condicionesOverride ?? {},
        fechaVence:  dto.diasVence > 0 ? new Date(Date.now() + dto.diasVence * 86_400_000) : null,
        lineas:      { createMany: { data: lineasEnriquecidas.map(({ _isProducto, ...rest }) => rest) } },
      });
    });

    await persistirVerifyHash(factura);
    auditReq(dto.esCotizacion ? 'cotizacion:crear' : 'factura:pos_catalogo', _fakeReqForAudit(reqMeta, user), {
      facturaId: factura.id, total: Number(factura.total),
    });

    // Post-commit: reservas (cotización) o stock deduction (factura real).
    if (dto.esCotizacion) {
      try {
        const catIds = [...new Set(dto.lineas.filter(l => l.itemCatalogoId).map(l => l.itemCatalogoId))];
        const linkMap = await repo.findItemCatalogoLinkMap(catIds);
        const exp = new Date(Date.now() + 72 * 3600_000);
        const reservas = dto.lineas
          .map(l => ({
            productoId: l.productoId ?? linkMap[l.itemCatalogoId] ?? null,
            cantidad:   l.cantidad,
          }))
          .filter(r => r.productoId)
          .map(r => ({
            productoId: r.productoId, cantidad: r.cantidad,
            facturaId:  factura.id, expiraEn: exp,
            motivo:     `Cotización ${factura.noFactura}`,
          }));
        await repo.crearReservasInventario(reservas);
      } catch (e) { console.error('[RESERVA]', e.message); }
    } else {
      try {
        const aDescontar = {};
        for (const l of dto.lineas) {
          const comps = await expandirLineaAComponentes(l);
          for (const c of comps) {
            aDescontar[c.productoId] = (aDescontar[c.productoId] ?? 0) + c.cantidad;
          }
        }
        for (const [pidStr, cant] of Object.entries(aDescontar)) {
          const pid = Number(pidStr);
          const row = await repo.deducirStockAtomico(pid, cant);
          if (!row) {
            console.error(`[POS] STOCK DRIFT producto ${pid} - venta facturada SIN deducción. Factura ${factura.noFactura}`);
            await repo.crearAuditCaja({
              tipo:       'stock_drift',
              empleadoId: user?.sub ?? null,
              facturaId:  factura.id,
              detalle:    `Stock drift productoId=${pid} cantidad=${cant} (post-bundle expansion) — investigar reconciliación.`,
              ip:         reqMeta?.ip,
              ua:         String(reqMeta?.ua ?? '').slice(0, 200),
            }).catch(() => {});
            continue;
          }
          await repo.crearKardexSalida(pid, cant);
        }
      } catch (e) { console.error('[POS STOCK]', e.message); }
    }

    if (!dto.esCotizacion) {
      try {
        await repo.crearAuditCaja({
          tipo:       'venta',
          empleadoId: user?.sub ?? null,
          facturaId:  factura.id,
          monto:      Number(factura.total),
          descPct:    dto.descuentoGlobalPct || null,
          detalle:    `${factura.noFactura} · NCF ${factura.ncf ?? '—'} · ${dto.lineas.length} líneas`,
          ip:         reqMeta?.ip,
          ua:         String(reqMeta?.ua ?? '').slice(0, 200),
        });
      } catch (e) { console.error('[AUDIT CAJA]', e.message); }
    }

    return { status: 201, body: factura };
  }

  // ─── /facturas/manual ────────────────────────────────────────────────────
  async function procesarFacturaManual(dto, user, reqMeta, deps) {
    const { prisma } = deps;
    const permisos = Array.isArray(user?.permisos) ? user.permisos : [];
    const puedeOverridePrecio = permisos.includes('sistema:owner') || permisos.includes('pos:override_precio');

    if (!dto.clienteId) {
      throw new PosError(400, 'CLIENTE_REQUIRED', 'clienteId es obligatorio — vincula el documento a un cliente real.');
    }

    const factura = await prisma.$transaction(async (tx) => {
      const cliente = await repo.findClienteByIdTx(tx, dto.clienteId);
      if (!cliente) throw new PosError(404, 'CLIENTE_NOT_FOUND', 'Cliente no encontrado en la base de datos.');

      const productoIds = [...new Set(dto.lineas.map(l => l.productoId).filter(Boolean))];
      const productos = await repo.findProductosForManualTx(tx, productoIds);
      const pMap = Object.fromEntries(productos.map(p => [p.id, p]));
      for (const l of dto.lineas) {
        if (l.productoId && !pMap[l.productoId]) throw new PosError(404, 'PROD_NOT_FOUND', `Producto ID ${l.productoId} no encontrado.`);
        if (!l.productoId && !l.descripcion)     throw new PosError(400, 'LINEA_INCOMPLETA', 'Línea sin productoId requiere campo descripción.');
      }

      const lineasEnriquecidas = dto.lineas.map(l => {
        if (l.productoId) {
          const p = pMap[l.productoId];
          const pu = (puedeOverridePrecio && l.precioUnitario != null) ? Number(l.precioUnitario) : Number(p.precio);
          return {
            productoId: l.productoId,
            descripcion: l.descripcion ?? p.nombre,
            cantidad: l.cantidad,
            precioUnitario: pu,
            descuentoPorcentaje: l.descuentoPorcentaje ?? 0,
            descuentoMonto:      l.descuentoMonto ?? 0,
            _tipoItem: p.tipoItem,
          };
        }
        const pu = l.precioUnitario ?? 0;
        return {
          productoId: null,
          descripcion: l.descripcion,
          cantidad: l.cantidad,
          precioUnitario: pu,
          descuentoPorcentaje: l.descuentoPorcentaje ?? 0,
          descuentoMonto:      l.descuentoMonto ?? 0,
          _tipoItem: 'SERVICIO',
        };
      });

      const subtotalBruto = Math.round(lineasEnriquecidas.reduce((s, l) => s + totalLinea(l.precioUnitario, l.descuentoPorcentaje, l.descuentoMonto, l.cantidad), 0) * 100) / 100;
      const subtotal     = subtotalBruto;
      const itbisAmt     = dto.itbis ? Math.round(subtotal * 0.18 * 100) / 100 : 0;
      const total        = Math.round((subtotal + itbisAmt) * 100) / 100;

      let ncf = null, noFactura, tipoNcf = 'Consumidor Final', estado;
      if (dto.esCotizacion) {
        noFactura = await generarSiguienteCodigo('cotizacion', tx);
        estado    = 'Borrador';
      } else {
        tipoNcf = (['PYME', 'Empresa'].includes(cliente.tipoEmpresa) ? 'Fiscal' : 'Consumidor Final');
        const row = await repo.nextNcfSeqTx(tx, tipoNcf);
        if (!row) throw new PosError(422, 'NCF_DEPLETED', `Sin secuencia NCF disponible para "${tipoNcf}". Verifica Configuración NCF.`);
        ncf       = `${row.prefijo}${String(row.secuenciaActual).padStart(8, '0')}`;
        noFactura = await generarSiguienteCodigo('factura', tx);
        estado    = 'Emitida';
      }

      // Snapshot fiscal: solo facturas reales.
      let snapshot = null;
      if (!dto.esCotizacion) {
        const empresa = await repo.findEmpresaPerfilFull(tx);
        snapshot = {
          emitidoEn: new Date().toISOString(),
          empresa: empresa ? {
            razonSocial:           empresa.razonSocial,
            nombreComercial:       empresa.nombreComercial,
            rnc:                   empresa.rnc,
            registroMercantil:     empresa.registroMercantil,
            direccion:             empresa.direccion,
            sector:                empresa.sector,
            provincia:             empresa.provincia,
            telefono:              empresa.telefono,
            email:                 empresa.email,
            website:               empresa.website,
            eslogan:               empresa.eslogan,
            representanteNombre:   empresa.representanteNombre,
            representanteApellido: empresa.representanteApellido,
            representanteCargo:    empresa.representanteCargo,
            assets:                empresa.assets ?? {},
            condicionesDefault:    empresa.condicionesDefault ?? {},
          } : null,
          cliente: {
            razonSocial: cliente.razonSocial,
            noCliente:   cliente.noCliente,
            rnc:         cliente.rnc,
            cedula:      cliente.cedula,
            direccion:   cliente.direccion,
            sector:      cliente.sector,
            provincia:   cliente.provincia,
            telefono:    cliente.telefonoPrincipal ?? cliente.telefono,
            email:       cliente.email,
            tipoEmpresa: cliente.tipoEmpresa,
          },
        };
      }

      const lineaData = lineasEnriquecidas.map(({ _tipoItem, ...rest }) => rest);
      const notasFinales = dto.esCotizacion
        ? `Cotización POS — ${dto.lineas.length} línea(s)`
        : `Factura manual POS — ${dto.lineas.length} línea(s)`;

      const f = await repo.crearFacturaManual(tx, {
        noFactura, clienteId: cliente.id, estado, subtotal, itbis: itbisAmt, total,
        ncf, tipoNcf, esCotizacion: dto.esCotizacion,
        empleadoId:  user?.sub ?? null,
        snapshot,
        notas:       notasFinales,
        condiciones: {},
        fechaVence:  dto.diasVence > 0 ? new Date(Date.now() + dto.diasVence * 86_400_000) : null,
        lineas:      { createMany: { data: lineaData } },
      });

      // Atomic stock deduction DENTRO de la transacción (anti TOCTOU).
      if (!dto.esCotizacion) {
        const cantPorArticulo = {};
        for (const l of lineasEnriquecidas) {
          if (l._tipoItem !== 'SERVICIO')
            cantPorArticulo[l.productoId] = (cantPorArticulo[l.productoId] || 0) + l.cantidad;
        }
        for (const [pid, cant] of Object.entries(cantPorArticulo)) {
          const row = await repo.deducirStockAtomico(Number(pid), cant, tx);
          if (!row) {
            const p = pMap[Number(pid)];
            throw new PosError(400, 'STOCK_INSUFICIENTE',
              `Stock insuficiente para "${p.nombre}". Disponible: ${p.stockActual}, requerido: ${cant}.`);
          }
          await repo.crearKardexSalida(Number(pid), cant, tx);
        }
      }
      return f;
    });

    await persistirVerifyHash(factura);
    auditReq(dto.esCotizacion ? 'cotizacion:crear' : 'factura:manual', _fakeReqForAudit(reqMeta, user), {
      facturaId: factura.id, ncf: factura.ncf, total: Number(factura.total), lineas: factura.lineas.length,
    });

    return { status: 201, body: factura };
  }

  return {
    PosError,
    totalLinea,
    efectivoUnitario,
    expandirLineaAComponentes,
    verifyPin,
    procesarVentaPOS,
    procesarFacturaManual,
  };
}

module.exports = createPosService;
module.exports.PosError = PosError;
module.exports.totalLinea = totalLinea;
module.exports.efectivoUnitario = efectivoUnitario;
