/**
 * backend/modules/servicios/ordenes/service.js
 *
 * Lógica pura del flujo de Órdenes de Servicio Técnico:
 *   Recibido en Taller → En Diagnóstico → Presupuestado → En Reparación
 *   → Listo para Entrega → Entregado/Facturado
 *
 * Foco exclusivo: soporte técnico físico (CCTV, NVR/DVR, impresoras,
 * servidores, PC/laptop, switches, cercos eléctricos). NO contratos ISP.
 *
 * Integración financiera: al facturar la orden, delega a procesarVentaPOS
 * para emitir la factura con NCF canónico (B01/B02) derivado del
 * tipoEmpresa del cliente. La orden marca estaFacturada + completadaEn y
 * transiciona a "Entregado/Facturado" en la misma transacción.
 *
 * PDF: genera el conduce/recibo técnico de recepción usando
 * services/pdf-generator (puppeteer). HTML inline corporativo.
 */

const crypto = require('crypto');
const { generarPdfDocumento } = require('../../../services/pdf-generator');

const {
  ESTADOS_OT_SERVICIO,
  ESTADO_INICIAL,
  ESTADO_TERMINAL,
  TRANSICIONES_VALIDAS,
} = require('./schema');

class OrdenServicioError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code   = code;
  }
}

function _generarNoOT() {
  const ts  = Date.now().toString(36).toUpperCase();
  const rnd = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `OST-${ts}-${rnd}`;
}

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

