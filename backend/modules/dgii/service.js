/**
 * backend/modules/dgii/service.js
 *
 * Lógica del módulo DGII. F1: CRUD Compras. F2: Generación reporte 607.
 *
 * Cyber Neo Always-On aplicado:
 *   - A01: cada op respeta JWT + dgii:reportar (validado en router). Generar
 *     archivo exige también requerirTOTPEstricto (router).
 *   - A03: queries 100% Prisma parametrizado.
 *   - A04: noCompra atómico. Lock concurrencia por (tipo, periodo, rnc)
 *     previene doble emisión simultánea.
 *   - A05: filename derivado server-side de constantes + RNC propio (cero
 *     req.params en path). Bucket subdir `fiscal/reportes/<rnc>/<periodo>/`.
 *   - A08: SHA-256 atado al row ReporteDGIIGenerado prueba integridad
 *     post-facto. Archivo nunca se sobreescribe — nuevas generaciones crean
 *     filas nuevas con SHA distintos (versioning natural).
 *   - A09: auditReq en generación + descarga. RNC enmascarado en logs.
 *   - Path traversal: bucket path 100% server-derived (RNC empresa propio,
 *     periodo Zod-validado YYYYMM, sha256 hex de constantes server-side).
 */

const crypto = require('crypto');

class DgiiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code   = code;
  }
}

// ── Helpers 607 ─────────────────────────────────────────────────────────────
//
// Formateo posicional estricto Norma DGII 06-2018:
//   - Montos: 2 decimales fixed, "0.00" para vacíos. Negativos llevan signo.
//   - Fechas: YYYYMMDD (sin guiones). Vacío → "" (no "00000000").
//   - Pipe `|` literal como separador. Campos vacíos = "" entre pipes.
//
// _money(n) admite n=null/undefined → "0.00" sin romper.
function _money(n) {
  if (n == null) return '0.00';
  const v = typeof n === 'object' && typeof n.toFixed !== 'function'
    ? Number(n.toString())
    : Number(n);
  if (!Number.isFinite(v)) return '0.00';
  return (Math.round(v * 100) / 100).toFixed(2);
}

