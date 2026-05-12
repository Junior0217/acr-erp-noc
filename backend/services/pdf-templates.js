/**
 * Plantillas HTML ultra-profesionales para PDFs de ACR.
 * Todo CSS inline (Puppeteer no carga assets externos sin networkidle).
 *
 * Convenciones:
 *   - Tipografía: Inter (system fallback)
 *   - Paleta: violeta corporativo #4f46e5 + slate-700 #334155 + accents
 *   - Densidad: una sola página Letter (Carta) hasta ~20 líneas de items
 */

function fmt(n) {
  return new Intl.NumberFormat('es-DO', {
    style: 'currency', currency: 'DOP',
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(Number(n) || 0).replace('DOP', 'RD$')
}

function fechaLarga(d) {
  return new Date(d).toLocaleDateString('es-DO', { day: 'numeric', month: 'long', year: 'numeric' })
}

function escape(s) {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

const BASE_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  @page { size: Letter; margin: 0; }
  html, body { font-family: 'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif;
    color: #1e293b; font-size: 10.5px; line-height: 1.35; -webkit-font-smoothing: antialiased; }
  .page { width: 100%; min-height: 100vh; padding: 0; background: white; position: relative; }
  .mono { font-family: ui-monospace, 'SF Mono', Menlo, 'Roboto Mono', monospace; }
  .text-emerald { color: #047857; } .text-violet { color: #4f46e5; }
  .text-slate-500 { color: #64748b; } .text-slate-700 { color: #334155; }
  .text-slate-900 { color: #0f172a; }

  /* Header con gradient corporativo */
  .header { background: linear-gradient(135deg, #4f46e5 0%, #6366f1 50%, #818cf8 100%);
    color: white; padding: 22px 32px 18px; position: relative; overflow: hidden; }
  .header::before { content: ''; position: absolute; top: -50%; right: -10%; width: 200px; height: 200%;
    background: radial-gradient(circle, rgba(255,255,255,0.12), transparent 60%); }
  .header-grid { display: grid; grid-template-columns: 1fr auto; gap: 20px; align-items: start; position: relative; z-index: 1; }
  .brand { display: flex; align-items: center; gap: 14px; }
  .logo-wrap { background: white; border-radius: 12px; padding: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    width: 64px; height: 64px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .logo-wrap img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .brand-text h1 { font-size: 16.5px; font-weight: 800; letter-spacing: -0.01em; line-height: 1.15;
    text-transform: uppercase; text-shadow: 0 1px 2px rgba(0,0,0,0.1); }
  .brand-text .slogan { font-size: 9.5px; opacity: 0.92; margin-top: 2px; line-height: 1.3; max-width: 320px; }
  .brand-text .meta { font-size: 9px; opacity: 0.85; margin-top: 6px; line-height: 1.5; }
  .doc-id { text-align: right; }
  .doc-id .label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.18em; opacity: 0.85; }
  .doc-id .number { font-size: 22px; font-weight: 800; letter-spacing: 0.02em; margin-top: 2px; text-shadow: 0 1px 2px rgba(0,0,0,0.1); }
  .doc-id .dates { font-size: 9px; margin-top: 8px; opacity: 0.9; line-height: 1.5; }

  /* Contenido */
  .body { padding: 18px 32px 12px; }
  .section-title { display: flex; align-items: center; gap: 7px; font-size: 9px;
    text-transform: uppercase; letter-spacing: 0.16em; color: #64748b; font-weight: 700; margin-bottom: 6px; }
  .section-title::before { content: ''; width: 3px; height: 13px; background: #4f46e5; border-radius: 2px; }
  .card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 14px; }
  .row-3 { display: grid; grid-template-columns: 1.4fr 0.9fr 1.6fr; gap: 14px; }
  .field-label { font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.1em; color: #64748b; font-weight: 600; }
  .field-value { font-size: 11.5px; color: #0f172a; font-weight: 600; margin-top: 1px; }
  .razon-social { font-size: 13.5px; font-weight: 700; color: #0f172a; }

  /* Tabla items */
  table.items { width: 100%; border-collapse: separate; border-spacing: 0; margin-top: 4px; }
  table.items thead th { background: #4f46e5; color: white; text-align: left;
    padding: 9px 10px; font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
  table.items thead th:first-child { border-radius: 6px 0 0 0; }
  table.items thead th:last-child  { border-radius: 0 6px 0 0; text-align: right; }
  table.items thead th.qty   { text-align: center; width: 48px; }
  table.items thead th.price { text-align: right; width: 90px; }
  table.items thead th.num   { text-align: center; width: 32px; }
  table.items tbody td { padding: 9px 10px; font-size: 10.5px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
  table.items tbody tr:nth-child(even) td { background: #fafbfc; }
  table.items tbody td.num    { text-align: center; color: #94a3b8; }
  table.items tbody td.qty    { text-align: center; }
  table.items tbody td.price  { text-align: right; font-weight: 500; }
  table.items tbody td.amount { text-align: right; font-weight: 700; color: #0f172a; }
  .item-name  { font-weight: 600; color: #0f172a; }
  .item-detail{ font-size: 9.5px; color: #64748b; margin-top: 2px; line-height: 1.35; }
  .item-sku   { font-size: 8.5px; color: #94a3b8; margin-top: 2px; }

  /* Totales */
  .totals { display: flex; justify-content: flex-end; margin-top: 12px; }
  .totals-box { width: 280px; }
  .tot-row { display: flex; justify-content: space-between; padding: 6px 12px; font-size: 10.5px;
    color: #475569; border-bottom: 1px solid #e2e8f0; }
  .tot-row.total { background: linear-gradient(135deg, #4f46e5, #6366f1); color: white;
    border: none; border-radius: 6px; padding: 10px 14px; margin-top: 4px; font-weight: 700; }
  .tot-row.total .num { font-size: 18px; font-weight: 800; }
  .tot-row.total .lbl { font-size: 10px; text-transform: uppercase; letter-spacing: 0.16em; }

  /* Condiciones */
  .conditions { margin-top: 14px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
  .cond-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 8px 10px; }
  .cond-card .lbl { font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.1em; color: #64748b; font-weight: 600; }
  .cond-card .val { font-size: 10px; color: #0f172a; font-weight: 600; margin-top: 2px; line-height: 1.4; }

  /* Firma */
  .signatures { display: flex; justify-content: space-between; align-items: flex-end;
    margin-top: 28px; padding: 0 12px; }
  .sig-block { flex: 1; max-width: 240px; text-align: center; }
  .sig-block.right { position: relative; }
  .sig-line { border-top: 1.5px solid #334155; margin-top: 36px; }
  .sig-line.long { margin-top: 14px; }
  .sig-name { font-size: 10.5px; font-weight: 700; color: #0f172a; margin-top: 4px;
    text-transform: uppercase; letter-spacing: 0.02em; white-space: nowrap; }
  .sig-cargo { font-size: 9px; color: #64748b; margin-top: 1px; }
  .firma-img { display: block; height: 38px; width: auto; max-width: 180px;
    margin: 0 auto -10px; object-fit: contain; opacity: 0.92; }
  .sello-img { position: absolute; top: -10px; right: -14px; height: 64px; width: auto; max-width: 80px;
    object-fit: contain; opacity: 0.65; transform: rotate(-8deg); pointer-events: none; }

  /* Footer */
  .footer { margin-top: 18px; padding: 10px 32px 14px; border-top: 1px solid #e2e8f0;
    display: flex; justify-content: space-between; font-size: 8.5px; color: #94a3b8; }
  .footer .left { display: flex; align-items: center; gap: 6px; }
  .footer .logo-mini { width: 14px; height: 14px; object-fit: contain; opacity: 0.6; }

  /* Watermark cancelado */
  .watermark { position: absolute; top: 35%; left: 50%; transform: translate(-50%, -50%) rotate(-22deg);
    font-size: 90px; font-weight: 900; color: #ef4444; opacity: 0.08; letter-spacing: 0.1em;
    text-transform: uppercase; pointer-events: none; z-index: 0; }

  .estado-badge { display: inline-block; padding: 3px 10px; border-radius: 12px; font-size: 9px;
    font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; }
  .estado-pagada   { background: #d1fae5; color: #047857; }
  .estado-emitida  { background: #dbeafe; color: #1e40af; }
  .estado-vencida  { background: #fee2e2; color: #b91c1c; }
  .estado-borrador { background: #f1f5f9; color: #475569; }
  .estado-anulada  { background: #fecaca; color: #991b1b; }
`

function renderDocumento(opts) {
  const {
    tipo,            // 'cotizacion' | 'factura'
    numero,          // string ej. 'COT-2026-0512-001' o 'B0100000123'
    empresa,         // EmpresaPerfil row
    cliente,         // { razonSocial, rnc, direccion, etc. }
    items,           // [{ descripcion, sku?, detalle?, cantidad, precioUnitario }]
    subtotal,
    itbis,
    total,
    fechaEmision,
    fechaVence,
    estado,          // 'Pagada' | 'Emitida' | 'Vencida' | 'Borrador' | 'Anulada'
    notas,
    condiciones,     // { validez, pago, entrega, garantia }
  } = opts

  const isFactura = tipo === 'factura'
  const tipoLabel = isFactura ? 'Factura' : 'Cotización'
  const repFull = [empresa.representanteNombre, empresa.representanteApellido].filter(Boolean).join(' ').toUpperCase()
  const direccionEmp = [empresa.direccion, empresa.sector, empresa.provincia].filter(Boolean).join(', ')
  const direccionCli = [cliente.direccion, cliente.sector, cliente.provincia].filter(Boolean).join(', ')
  const estadoClass = `estado-${(estado || 'borrador').toLowerCase()}`
  const showWatermark = estado === 'Anulada'

  const itemsRows = items.map((it, idx) => {
    const importe = Number(it.cantidad) * Number(it.precioUnitario)
    return `
      <tr>
        <td class="num">${String(idx + 1).padStart(2, '0')}</td>
        <td>
          <div class="item-name">${escape(it.descripcion)}</div>
          ${it.detalle ? `<div class="item-detail">${escape(it.detalle)}</div>` : ''}
          ${it.sku     ? `<div class="item-sku mono">SKU: ${escape(it.sku)}</div>` : ''}
        </td>
        <td class="qty mono">${it.cantidad}</td>
        <td class="price mono">${fmt(it.precioUnitario)}</td>
        <td class="amount mono">${fmt(importe)}</td>
      </tr>
    `
  }).join('')

  const condCards = condiciones ? `
    <div class="conditions">
      ${condiciones.validez  ? `<div class="cond-card"><div class="lbl">Validez</div><div class="val">${escape(condiciones.validez)}</div></div>`  : ''}
      ${condiciones.pago     ? `<div class="cond-card"><div class="lbl">Forma de Pago</div><div class="val">${escape(condiciones.pago)}</div></div>` : ''}
      ${condiciones.entrega  ? `<div class="cond-card"><div class="lbl">Entrega</div><div class="val">${escape(condiciones.entrega)}</div></div>` : ''}
      ${condiciones.garantia ? `<div class="cond-card"><div class="lbl">Garantía</div><div class="val">${escape(condiciones.garantia)}</div></div>` : ''}
    </div>
  ` : ''

  return `<!DOCTYPE html>
<html lang="es"><head>
  <meta charset="UTF-8"><title>${escape(tipoLabel)} ${escape(numero)}</title>
  <style>${BASE_CSS}</style>
</head><body>
<div class="page">

  ${showWatermark ? '<div class="watermark">ANULADA</div>' : ''}

  <header class="header">
    <div class="header-grid">
      <div class="brand">
        ${empresa.assets?.logoClaro ? `<div class="logo-wrap"><img src="${escape(empresa.assets.logoClaro)}" alt=""/></div>` : ''}
        <div class="brand-text">
          <h1>${escape(empresa.razonSocial)}</h1>
          ${empresa.eslogan ? `<div class="slogan">${escape(empresa.eslogan)}</div>` : ''}
          <div class="meta">
            <strong>RNC:</strong> <span class="mono">${escape(empresa.rnc)}</span>
            ${empresa.registroMercantil ? ` &nbsp;·&nbsp; <strong>RM:</strong> <span class="mono">${escape(empresa.registroMercantil)}</span>` : ''}
            <br/>
            ${direccionEmp ? escape(direccionEmp) : ''}
            <br/>
            ${empresa.telefono ? `📞 <span class="mono">${escape(empresa.telefono)}</span>` : ''}
            ${empresa.email    ? ` &nbsp;·&nbsp; ✉️ ${escape(empresa.email)}` : ''}
          </div>
        </div>
      </div>
      <div class="doc-id">
        <div class="label">${escape(tipoLabel)}</div>
        <div class="number mono">${escape(numero)}</div>
        <div class="dates">
          ${fechaEmision ? `Emisión: ${fechaLarga(fechaEmision)}<br/>` : ''}
          ${fechaVence   ? `${isFactura ? 'Vence' : 'Válida hasta'}: ${fechaLarga(fechaVence)}` : ''}
          ${estado ? `<br/><span class="estado-badge ${estadoClass}">${escape(estado)}</span>` : ''}
        </div>
      </div>
    </div>
  </header>

  <main class="body">

    <div class="section-title">Cliente</div>
    <div class="card">
      <div class="row-3">
        <div>
          <div class="field-label">Razón Social</div>
          <div class="razon-social">${escape(cliente.razonSocial)}</div>
        </div>
        <div>
          <div class="field-label">RNC / Cédula</div>
          <div class="field-value mono">${escape(cliente.rnc ?? cliente.cedula ?? '—')}</div>
        </div>
        <div>
          <div class="field-label">Dirección</div>
          <div class="field-value">${escape(direccionCli || '—')}</div>
        </div>
      </div>
    </div>

    <div class="section-title" style="margin-top:14px">Detalle de productos y servicios</div>
    <table class="items">
      <thead>
        <tr>
          <th class="num">#</th>
          <th>Descripción</th>
          <th class="qty">Cant.</th>
          <th class="price">P. Unit.</th>
          <th class="price">Importe</th>
        </tr>
      </thead>
      <tbody>${itemsRows}</tbody>
    </table>

    <div class="totals">
      <div class="totals-box">
        <div class="tot-row"><span>Subtotal</span><span class="mono">${fmt(subtotal)}</span></div>
        <div class="tot-row"><span>ITBIS (18%)</span><span class="mono">${fmt(itbis)}</span></div>
        <div class="tot-row total">
          <span class="lbl">Total</span>
          <span class="num mono">${fmt(total)}</span>
        </div>
      </div>
    </div>

    ${condCards}

    ${notas ? `<div style="margin-top:12px; padding:10px 14px; background:#fef3c7; border-left:3px solid #f59e0b; border-radius:4px; font-size:9.5px; color:#78350f;"><strong>Notas:</strong> ${escape(notas)}</div>` : ''}

    <div class="signatures">
      <div class="sig-block">
        <div class="sig-line"></div>
        <div class="sig-name">Aceptación del Cliente</div>
        <div class="sig-cargo">Firma y sello</div>
      </div>
      <div class="sig-block right">
        ${empresa.assets?.firmaGerente ? `<img src="${escape(empresa.assets.firmaGerente)}" alt="" class="firma-img"/>` : ''}
        <div class="sig-line long"></div>
        <div class="sig-name">${escape(repFull || '—')}</div>
        <div class="sig-cargo">${escape(empresa.representanteCargo ?? 'Gerente')} · ${escape(empresa.razonSocial)}</div>
        ${empresa.assets?.selloFisico ? `<img src="${escape(empresa.assets.selloFisico)}" alt="" class="sello-img"/>` : ''}
      </div>
    </div>

  </main>

  <footer class="footer">
    <div class="left">
      ${empresa.assets?.logoClaro ? `<img src="${escape(empresa.assets.logoClaro)}" class="logo-mini" alt=""/>` : ''}
      <span>${escape(empresa.razonSocial)} · RNC <span class="mono">${escape(empresa.rnc)}</span>${empresa.sector ? ` · ${escape(empresa.sector)}, ${escape(empresa.provincia ?? '')}` : ''}</span>
    </div>
    <div class="mono">Generado: ${fechaLarga(new Date())}</div>
  </footer>

</div>
</body></html>`
}

module.exports = { renderDocumento, fmt, fechaLarga }