function _esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _fmtFecha(d) {
  if (!d) return '';
  try {
    return new Date(d).toLocaleString('es-DO', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return ''; }
}

function _serialize(row) {
  if (!row) return null;
  const meta = row.metadatos || {};
  return {
    id:                 row.id,
    noOT:               row.noOT,
    clienteId:          row.clienteId,
    cliente:            row.cliente || null,
    tecnicoId:          row.tecnicoId,
    tecnico:            row.tecnico || null,
    estado:             row.estado,
    tipoEquipo:         meta.tipoEquipo ?? null,
    marca:              meta.marca ?? null,
    modelo:             meta.modelo ?? null,
    serial:             meta.serial ?? null,
    diagnosticoInicial: meta.diagnosticoInicial ?? null,
    reporteTecnicoFinal: meta.reporteTecnicoFinal ?? null,
    piezasUtilizadas:   Array.isArray(meta.piezasUtilizadas) ? meta.piezasUtilizadas : [],
    presupuestoMonto:   meta.presupuestoMonto ?? null,
    notas:              row.notasTecnicas ?? null,
    estaFacturada:      row.estaFacturada,
    completadaEn:       row.completadaEn,
    facturas:           Array.isArray(row.facturas) ? row.facturas : [],
    createdAt:          row.createdAt,
    updatedAt:          row.updatedAt,
  };
}

function createServiciosOrdenesService(deps) {
  const { repo, auditReq, procesarVentaPOS } = deps;
  if (!repo)                          throw new Error('createServiciosOrdenesService: repo required');
  if (typeof auditReq !== 'function') throw new Error('createServiciosOrdenesService: auditReq required');

  async function listar(query) {
    const { total, rows } = await repo.listar(query);
    return {
      total,
      limit:  query.limit,
      offset: query.offset,
      items:  rows.map(_serialize),
    };
  }

  async function obtener(id) {
    const row = await repo.obtenerPorId(id);
    if (!row) throw new OrdenServicioError(404, 'NOT_FOUND', 'Orden de servicio técnico no encontrada.');
    return _serialize(row);
  }

  async function crear(dto, user, reqMeta) {
    const cliente = await repo.findClienteById(dto.clienteId);
    if (!cliente || cliente.deletedAt) {
      throw new OrdenServicioError(404, 'CLIENTE_NOT_FOUND', 'Cliente no existe o fue eliminado.');
    }

    const noOT = _generarNoOT();
    const metadatos = {
      tipoEquipo:          dto.tipoEquipo,
      marca:               dto.marca ?? null,
      modelo:              dto.modelo ?? null,
      serial:              dto.serial ?? null,
      diagnosticoInicial:  dto.diagnosticoInicial,
      reporteTecnicoFinal: null,
      piezasUtilizadas:    [],
      presupuestoMonto:    null,
    };

    const creada = await repo.crear({
      noOT,
      clienteId:     dto.clienteId,
      tecnicoId:     dto.tecnicoId ?? null,
      estado:        ESTADO_INICIAL,
      notasTecnicas: dto.notas ?? null,
      metadatos,
    });

    await auditReq(_fakeReqForAudit(reqMeta, user), {
      accion:   'CREATE',
      tabla:    'OrdenTrabajo',
      registroId: creada.id,
      detalles: { tipoOT: repo.TIPO_OT, noOT, tipoEquipo: dto.tipoEquipo, clienteId: dto.clienteId },
    });

    return _serialize(creada);
  }

  async function actualizar(id, dto, user, reqMeta) {
    const row = await repo.obtenerPorId(id);
    if (!row) throw new OrdenServicioError(404, 'NOT_FOUND', 'Orden no encontrada.');
    if (row.estado === ESTADO_TERMINAL) {
      throw new OrdenServicioError(423, 'ORDEN_TERMINAL', 'Orden ya entregada/facturada. Inmutable.');
    }

    const meta = { ...(row.metadatos || {}) };
    if (dto.tipoEquipo          !== undefined) meta.tipoEquipo          = dto.tipoEquipo;
    if (dto.marca               !== undefined) meta.marca               = dto.marca;
    if (dto.modelo              !== undefined) meta.modelo              = dto.modelo;
    if (dto.serial              !== undefined) meta.serial              = dto.serial;
    if (dto.diagnosticoInicial  !== undefined) meta.diagnosticoInicial  = dto.diagnosticoInicial;
    if (dto.reporteTecnicoFinal !== undefined) meta.reporteTecnicoFinal = dto.reporteTecnicoFinal;
    if (dto.piezasUtilizadas    !== undefined) meta.piezasUtilizadas    = dto.piezasUtilizadas;
    if (dto.presupuestoMonto    !== undefined) meta.presupuestoMonto    = dto.presupuestoMonto;

    const data = { metadatos: meta };
    if (dto.tecnicoId !== undefined) data.tecnicoId     = dto.tecnicoId;
    if (dto.notas     !== undefined) data.notasTecnicas = dto.notas;

    const updated = await repo.actualizar(id, data);

    await auditReq(_fakeReqForAudit(reqMeta, user), {
      accion:     'UPDATE',
      tabla:      'OrdenTrabajo',
      registroId: id,
      detalles:   { tipoOT: repo.TIPO_OT, cambios: Object.keys(dto) },
    });

    return _serialize(updated);
  }

  async function transicionarEstado(id, dto, user, reqMeta) {
    const row = await repo.obtenerPorId(id);
    if (!row) throw new OrdenServicioError(404, 'NOT_FOUND', 'Orden no encontrada.');

    const desde = row.estado;
    const hacia = dto.estado;

    if (desde === hacia) {
      throw new OrdenServicioError(400, 'ESTADO_SIN_CAMBIO', 'La orden ya está en ese estado.');
    }
    const permitidos = TRANSICIONES_VALIDAS[desde] || [];
    if (!permitidos.includes(hacia)) {
      throw new OrdenServicioError(409, 'TRANSICION_INVALIDA',
        `No se permite la transición ${desde} → ${hacia}. Permitidas: ${permitidos.join(', ') || '(ninguna, estado terminal)'}.`);
    }

    // "Entregado/Facturado" sólo lo dispara el endpoint facturar() — no se
    // permite saltar directo aquí para no romper el invariante de NCF emitido.
    if (hacia === ESTADO_TERMINAL) {
      throw new OrdenServicioError(409, 'USAR_FACTURAR',
        'Para cerrar como "Entregado/Facturado", usa el endpoint /facturar — emite NCF B01/B02 y cierra la orden en una transacción.');
    }

    const meta = { ...(row.metadatos || {}) };
    if (dto.reporteTecnicoFinal !== undefined) meta.reporteTecnicoFinal = dto.reporteTecnicoFinal;
    if (dto.presupuestoMonto    !== undefined) meta.presupuestoMonto    = dto.presupuestoMonto;
    if (dto.piezasUtilizadas    !== undefined) meta.piezasUtilizadas    = dto.piezasUtilizadas;

    const data = { estado: hacia, metadatos: meta };
    if (dto.notas !== undefined) data.notasTecnicas = dto.notas;

    const updated = await repo.actualizar(id, data);

    await auditReq(_fakeReqForAudit(reqMeta, user), {
      accion:     'UPDATE',
      tabla:      'OrdenTrabajo',
      registroId: id,
      detalles:   { tipoOT: repo.TIPO_OT, transicion: `${desde} → ${hacia}` },
    });

    return _serialize(updated);
  }

  async function facturar(id, dto, user, reqMeta) {
    if (typeof procesarVentaPOS !== 'function') {
      throw new OrdenServicioError(503, 'POS_NO_DISPONIBLE',
        'Servicio POS no inyectado. No se puede emitir la factura.');
    }

    const row = await repo.obtenerPorId(id);
    if (!row) throw new OrdenServicioError(404, 'NOT_FOUND', 'Orden no encontrada.');
    if (row.estado !== 'Listo para Entrega') {
      throw new OrdenServicioError(409, 'ESTADO_NO_FACTURABLE',
        `La orden debe estar en "Listo para Entrega" antes de facturar. Estado actual: ${row.estado}.`);
    }
    if (row.estaFacturada) {
      throw new OrdenServicioError(409, 'YA_FACTURADA', 'Orden ya facturada anteriormente.');
    }

    const meta = row.metadatos || {};
    const presupuesto = Number(meta.presupuestoMonto || 0);
    const piezas = Array.isArray(meta.piezasUtilizadas) ? meta.piezasUtilizadas : [];

    // Línea principal: mano de obra / servicio técnico (con presupuesto)
    const lineas = [];
    if (presupuesto > 0) {
      lineas.push({
        descripcion:    `Servicio técnico ${meta.tipoEquipo || ''} ${meta.marca || ''} ${meta.modelo || ''}`.trim(),
        cantidad:       1,
        precioUnitario: presupuesto,
      });
    }
    // Líneas de repuestos
    for (const p of piezas) {
      lineas.push({
        productoId:     p.productoId ?? null,
        descripcion:    p.descripcion,
        cantidad:       Number(p.cantidad || 1),
        precioUnitario: Number(p.precioUnitario || 0),
      });
    }

    if (lineas.length === 0) {
      throw new OrdenServicioError(400, 'NADA_QUE_FACTURAR',
        'La orden no tiene presupuesto ni piezas. Imposible facturar monto 0.');
    }

    const dtoPos = {
      clienteId:           row.clienteId,
      lineas,
      descuentoGlobalPct:  0,
      descuentoGlobalMonto: 0,
      applyItbis:          true,
      esCotizacion:        false,
      pagos:               [{ metodo: dto.metodoPago || 'Efectivo', monto: 0, refer: dto.refer ?? null }],
      diasVence:           Number(dto.diasVence || 0),
      pinSupervisor:       dto.pinSupervisor ?? null,
    };
    if (dto.tipoNcfOverride) dtoPos.tipoNcf = dto.tipoNcfOverride;

    const factura = await procesarVentaPOS(dtoPos, user, reqMeta);

    await repo.actualizar(id, {
      estado:        ESTADO_TERMINAL,
      estaFacturada: true,
      completadaEn:  new Date(),
    });
    const cerrada = await repo.obtenerPorId(id);

    await auditReq(_fakeReqForAudit(reqMeta, user), {
      accion:     'UPDATE',
      tabla:      'OrdenTrabajo',
      registroId: id,
      detalles:   {
        tipoOT:        repo.TIPO_OT,
        transicion:    `Listo para Entrega → ${ESTADO_TERMINAL}`,
        facturaId:     factura?.id ?? null,
        noFactura:     factura?.noFactura ?? null,
        ncf:           factura?.ncf ?? null,
        tipoNcf:       factura?.tipoNcf ?? null,
        total:         factura?.total ?? null,
      },
    });

    return { orden: _serialize(cerrada), factura };
  }

  function _renderConduceHtml(orden) {
    const meta = orden.metadatos || {};
    const piezas = Array.isArray(meta.piezasUtilizadas) ? meta.piezasUtilizadas : [];
    const piezasHtml = piezas.length
      ? piezas.map((p) => `
          <tr>
            <td>${_esc(p.descripcion)}</td>
            <td style="text-align:center">${_esc(p.cantidad)}</td>
            <td style="text-align:right">${Number(p.precioUnitario || 0).toFixed(2)}</td>
          </tr>`).join('')
      : `<tr><td colspan="3" style="text-align:center;color:#64748b;font-style:italic">— sin piezas registradas —</td></tr>`;

    const cliente = orden.cliente || {};
    const tecnico = orden.tecnico ? `${orden.tecnico.nombre ?? ''} ${orden.tecnico.apellido ?? ''}`.trim() : '—';

    return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<title>Conduce ${_esc(orden.noOT)}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:Arial,Helvetica,sans-serif;color:#0f172a;margin:24px;font-size:12px}
  header{border-bottom:3px solid #2563eb;padding-bottom:12px;margin-bottom:20px;display:flex;justify-content:space-between;align-items:flex-end}
  h1{margin:0;color:#1e293b;font-size:20px;letter-spacing:1px}
  .badge{background:#1e293b;color:#fff;padding:4px 10px;border-radius:4px;font-weight:bold;font-size:11px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:18px}
  .box{border:1px solid #cbd5e1;padding:10px 12px;border-radius:6px;background:#f8fafc}
  .box h2{margin:0 0 6px;font-size:11px;color:#475569;text-transform:uppercase;letter-spacing:0.6px}
  .box p{margin:2px 0;line-height:1.4}
  .label{color:#64748b;font-size:10px}
  table{width:100%;border-collapse:collapse;margin-bottom:14px;font-size:11.5px}
  th{background:#1e293b;color:#fff;padding:6px 8px;text-align:left;font-size:10.5px;letter-spacing:0.4px}
  td{padding:6px 8px;border-bottom:1px solid #e2e8f0}
  .estado{display:inline-block;background:#2563eb;color:#fff;padding:3px 9px;border-radius:3px;font-size:10.5px;font-weight:bold}
  .firmas{display:grid;grid-template-columns:1fr 1fr;gap:32px;margin-top:48px}
  .firma{border-top:1px solid #0f172a;padding-top:6px;font-size:10.5px;color:#475569;text-align:center}
  footer{margin-top:36px;font-size:9.5px;color:#94a3b8;text-align:center;border-top:1px solid #cbd5e1;padding-top:8px}
  .diag{white-space:pre-wrap;background:#f1f5f9;border:1px solid #e2e8f0;padding:8px;border-radius:4px;min-height:40px}
</style></head>
<body>
  <header>
    <div>
      <h1>CONDUCE / RECIBO TÉCNICO</h1>
      <div class="label">ACR Networks &amp; Solutions — Servicio Técnico</div>
    </div>
    <div class="badge">${_esc(orden.noOT)}</div>
  </header>

  <div class="grid">
    <div class="box">
      <h2>Cliente</h2>
      <p><strong>${_esc(cliente.razonSocial || '')}</strong></p>
      <p class="label">Código: ${_esc(cliente.noCliente || '')}</p>
      <p class="label">RNC/Cédula: ${_esc(cliente.rnc || '—')}</p>
      <p class="label">${_esc(cliente.direccion || '')}</p>
    </div>
    <div class="box">
      <h2>Recepción</h2>
      <p><strong>Estado:</strong> <span class="estado">${_esc(orden.estado)}</span></p>
      <p><strong>Recibido:</strong> ${_esc(_fmtFecha(orden.createdAt))}</p>
      <p><strong>Técnico asignado:</strong> ${_esc(tecnico)}</p>
    </div>
  </div>

  <div class="box" style="margin-bottom:16px">
    <h2>Equipo recibido</h2>
    <p><strong>Tipo:</strong> ${_esc(meta.tipoEquipo || '—')} &nbsp;|&nbsp;
       <strong>Marca:</strong> ${_esc(meta.marca || '—')} &nbsp;|&nbsp;
       <strong>Modelo:</strong> ${_esc(meta.modelo || '—')} &nbsp;|&nbsp;
       <strong>Serial:</strong> ${_esc(meta.serial || '—')}</p>
  </div>

  <h2 style="font-size:11px;color:#475569;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:4px">Diagnóstico inicial del cliente</h2>
  <div class="diag">${_esc(meta.diagnosticoInicial || '—')}</div>

  ${meta.reporteTecnicoFinal ? `
  <h2 style="font-size:11px;color:#475569;text-transform:uppercase;letter-spacing:0.6px;margin:14px 0 4px">Reporte técnico final</h2>
  <div class="diag">${_esc(meta.reporteTecnicoFinal)}</div>` : ''}

  <h2 style="font-size:11px;color:#475569;text-transform:uppercase;letter-spacing:0.6px;margin:18px 0 4px">Piezas / Repuestos</h2>
  <table>
    <thead><tr><th>Descripción</th><th style="text-align:center;width:90px">Cant.</th><th style="text-align:right;width:120px">Precio Unit.</th></tr></thead>
    <tbody>${piezasHtml}</tbody>
  </table>

  ${meta.presupuestoMonto != null ? `
  <p style="text-align:right;font-size:13px"><strong>Presupuesto servicio:</strong> RD$ ${Number(meta.presupuestoMonto).toFixed(2)}</p>` : ''}

  <div class="firmas">
    <div class="firma">Firma del cliente — recibe</div>
    <div class="firma">Firma técnico — ACR</div>
  </div>

  <footer>
    Este documento es un comprobante interno de recepción/entrega de equipo. NO sustituye factura DGII.
    Generado: ${_esc(_fmtFecha(new Date()))}.
  </footer>
</body></html>`;
  }

  async function generarConducePdf(id) {
    const row = await repo.obtenerPorId(id);
    if (!row) throw new OrdenServicioError(404, 'NOT_FOUND', 'Orden no encontrada.');
    const html = _renderConduceHtml(row);
    const pdfBuffer = await generarPdfDocumento(html);
    return { buffer: pdfBuffer, filename: `conduce-${row.noOT || row.id}.pdf` };
  }

  return {
    OrdenServicioError,
    ESTADOS_OT_SERVICIO,
    listar,
    obtener,
    crear,
    actualizar,
    transicionarEstado,
    facturar,
    generarConducePdf,
  };
}

module.exports = createServiciosOrdenesService;
module.exports.OrdenServicioError = OrdenServicioError;