// Fechas DGII en UTC. Usar local TZ aquí causaría shift de día cuando el
// servidor está en UTC-N y la factura se emite cerca de medianoche →
// reporte cambia de mes. UTC garantiza estabilidad para auditoría 10 años.
function _date(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

// Mapping desglose pagos JSON → 7 columnas 607.
//   Shape entrada (factura.pagos): [{ metodo: 'Efectivo'|'Transferencia'|..., monto: Number, refer?: String }]
//   Resultado: { efectivo, cheque, tarjeta, credito, bonos, permuta, otros }
function _desglosePagos(pagosJson, totalFallback) {
  const buckets = {
    efectivo: 0, cheque: 0, tarjeta: 0, credito: 0,
    bonos: 0, permuta: 0, otros: 0,
  };
  if (!Array.isArray(pagosJson) || pagosJson.length === 0) {
    // Sin desglose: asume crédito si fechaPago null, efectivo si pagada — DGII
    // permite ambos; default a "otros" para forzar al user a configurar pagos.
    buckets.otros = Number(totalFallback) || 0;
    return buckets;
  }
  for (const p of pagosJson) {
    const monto = Number(p?.monto) || 0;
    const metodo = String(p?.metodo ?? '').toLowerCase();
    if (metodo === 'efectivo')                                              buckets.efectivo += monto;
    else if (['cheque', 'transferencia', 'deposito', 'depósito'].includes(metodo)) buckets.cheque += monto;
    else if (['tarjeta', 'tarjeta_credito', 'tarjeta_debito', 'visa', 'mastercard'].includes(metodo)) buckets.tarjeta += monto;
    else if (['credito', 'crédito', 'cuenta', 'a_credito'].includes(metodo)) buckets.credito += monto;
    else if (['bono', 'bonos', 'certificado', 'regalo', 'gift'].includes(metodo)) buckets.bonos += monto;
    else if (metodo === 'permuta')                                          buckets.permuta += monto;
    else                                                                    buckets.otros += monto;
  }
  return buckets;
}

// Identidad fiscal del cliente para el 607:
//   tipoNcf='Crédito Fiscal' (B01) → exige RNC; TipoID=1
//   tipoNcf='Consumidor Final' (B02) → RNC/Cédula vacíos OK; TipoID vacío
//   tipoNcf=otros → usa lo que tenga (RNC > Cédula > vacío)
// Retorna { id: string|'', tipo: '1'|'2'|'' }
function _identidadFiscalCliente(cliente, tipoNcfFactura, validarRncRD) {
  if (!cliente) return { id: '', tipo: '' };
  const rnc = cliente.rnc?.replace(/\D/g, '') ?? '';
  const ced = cliente.cedula?.replace(/\D/g, '') ?? '';

  // B01/Crédito Fiscal → RNC obligatorio (DGII exige). Si pasa dv → 1.
  if (tipoNcfFactura === 'Crédito Fiscal') {
    if (rnc.length === 9 && validarRncRD(rnc)) return { id: rnc, tipo: '1' };
    if (ced.length === 11)                     return { id: ced, tipo: '2' };
    return { id: '', tipo: '' };
  }
  // B02/Consumidor Final → opcional. Si trae RNC/cédula los reportamos.
  if (rnc.length === 9 && validarRncRD(rnc)) return { id: rnc, tipo: '1' };
  if (ced.length === 11)                     return { id: ced, tipo: '2' };
  return { id: '', tipo: '' };
}

function createDgiiService(deps) {
  const { repo, prisma, auditReq, generarSiguienteCodigo, helpers, supabase, SUPABASE_BUCKET } = deps;
  if (!repo)                                          throw new Error('createDgiiService: repo required');
  if (!prisma)                                        throw new Error('createDgiiService: prisma required');
  if (typeof auditReq !== 'function')                 throw new Error('createDgiiService: auditReq required');
  if (typeof generarSiguienteCodigo !== 'function')   throw new Error('createDgiiService: generarSiguienteCodigo required');
  if (!helpers)                                       throw new Error('createDgiiService: helpers required');
  const { validarRncRD, enmascararRnc } = helpers;
  if (typeof validarRncRD !== 'function')             throw new Error('createDgiiService: helpers.validarRncRD required');
  if (typeof enmascararRnc !== 'function')            throw new Error('createDgiiService: helpers.enmascararRnc required');

  // Singleton in-memory lock por (tipo:periodo:rnc) — preservado en closure
  // de la factory para que dos requests simultáneos del mismo reporte no
  // generen archivos duplicados con SHA distintos. Segundo recibe 409.
  const _locksGeneracion = new Map();

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

  // Identidad fiscal del suplidor: prefiere RNC; fallback cédula.
  // Devuelve `{ id, tipo }` o lanza DgiiError si suplidor no tiene ninguno o
  // si el RNC declarado no pasa dígito verificador (defensa anti datos basura
  // que rebotaría el archivo TXT al cargarlo en OFV).
  function _validarIdentidadFiscalSuplidor(suplidor) {
    if (!suplidor) throw new DgiiError(404, 'SUP_NOT_FOUND', 'Suplidor no encontrado.');
    if (suplidor.rnc && suplidor.rnc.trim()) {
      if (!validarRncRD(suplidor.rnc)) {
        throw new DgiiError(409, 'SUP_RNC_INVALID',
          `RNC del suplidor "${suplidor.razonSocial}" no pasa dígito verificador DGII. Corrige en CRM antes de registrar la compra.`);
      }
      return { id: suplidor.rnc.replace(/\D/g, ''), tipo: '1' };
    }
    if (suplidor.cedula && suplidor.cedula.trim()) {
      return { id: suplidor.cedula.replace(/\D/g, ''), tipo: '2' };
    }
    throw new DgiiError(409, 'SUP_SIN_ID',
      `Suplidor "${suplidor.razonSocial}" no tiene RNC ni cédula. DGII exige uno de los dos para 606.`);
  }

  // ── Listar Compras ──────────────────────────────────────────────────────
  async function listarCompras(query) {
    const take    = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 200);
    const pageNum = Math.max(parseInt(query.page, 10) || 1, 1);
    const skip    = (pageNum - 1) * take;
    const where   = { deletedAt: null };
    if (query.suplidorId) where.suplidorId = query.suplidorId;
    if (query.desde || query.hasta) {
      where.fechaComprobante = {};
      if (query.desde) where.fechaComprobante.gte = new Date(query.desde);
      if (query.hasta) where.fechaComprobante.lte = new Date(query.hasta);
    }
    if (query.search) {
      where.OR = [
        { noCompra:     { contains: query.search, mode: 'insensitive' } },
        { ncfProveedor: { contains: query.search, mode: 'insensitive' } },
        { suplidor:     { razonSocial: { contains: query.search, mode: 'insensitive' } } },
      ];
    }
    const [compras, total] = await repo.listCompras(where, take, skip);
    return {
      status: 200,
      body: {
        data: compras,
        meta: { total, page: pageNum, totalPages: Math.max(Math.ceil(total / take), 1) },
      },
    };
  }

  async function obtenerCompra(id) {
    const compra = await repo.findCompraById(id);
    if (!compra || compra.deletedAt) {
      throw new DgiiError(404, 'NOT_FOUND', 'Compra no encontrada.');
    }
    return { status: 200, body: compra };
  }

  // ── Crear Compra ────────────────────────────────────────────────────────
  async function crearCompra(data, user, reqMeta) {
    const suplidor = await repo.findSuplidorById(data.suplidorId);
    _validarIdentidadFiscalSuplidor(suplidor);

    const dup = await repo.findCompraByNcf(data.suplidorId, data.ncfProveedor);
    if (dup) {
      throw new DgiiError(409, 'NCF_DUP',
        `Ya existe compra ${dup.noCompra} con NCF ${data.ncfProveedor} de este suplidor.`);
    }

    try {
      const compra = await prisma.$transaction(async (tx) => {
        const noCompra = await generarSiguienteCodigo('compra', tx);
        return repo.createCompraTx(tx, {
          ...data,
          noCompra,
          empleadoId: user?.sub ?? null,
        });
      });
      auditReq('dgii:compra_creada', _fakeReqForAudit(reqMeta, user), {
        compraId:    compra.id,
        noCompra:    compra.noCompra,
        suplidorRnc: enmascararRnc(suplidor.rnc ?? suplidor.cedula),
        ncf:         data.ncfProveedor,
        monto:       Number(data.montoServicios) + Number(data.montoBienes) + Number(data.itbisFacturado),
      });
      return { status: 201, body: compra };
    } catch (e) {
      if (e.code === 'P2002') throw new DgiiError(409, 'DUP', 'noCompra duplicado (reintentar).');
      if (e.code === 'P2003') throw new DgiiError(400, 'FK_INVALID', 'Suplidor inválido.');
      throw e;
    }
  }

  // ── Actualizar Compra ───────────────────────────────────────────────────
  async function actualizarCompra(id, data, user, reqMeta) {
    const existing = await repo.findCompraById(id);
    if (!existing || existing.deletedAt) throw new DgiiError(404, 'NOT_FOUND', 'Compra no encontrada.');

    // Si cambian suplidor o NCF, re-validar fiscal + dup-check.
    if (data.suplidorId && data.suplidorId !== existing.suplidorId) {
      const sup = await repo.findSuplidorById(data.suplidorId);
      _validarIdentidadFiscalSuplidor(sup);
    }
    if (data.ncfProveedor && data.ncfProveedor !== existing.ncfProveedor) {
      const dup = await repo.findCompraByNcf(
        data.suplidorId ?? existing.suplidorId,
        data.ncfProveedor,
      );
      if (dup && dup.id !== id) {
        throw new DgiiError(409, 'NCF_DUP',
          `NCF ${data.ncfProveedor} ya registrado en compra ${dup.noCompra}.`);
      }
    }

    try {
      const compra = await repo.updateCompra(id, data);
      auditReq('dgii:compra_actualizada', _fakeReqForAudit(reqMeta, user), {
        compraId: id, campos: Object.keys(data),
      });
      return { status: 200, body: compra };
    } catch (e) {
      if (e.code === 'P2025') throw new DgiiError(404, 'NOT_FOUND', 'Compra no encontrada.');
      throw e;
    }
  }

  // ── Eliminar Compra (soft delete) ───────────────────────────────────────
  //
  // Norma DGII 06-2018 art. 7: comprobantes deben preservarse 10 años. Por eso
  // soft delete — el row queda en BD, ignorado por listados y reportes, pero
  // existe para auditorías futuras.
  async function eliminarCompra(id, user, reqMeta) {
    const existing = await repo.findCompraById(id);
    if (!existing || existing.deletedAt) {
      throw new DgiiError(404, 'NOT_FOUND', 'Compra no encontrada.');
    }
    await repo.softDeleteCompra(id);
    auditReq('dgii:compra_eliminada', _fakeReqForAudit(reqMeta, user), {
      compraId: id, noCompra: existing.noCompra,
      ncf: existing.ncfProveedor,
    });
    return { status: 204, body: null };
  }

  // ── Reporte 607 (Ventas / ND / NC) ──────────────────────────────────────
  //
  // Norma DGII 06-2018: 23 campos pipe-delimited por factura/ND/NC.
  // Reglas inclusión (ver PRD §5.3):
  //   - Factura B01 / B02 / B14: monto POSITIVO.
  //   - ND B03: monto POSITIVO + NCF Modificado = NCF de factura origen.
  //   - NC B04: monto NEGATIVO + NCF Modificado = NCF de factura origen.
  //   - Factura ESTADO='Anulada' dentro del periodo (sin NC vinculada):
  //     monto NEGATIVO con NCF original (regla consolidación DGII).
  //
  // Devuelve descriptor { header, rows, totalMonto, totalItbis, periodo, rnc }.
  function _validarPeriodo(periodo) {
    if (!/^\d{6}$/.test(String(periodo))) {
      throw new DgiiError(400, 'PERIODO_INVALID', 'Periodo debe ser YYYYMM.');
    }
    const y = parseInt(periodo.slice(0, 4), 10);
    const m = parseInt(periodo.slice(4, 6), 10);
    if (m < 1 || m > 12)               throw new DgiiError(400, 'PERIODO_INVALID', 'Mes debe ser 01-12.');
    if (y < 2010 || y > 2100)          throw new DgiiError(400, 'PERIODO_INVALID', 'Año fuera de rango.');
    const start = new Date(y, m - 1, 1);
    const end   = new Date(y, m,     1);
    const ahora = new Date();
    if (start > ahora) throw new DgiiError(400, 'PERIODO_FUTURO', 'Periodo aún no ha ocurrido.');
    return { start, end, y, m };
  }

  function _mapFacturaA607Row(f, empresaRnc) {
    // Determinar el signo del monto: NC (B04) y facturas anuladas → negativo.
    const esNC          = !!f.esNotaCredito;
    const esAnulada     = f.estado === 'Anulada';
    const signo         = (esNC || esAnulada) ? -1 : 1;

    // NCF Modificado: solo en ND/NC. ND/NC apuntan a facturaOrigen.ncf.
    const ncfModificado = (f.esNotaCredito || f.esNotaDebito)
      ? (f.facturaOrigen?.ncf ?? '')
      : '';

    // Identidad fiscal del cliente.
    const { id: clienteId, tipo: clienteTipoId } = _identidadFiscalCliente(
      f.cliente, f.tipoNcf, validarRncRD,
    );

    // Montos con signo. Decimal de Prisma → Number via Number(d.toString()).
    const subtotal = signo * (Number(f.subtotal) || 0);
    const itbis    = signo * (Number(f.itbis) || 0);
    const total    = signo * (Number(f.total) || 0);

    // Desglose pagos: NCs/Anuladas no reportan formas de pago — DGII no las
    // exige porque el documento revierte. Para esos, todo 0.00.
    let pagos = { efectivo: 0, cheque: 0, tarjeta: 0, credito: 0, bonos: 0, permuta: 0, otros: 0 };
    if (!esNC && !esAnulada) {
      pagos = _desglosePagos(f.pagos, Number(f.total) || 0);
    }

    // Fields 1..23 (PRD §5.2):
    const row = [
      clienteId,                                                // 1  RNC/Cédula Cliente
      clienteTipoId,                                            // 2  TipoID
      String(f.ncf || '').toUpperCase(),                        // 3  NCF
      String(ncfModificado || '').toUpperCase(),                // 4  NCF Modificado
      String(f.tipoIngreso || '01'),                            // 5  TipoIngreso
      _date(f.fechaEmision),                                    // 6  Fecha Comprobante
      _date(f.fechaRetencion),                                  // 7  Fecha Retención
      _money(subtotal),                                         // 8  Monto Facturado
      _money(itbis),                                            // 9  ITBIS Facturado
      _money(signo * (Number(f.itbisRetenidoTercero) || 0)),    // 10 ITBIS Retenido por Tercero
      _money(signo * (Number(f.itbisPercibido) || 0)),          // 11 ITBIS Percibido
      _money(signo * (Number(f.retencionRentaTercero) || 0)),   // 12 Retención Renta por Tercero
      _money(signo * (Number(f.isrPercibido) || 0)),            // 13 ISR Percibido
      _money(signo * (Number(f.impuestoSelectivoConsumo) || 0)),// 14 Imp. Selectivo Consumo
      _money(signo * (Number(f.otrosImpuestos) || 0)),          // 15 Otros Impuestos/Tasas
      _money(signo * (Number(f.propinaLegal) || 0)),            // 16 Propina Legal
      _money(signo * pagos.efectivo),                           // 17 Efectivo
      _money(signo * pagos.cheque),                             // 18 Cheque/Transf/Depósito
      _money(signo * pagos.tarjeta),                            // 19 Tarjeta
      _money(signo * pagos.credito),                            // 20 Venta a Crédito
      _money(signo * pagos.bonos),                              // 21 Bonos/Certificados/Regalo
      _money(signo * pagos.permuta),                            // 22 Permuta
      _money(signo * pagos.otros),                              // 23 Otras Formas
    ];

    return {
      txt: row.join('|'),
      facturaId:  f.id,
      ncf:        f.ncf,
      esNegativo: signo < 0,
      total,
      itbis,
    };
  }

  async function previewReporte607(periodo) {
    _validarPeriodo(periodo);
    const empresa = await repo.findEmpresaRnc();
    if (!empresa?.rnc || !validarRncRD(empresa.rnc)) {
      throw new DgiiError(409, 'EMPRESA_RNC_INVALID',
        'Configura un RNC válido en Mi Empresa antes de generar el 607.');
    }
    const rncEmpresa = empresa.rnc.replace(/\D/g, '');
    const { start, end } = _validarPeriodo(periodo);
    const facturas = await repo.listFacturasParaReporte607(start, end);

    const rows = facturas.map(f => _mapFacturaA607Row(f, rncEmpresa));
    const header = `607|${rncEmpresa}|${periodo}|${rows.length}`;

    const totalMonto = rows.reduce((s, r) => s + r.total, 0);
    const totalItbis = rows.reduce((s, r) => s + r.itbis, 0);
    const ncCount    = rows.filter(r => r.esNegativo).length;

    return {
      header,
      rows,
      cantidadRegistros: rows.length,
      totalMonto:        Math.round(totalMonto * 100) / 100,
      totalItbis:        Math.round(totalItbis * 100) / 100,
      notasCreditoCount: ncCount,
      periodo,
      rncEmpresa,
    };
  }

  // Genera TXT final + SHA-256 + sube a Supabase Storage + crea fila
  // ReporteDGIIGenerado. Lock previene re-entrada simultánea.
  async function generarTXT607(periodo, user, reqMeta) {
    const empresa = await repo.findEmpresaRnc();
    if (!empresa?.rnc) throw new DgiiError(409, 'EMPRESA_RNC_INVALID', 'Configura RNC en Mi Empresa.');
    const rncEmpresa = empresa.rnc.replace(/\D/g, '');

    // Lock concurrencia (tipo:periodo:rnc).
    const lockKey = `607:${periodo}:${rncEmpresa}`;
    if (_locksGeneracion.has(lockKey)) {
      throw new DgiiError(409, 'GENERACION_EN_PROGRESO',
        'Ya hay una generación de 607 en curso para este periodo.');
    }
    const promise = (async () => {
      const preview = await previewReporte607(periodo);
      // CRLF separador (Norma DGII oficial = CRLF, no LF).
      const lineas = [preview.header, ...preview.rows.map(r => r.txt)];
      const txt    = lineas.join('\r\n') + '\r\n';
      const buffer = Buffer.from(txt, 'utf8');
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

      // Path Storage. Cero req input — todo derivado server-side.
      // Bucket reutiliza SUPABASE_BUCKET (mismo policy que assets empresa).
      const timestamp = Date.now();
      const shaPrefix = sha256.slice(0, 8);
      const path = `fiscal/reportes/${rncEmpresa}/${periodo}/607-${timestamp}-${shaPrefix}.txt`;

      let archivoUrl = null;
      if (supabase && SUPABASE_BUCKET) {
        try {
          const { error } = await supabase.storage.from(SUPABASE_BUCKET).upload(path, buffer, {
            contentType: 'text/plain; charset=utf-8',
            cacheControl: '0',
            upsert:       false,
          });
          if (error) {
            console.error('[DGII 607 upload]', error.message);
          } else {
            const { data: pub } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(path);
            archivoUrl = pub?.publicUrl ?? null;
          }
        } catch (e) {
          console.error('[DGII 607 upload EXCEPTION]', e.message);
        }
      }

      const registro = await repo.createReporteRegistro({
        tipo:              '607',
        periodo,
        rncEmpresa,
        cantidadRegistros: preview.cantidadRegistros,
        totalMonto:        preview.totalMonto,
        totalItbis:        preview.totalItbis,
        sha256,
        archivoUrl,
        empleadoId:        user?.sub ?? null,
        ipGeneracion:      reqMeta?.ip ?? null,
        userAgent:         reqMeta?.ua ?? null,
      });

      auditReq('dgii:607_generado', _fakeReqForAudit(reqMeta, user), {
        registroId:        registro.id,
        periodo,
        cantidadRegistros: preview.cantidadRegistros,
        totalMonto:        preview.totalMonto,
        totalItbis:        preview.totalItbis,
        notasCreditoCount: preview.notasCreditoCount,
        sha256:            sha256.slice(0, 16) + '…',
        rncEmpresaMasked:  enmascararRnc(rncEmpresa),
      });

      return {
        status: 201,
        body: {
          registroId:        registro.id,
          periodo,
          rncEmpresa,
          cantidadRegistros: preview.cantidadRegistros,
          totalMonto:        preview.totalMonto,
          totalItbis:        preview.totalItbis,
          notasCreditoCount: preview.notasCreditoCount,
          sha256,
          archivoUrl,
          filename:          `DGII_F_607_${rncEmpresa}_${periodo}.TXT`,
          generadoEn:        registro.generadoEn,
        },
      };
    })().finally(() => _locksGeneracion.delete(lockKey));

    _locksGeneracion.set(lockKey, promise);
    return promise;
  }

  async function previewReporte607Handler(periodo) {
    const preview = await previewReporte607(periodo);
    return {
      status: 200,
      body: {
        header:            preview.header,
        cantidadRegistros: preview.cantidadRegistros,
        totalMonto:        preview.totalMonto,
        totalItbis:        preview.totalItbis,
        notasCreditoCount: preview.notasCreditoCount,
        periodo:           preview.periodo,
        rncEmpresa:        preview.rncEmpresa,
        // Preview entrega máximo 500 filas en JSON para no saturar respuesta.
        // Para listado completo el contador descarga el TXT.
        rows: preview.rows.slice(0, 500).map(r => ({
          ncf:        r.ncf,
          facturaId:  r.facturaId,
          total:      r.total,
          itbis:      r.itbis,
          esNegativo: r.esNegativo,
          txt:        r.txt,
        })),
        truncated: preview.rows.length > 500,
      },
    };
  }

  // ── Historial Reportes (placeholder F2/F3) ──────────────────────────────
  async function listarHistorialReportes(query) {
    const take    = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 200);
    const pageNum = Math.max(parseInt(query.page, 10) || 1, 1);
    const skip    = (pageNum - 1) * take;
    const where = {};
    if (query.tipo)    where.tipo    = query.tipo;
    if (query.periodo) where.periodo = query.periodo;
    const [data, total] = await repo.listReportesHistorial(where, take, skip);
    return {
      status: 200,
      body: {
        data,
        meta: { total, page: pageNum, totalPages: Math.max(Math.ceil(total / take), 1) },
      },
    };
  }

  return {
    DgiiError,
    listarCompras,
    obtenerCompra,
    crearCompra,
    actualizarCompra,
    eliminarCompra,
    listarHistorialReportes,
    // F2 — 607
    previewReporte607,
    previewReporte607Handler,
    generarTXT607,
  };
}

module.exports = createDgiiService;
module.exports.DgiiError = DgiiError;
