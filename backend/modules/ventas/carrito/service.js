/**
 * backend/modules/ventas/carrito/service.js
 *
 * Lógica del Carrito POS. procesarFacturaPOS + persistirVerifyHash +
 * formatCarrito vienen inyectados desde _lib.
 */

class CarritoError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code   = code;
  }
}

function createCarritoService(deps) {
  const { repo, auditReq, formatCarrito, persistirVerifyHash } = deps;
  // procesarFacturaPOS: opcional. Si null, /checkout devuelve 503 con código
  // accionable (idéntico patrón a modules/ventas/cotizaciones/service.js — el
  // procesador puede no estar inyectado en boots minimal/test).
  const procesarFacturaPOS = typeof deps.procesarFacturaPOS === 'function' ? deps.procesarFacturaPOS : null;
  if (!repo)                                          throw new Error('createCarritoService: repo required');
  if (typeof auditReq !== 'function')                 throw new Error('createCarritoService: auditReq required');
  if (typeof formatCarrito !== 'function')            throw new Error('createCarritoService: formatCarrito required');
  if (typeof persistirVerifyHash !== 'function')      throw new Error('createCarritoService: persistirVerifyHash required');

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

  async function obtenerCarrito(empleadoId) {
    let c = await repo.findCarritoByEmpleado(empleadoId);
    if (!c) c = await repo.createCarrito(empleadoId);
    return { status: 200, body: formatCarrito(c) };
  }

  async function actualizarCarrito(empleadoId, data) {
    const c = await repo.upsertCarrito(empleadoId, data);
    return { status: 200, body: formatCarrito(c) };
  }

  async function agregarItem(empleadoId, payload) {
    const { productoId, cantidad, precioOverride, descuentoPorcentaje, descuentoMonto } = payload;
    const producto = await repo.findProducto(productoId);
    if (!producto) throw new CarritoError(404, 'PRODUCTO_NOT_FOUND', 'Producto no encontrado.');
    const carrito = await repo.ensureCarrito(empleadoId);
    const existing = await repo.findLineaExistente(carrito.id, productoId);
    if (existing) {
      await repo.incrementarLinea(existing.id, cantidad, precioOverride, descuentoPorcentaje, descuentoMonto);
    } else {
      await repo.crearLinea(
        carrito.id, productoId, cantidad,
        precioOverride ?? Number(producto.precio),
        descuentoPorcentaje, descuentoMonto,
      );
    }
    const full = await repo.findCarritoByEmpleado(empleadoId);
    return { status: 201, body: formatCarrito(full) };
  }

  async function actualizarLinea(empleadoId, lineaId, data, user, reqMeta) {
    const linea = await repo.findLineaConCarrito(lineaId);
    if (!linea || linea.carrito.empleadoId !== empleadoId) {
      throw new CarritoError(404, 'LINEA_NOT_FOUND', 'Línea no encontrada.');
    }
    await repo.updateLinea(lineaId, data);
    if (data.precioUnitario !== undefined) {
      auditReq('pos:precio_override', _fakeReqForAudit(reqMeta, user), {
        lineaId,
        precioAnterior: Number(linea.precioUnitario),
        precioNuevo:    data.precioUnitario,
      });
    }
    const full = await repo.findCarritoByEmpleado(empleadoId);
    return { status: 200, body: formatCarrito(full) };
  }

  async function eliminarLinea(empleadoId, lineaId) {
    const linea = await repo.findLineaConCarrito(lineaId);
    if (!linea || linea.carrito.empleadoId !== empleadoId) {
      throw new CarritoError(404, 'LINEA_NOT_FOUND', 'Línea no encontrada.');
    }
    await repo.deleteLinea(lineaId);
    const full = await repo.findCarritoByEmpleado(empleadoId);
    return { status: 200, body: formatCarrito(full) };
  }

  async function vaciarCarrito(empleadoId) {
    const c = await repo.findCarritoBare(empleadoId);
    if (c) await repo.vaciarCarrito(c.id);
    return { status: 204, body: null };
  }

  async function checkout(empleadoId, payload, user, reqMeta) {
    const carrito = await repo.findCarritoConLineas(empleadoId);
    if (!carrito || carrito.lineas.length === 0) {
      throw new CarritoError(400, 'CARRITO_VACIO', 'Carrito vacío.');
    }
    if (!carrito.clienteId) {
      throw new CarritoError(400, 'CLIENTE_REQUERIDO', 'Selecciona un cliente de la base de datos antes de emitir.');
    }
    const lineas = carrito.lineas.map(l => ({
      productoId:          l.productoId,
      cantidad:            l.cantidad,
      precioUnitario:      Number(l.precioUnitario),
      descuentoPorcentaje: Number(l.descuentoPorcentaje),
      descuentoMonto:      Number(l.descuentoMonto),
    }));
    if (!procesarFacturaPOS) {
      throw new CarritoError(503, 'PROCESADOR_POS_NO_DISPONIBLE', 'procesarFacturaPOS no inyectado en deps.');
    }
    const permisos = Array.isArray(user?.permisos) ? user.permisos : [];
    const puedeOverride = permisos.includes('sistema:owner') || permisos.includes('pos:override_precio');
    try {
      const factura = await procesarFacturaPOS({
        inputClienteId:      carrito.clienteId,
        applyItbis:          carrito.applyItbis,
        diasVence:           carrito.diasVence,
        esCotizacion:        payload.esCotizacion,
        lineas,
        tipoNcfOverride:     payload.tipoNcfOverride,
        descuentoGlobalPct:  payload.descuentoGlobalPct,
        descuentoGlobalMonto: payload.descuentoGlobalMonto,
        puedeOverridePrecio: puedeOverride,
        empleadoId,
        condicionesOverride: payload.condicionesOverride,
        notasOverride:       payload.notasOverride,
      });
      await persistirVerifyHash(factura);
      await repo.vaciarCarrito(carrito.id);
      const reqStub = _fakeReqForAudit(reqMeta, user);
      auditReq(payload.esCotizacion ? 'carrito:cotizacion' : 'carrito:checkout', reqStub, {
        facturaId: factura.id, ncf: factura.ncf, total: Number(factura.total),
      });
      if (payload.descuentoGlobalPct > 0 || payload.descuentoGlobalMonto > 0) {
        auditReq('pos:descuento_global', reqStub, {
          facturaId: factura.id, noFactura: factura.noFactura,
          descuentoGlobalPct: payload.descuentoGlobalPct,
          descuentoGlobalMonto: payload.descuentoGlobalMonto,
          totalFinal: Number(factura.total),
        });
      }
      return { status: 201, body: factura };
    } catch (e) {
      if (e.status) throw new CarritoError(e.status, e.code ?? 'CHECKOUT_ERR', e.message);
      throw e;
    }
  }

  return {
    CarritoError,
    obtenerCarrito,
    actualizarCarrito,
    agregarItem,
    actualizarLinea,
    eliminarLinea,
    vaciarCarrito,
    checkout,
  };
}

module.exports = createCarritoService;
module.exports.CarritoError = CarritoError;
