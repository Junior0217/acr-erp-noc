/**
 * backend/modules/ventas/_lib.js
 *
 * Cross-cutting helpers compartidos por sub-modulos de ventas.
 * Factory cierra sobre deps (prisma, supabase, email, PDF helpers).
 */

const PDFDocument = require('pdfkit');
const { z }       = require('zod');
const crypto      = require('crypto');

module.exports = function createVentasLib(deps) {
  const { prisma } = deps;

// ─── PDF Builder (shared por rutas legacy + envío por email) ─────────────────
// Delegación al motor corporativo nuevo (Puppeteer + renderPdfDoc).
// Antes era pdfkit; ahora se unifica para que TODOS los PDFs (legacy + nuevos +
// email automático) salgan con el mismo diseño y datos desde EmpresaPerfil.

async function buildFacturaPDFBuffer(factura) {
  const empresa = await prisma.empresaPerfil.findUnique({ where: { id: 1 } })
  const empresaConAssets = empresa
    ? { ...empresa, assets: await inlineAssets(empresa.assets ?? {}) }
    : { razonSocial: '', rnc: '', assets: {} }
  const c = factura.cliente ?? {}
  // Hash computado UNA sola vez; mismo valor para QR + texto verify.
  const legacyHash      = facturaVerifyHash(factura, 'pdf-legacy')
  const legacyVerifyUrl = `${PUBLIC_VERIFY_BASE}/verify/${legacyHash}`
  // Soporta tanto factura.lineas (POS) como factura.orden.lineas (OT) — coge la primera no vacía.
  const lineasSrc = (factura.lineas?.length ? factura.lineas : factura.orden?.lineas) ?? []
  const items = lineasSrc.map(l => ({
    codigo:         l.producto?.sku ?? l.itemCatalogo?.sku ?? (l.producto?.id ? `ART-${String(l.producto.id).padStart(3, '0')}` : null),
    descripcion:    l.descripcion ?? l.itemCatalogo?.nombre ?? '—',
    detalle:        l.itemCatalogo?.descripcion ?? null,
    sku:            l.producto?.sku ?? null,
    cantidad:       l.cantidad,
    precioUnitario: Number(l.precioUnitario),
  }))
  const html = renderPdfDoc({
    tipo:         factura.esCotizacion ? 'cotizacion'
                  : factura.esNotaCredito ? 'nota-credito'
                  : factura.esNotaDebito  ? 'nota-debito'
                  : 'factura',
    numero:       factura.noFactura,
    ncf:          factura.ncf ?? null,
    tipoNcf:      factura.tipoNcf ?? null,
    empresa:      empresaConAssets,
    cliente: {
      razonSocial: c.razonSocial,
      noCliente:   c.noCliente,
      rnc:         c.rnc,
      contacto:    c.nombreContacto ?? c.contacto ?? null,
      cedula:      c.cedula,
      direccion:   c.direccion,
      sector:      c.sector,
      provincia:   c.provincia,
      telefono:    c.telefono ?? c.telefonoPrincipal ?? c.telefonoContacto ?? null,
      email:       c.email,
    },
    items,
    subtotal:     Number(factura.subtotal),
    itbis:        Number(factura.itbis ?? 0),
    total:        Number(factura.total),
    fechaEmision: factura.fechaEmision,
    fechaVence:   factura.fechaVence,
    estado:       factura.estado,
    notas:        factura.notas,
    condiciones:  mergeCondiciones(empresa, factura),
    esNotaCredito:           !!factura.esNotaCredito,
    esNotaDebito:            !!factura.esNotaDebito,
    facturaOrigen:           factura.facturaOrigen
      ? { noFactura: factura.facturaOrigen.noFactura, ncf: factura.facturaOrigen.ncf, tipoNcf: factura.facturaOrigen.tipoNcf }
      : null,
    motivoNotaModificatoria: factura.motivoNotaModificatoria ?? null,
    verify:       { hash: legacyHash, url: legacyVerifyUrl },
    verifyQrDataUri: await renderVerifyQr(legacyVerifyUrl),
  })
  return generarPdfDocumento(html)
}

// (Ruta /api/facturas/:id/pdf registrada arriba, unificada con renderPdfDoc.)



// ─── Auto-secuenciador centralizado (núcleo ERP) ──────────────────────────────
// Atómico vía UPDATE-RETURNING sobre EmpresaPerfil.id=1 con jsonb_set. La fila
// se bloquea exclusivamente durante el UPDATE; dos cajeros concurrentes serializan
// y reciben códigos distintos (no race). Defaults se aplican si la entidad no
// existe aún en secuenciasConfig — un INSERT diferido no hace falta.
const SECUENCIA_DEFAULTS = {
  factura:     { prefijo: 'FAC', actual: 0, padding: 6 },
  cotizacion:  { prefijo: 'COT', actual: 0, padding: 6 },
  producto:    { prefijo: 'ART', actual: 0, padding: 6 },
  servicio:    { prefijo: 'SVC', actual: 0, padding: 6 },
  cliente:     { prefijo: 'CLI', actual: 0, padding: 6 },
  rma:         { prefijo: 'RMA', actual: 0, padding: 5 },
  plan:        { prefijo: 'PLN', actual: 0, padding: 6 },
  // Secuenciador interno para el "noFactura" de Notas de Crédito (NC-000001).
  // El NCF B04 sigue su PROPIA secuencia DGII en ConfiguracionNCF — son
  // numeradores independientes (no confundir interno vs fiscal).
  notaCredito: { prefijo: 'NC',  actual: 0, padding: 6 },
  // Idem para Nota de Débito interna (ND-000001) — NCF B03 vive aparte en
  // ConfiguracionNCF para que el numerador fiscal nunca dependa del interno.
  notaDebito:  { prefijo: 'ND',  actual: 0, padding: 6 },
}

async function generarSiguienteCodigo(entidad, tx) {
  const def = SECUENCIA_DEFAULTS[entidad]
  if (!def) throw new Error(`Entidad de secuencia desconocida: "${entidad}".`)
  const db = tx ?? prisma
  // jsonb_set asegura que la rama exista. Si la entidad no había sido configurada,
  // sembramos con defaults antes de incrementar.
  const seedPath = `{${entidad}}`
  const actualPath = `{${entidad},actual}`
  const rows = await db.$queryRawUnsafe(`
    UPDATE "EmpresaPerfil"
    SET    "secuenciasConfig" =
      jsonb_set(
        jsonb_set(
          COALESCE("secuenciasConfig", '{}'::jsonb),
          '${seedPath}',
          COALESCE("secuenciasConfig"->'${entidad}', $1::jsonb),
          true
        ),
        '${actualPath}',
        (
          (COALESCE(("secuenciasConfig"->'${entidad}'->>'actual')::int, ${def.actual}) + 1)::text
        )::jsonb,
        true
      )
    WHERE  id = 1
    RETURNING
      COALESCE("secuenciasConfig"->'${entidad}'->>'prefijo', $2)        AS prefijo,
      (("secuenciasConfig"->'${entidad}'->>'actual')::int)              AS actual,
      COALESCE(("secuenciasConfig"->'${entidad}'->>'padding')::int, $3) AS padding
  `, JSON.stringify(def), def.prefijo, def.padding)
  if (!rows || rows.length === 0) {
    // Fila id=1 no existe — crearla con defaults y reintentar una sola vez.
    await db.empresaPerfil.upsert({
      where:  { id: 1 },
      update: {},
      create: { id: 1, rnc: '', razonSocial: 'Empresa', secuenciasConfig: { [entidad]: def } },
    })
    return generarSiguienteCodigo(entidad, tx)
  }
  const { prefijo, actual, padding } = rows[0]
  return `${prefijo}-${String(actual).padStart(Number(padding) || 6, '0')}`
}

// Compute effective unit price after sequential discounts (% first, then fixed)
function efectivoUnitario(pu, pct, monto) {
  const afterPct = pu * (1 - pct / 100)
  return Math.round(Math.max(0, afterPct - monto) * 100) / 100
}
function totalLinea(pu, pct, monto, cant) {
  return Math.round(efectivoUnitario(pu, pct, monto) * cant * 100) / 100
}

function formatCarrito(c) {
  if (!c) return null
  const lineas = (c.lineas ?? []).map(l => {
    const pu  = Number(l.precioUnitario)
    const pct = Number(l.descuentoPorcentaje)
    const mon = Number(l.descuentoMonto)
    const eu  = efectivoUnitario(pu, pct, mon)
    return { ...l, precioUnitario: pu, descuentoPorcentaje: pct, descuentoMonto: mon, precioEfectivo: eu, subtotalLinea: Math.round(eu * l.cantidad * 100) / 100 }
  })
  const subtotal = Math.round(lineas.reduce((s, l) => s + l.subtotalLinea, 0) * 100) / 100
  const itbisAmt = c.applyItbis ? Math.round(subtotal * 0.18 * 100) / 100 : 0
  return { ...c, lineas, totales: { subtotal, itbis: itbisAmt, total: Math.round((subtotal + itbisAmt) * 100) / 100 } }
}

const lineaPOSSchema = z.object({
  productoId:          z.number().int().positive(),
  cantidad:            z.number().int().positive(),
  precioUnitario:      z.number().positive().optional(),
  descuentoPorcentaje: z.number().min(0).max(100).optional().default(0),
  descuentoMonto:      z.number().min(0).optional().default(0),
})

const facturaManualSchema = z.object({
  // Rigor Enterprise: clienteId OBLIGATORIO. Cero clientes walk-in / manuales.
  // Toda factura/cotización debe vincularse a un cliente real de la tabla Cliente.
  clienteId:    z.string().uuid({ message: 'clienteId es obligatorio (selecciona o crea un cliente en CRM).' }),
  itbis:        z.boolean().optional().default(true),
  diasVence:    z.number().int().min(0).max(365).optional().default(30),
  esCotizacion: z.boolean().optional().default(false),
  lineas:       z.array(lineaPOSSchema).min(1, 'Se requiere al menos una línea.'),
})

// Shared transaction: used by /api/facturas/manual and /api/carrito/checkout
// C2: puedeOverridePrecio gating + empleadoId trace.

// Auto-incrementador atómico de NCF (ConfiguracionNCF). Usado por NC/ND y facturas
// fiscales. Atómico vía UPDATE-RETURNING — concurrentes serializan en write-lock.
async function nextNomenclatura(tx, tipo) {
  const rows = await tx.$queryRaw`
    UPDATE "ConfiguracionNCF"
    SET    "secuenciaActual" = "secuenciaActual" + 1
    WHERE  "tipoNcf" = ${tipo}
    RETURNING "prefijo", "secuenciaActual"
  `;
  if (!rows || rows.length === 0) throw new Error(`Contador de nomenclatura "${tipo}" no encontrado.`);
  return `${rows[0].prefijo}${String(rows[0].secuenciaActual).padStart(3, '0')}`;
}

  return {
    buildFacturaPDFBuffer,
    nextNomenclatura,
    // Helpers de carrito (consumidos por modules/ventas/carrito/Blueprint).
    formatCarrito,
    efectivoUnitario,
    totalLinea,
    // generarSiguienteCodigo ya vive en server.js — accesible vía deps.
  };
};
