/**
 * Plantillas HTML corporativas para Facturas y Cotizaciones.
 *
 * Cero hardcode: todos los datos de empresa salen de `EmpresaPerfil` (singleton id=1).
 * Diseño: encabezado tipo banco con banda corporativa, tabla densa con header oscuro,
 * totales contables, firma con superposición elegante de sello + firma escaneada.
 *
 * Paleta:
 *   Corporate dark   #0f172a   (slate-900)
 *   Corporate accent #1e40af   (blue-800)
 *   Slate            #475569 / #64748b / #94a3b8
 *   Border           #e2e8f0
 *   Bg-zebra         #f8fafc
 *
 * Convenciones:
 *   - Letter (8.5×11"), márgenes manejados internamente (Puppeteer margin: 0)
 *   - Una sola página hasta ~18 líneas; tabla rompe limpio si excede
 *   - Sin emojis, sin texto decorativo: estilo banco corporativo
 */

function fmtMoney(n) {
  return new Intl.NumberFormat('es-DO', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(Number(n) || 0)
}

function fechaCorta(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function fechaLarga(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('es-DO', { day: 'numeric', month: 'long', year: 'numeric' })
}

function escape(s) {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function buildDireccion(parts) {
  return parts.filter(Boolean).map(p => String(p).trim()).filter(Boolean).join(', ')
}

const CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
@page { size: Letter; margin: 0; }
html, body {
  font-family: 'Inter', 'Helvetica Neue', 'Segoe UI', Arial, sans-serif;
  color: #0f172a; font-size: 10px; line-height: 1.4;
  -webkit-font-smoothing: antialiased; -webkit-print-color-adjust: exact; print-color-adjust: exact;
  background: white;
}
.mono { font-family: 'SF Mono', 'JetBrains Mono', 'Consolas', ui-monospace, monospace; font-variant-numeric: tabular-nums; }
.tabular { font-variant-numeric: tabular-nums; }

/* ───── Page wrapper ───── */
.sheet {
  width: 8.5in; min-height: 11in;
  padding: 0; position: relative; overflow: hidden;
}

/* ───── Top corporate band ───── */
.band {
  height: 6px; width: 100%;
  background: linear-gradient(90deg, #0f172a 0%, #1e40af 55%, #3b82f6 100%);
}

/* ───── Header ───── */
.header {
  display: grid; grid-template-columns: 1fr 1fr;
  padding: 22px 36px 18px;
  border-bottom: 1px solid #e2e8f0;
  gap: 24px;
  align-items: center;
}
.brand { display: flex; align-items: center; gap: 14px; }
.logo {
  width: 86px; height: 86px;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.logo img { max-width: 100%; max-height: 100%; object-fit: contain; }
.brand-info .razon { font-size: 14.5px; font-weight: 800; color: #0f172a; letter-spacing: -0.005em; line-height: 1.15; }
.brand-info .nombre-comercial { font-size: 10px; color: #1e40af; font-weight: 600; margin-top: 2px; letter-spacing: 0.02em; text-transform: uppercase; }
.brand-info .eslogan { font-size: 9px; color: #64748b; margin-top: 3px; font-style: italic; max-width: 260px; }

.corp-meta { text-align: right; font-size: 9.5px; color: #475569; line-height: 1.55; }
.corp-meta .row { display: flex; justify-content: flex-end; align-items: baseline; gap: 6px; }
.corp-meta .lbl { color: #94a3b8; font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 700; min-width: 56px; text-align: right; }
.corp-meta .val { color: #0f172a; font-weight: 600; }

/* ───── Document title bar ───── */
.title-bar {
  background: #0f172a;
  color: white;
  padding: 14px 36px;
  display: grid; grid-template-columns: 1fr auto; align-items: center;
  gap: 20px;
}
.doc-type {
  font-size: 19px; font-weight: 800; letter-spacing: 0.1em;
  text-transform: uppercase;
}
.doc-type .sub { font-size: 9px; font-weight: 500; opacity: 0.65; letter-spacing: 0.16em; display: block; margin-top: 2px; }
.doc-meta { text-align: right; font-size: 10px; line-height: 1.55; }
.doc-meta .num {
  font-size: 14px; font-weight: 800; letter-spacing: 0.04em;
  background: rgba(255,255,255,0.10); padding: 4px 10px; border-radius: 4px;
  display: inline-block;
}
.doc-meta .ncf {
  font-size: 10.5px; margin-top: 4px; font-weight: 700;
  color: #93c5fd; letter-spacing: 0.05em;
}
.doc-meta .tipo-ncf { font-size: 8px; opacity: 0.6; text-transform: uppercase; letter-spacing: 0.12em; }

.estado-stamp {
  display: inline-block; margin-top: 6px;
  padding: 3px 10px; border-radius: 3px;
  font-size: 9px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.12em;
}
.estado-Pagada   { background: #064e3b; color: #6ee7b7; }
.estado-Emitida  { background: #1e3a8a; color: #93c5fd; }
.estado-Vencida  { background: #7f1d1d; color: #fca5a5; }
.estado-Borrador { background: #334155; color: #cbd5e1; }
.estado-Anulada  { background: #450a0a; color: #fecaca; }

/* ───── Sections ───── */
.body { padding: 18px 36px 12px; }
.section-label {
  font-size: 8.5px; font-weight: 800; color: #1e40af;
  text-transform: uppercase; letter-spacing: 0.18em;
  margin-bottom: 6px;
  display: flex; align-items: center; gap: 8px;
}
.section-label::after {
  content: ''; flex: 1; height: 1px; background: #e2e8f0;
}

/* ───── Client block ───── */
.client-grid {
  display: grid; grid-template-columns: 1.6fr 1fr 1fr;
  gap: 0;
  border: 1px solid #e2e8f0; border-radius: 4px;
  overflow: hidden;
}
.client-cell {
  padding: 9px 13px;
  border-right: 1px solid #e2e8f0;
  background: #f8fafc;
}
.client-cell:last-child { border-right: none; }
.client-cell .lbl {
  font-size: 7.5px; color: #64748b; text-transform: uppercase;
  letter-spacing: 0.14em; font-weight: 700; margin-bottom: 3px;
}
.client-cell .val {
  font-size: 11px; color: #0f172a; font-weight: 700; line-height: 1.3;
}
.client-cell .val.normal { font-weight: 500; font-size: 10px; line-height: 1.4; }

/* ───── Items table ───── */
.items {
  width: 100%; margin-top: 16px;
  border-collapse: separate; border-spacing: 0;
  border: 1px solid #cbd5e1; border-radius: 4px; overflow: hidden;
}
.items thead th {
  background: #0f172a; color: white;
  padding: 9px 10px;
  font-size: 9px; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.1em;
  text-align: left;
  border-bottom: 2px solid #1e40af;
}
.items thead th.center { text-align: center; }
.items thead th.right  { text-align: right; }
.items thead th.col-num  { width: 30px; text-align: center; }
.items thead th.col-cant { width: 56px; text-align: center; }
.items thead th.col-pu   { width: 90px; text-align: right; }
.items thead th.col-amt  { width: 100px; text-align: right; }
.items tbody td {
  padding: 8px 10px;
  font-size: 10px;
  border-bottom: 1px solid #f1f5f9;
  vertical-align: top;
}
.items tbody tr:last-child td { border-bottom: none; }
.items tbody tr:nth-child(even) td { background: #f8fafc; }
.items tbody td.center { text-align: center; }
.items tbody td.right  { text-align: right; }
.items tbody td.num    { color: #94a3b8; font-size: 9px; }
.items .desc-main { color: #0f172a; font-weight: 600; line-height: 1.35; }
.items .desc-sub  { color: #64748b; font-size: 8.5px; margin-top: 2px; line-height: 1.4; }
.items .sku       { color: #94a3b8; font-size: 8px; margin-top: 2px; letter-spacing: 0.04em; }

/* ───── Totals ───── */
.totals-wrap {
  display: grid; grid-template-columns: 1fr 280px;
  gap: 20px; margin-top: 14px;
}
.legal-note {
  font-size: 8.5px; color: #64748b; line-height: 1.55;
  padding: 10px 12px; background: #f8fafc;
  border: 1px solid #e2e8f0; border-radius: 4px;
}
.legal-note .ttl { font-size: 9px; font-weight: 800; color: #0f172a; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 4px; }
.totals {
  border: 1px solid #e2e8f0; border-radius: 4px; overflow: hidden;
}
.tot-row {
  display: flex; justify-content: space-between; align-items: center;
  padding: 7px 14px;
  font-size: 10px;
  border-bottom: 1px solid #f1f5f9;
}
.tot-row:last-child { border-bottom: none; }
.tot-row .lbl { color: #475569; font-weight: 600; text-transform: uppercase; font-size: 9px; letter-spacing: 0.08em; }
.tot-row .val { color: #0f172a; font-weight: 700; }
.tot-row.grand {
  background: #0f172a; color: white;
  padding: 11px 14px;
}
.tot-row.grand .lbl { color: white; font-size: 10px; font-weight: 800; letter-spacing: 0.12em; }
.tot-row.grand .val { color: white; font-size: 14px; font-weight: 800; letter-spacing: 0.02em; }

/* ───── Conditions ───── */
.cond-grid {
  display: grid; grid-template-columns: repeat(4, 1fr);
  gap: 6px; margin-top: 14px;
}
.cond-cell {
  border: 1px solid #e2e8f0; border-left: 3px solid #1e40af;
  padding: 7px 10px;
  background: #f8fafc;
  border-radius: 3px;
}
.cond-cell .lbl { font-size: 7.5px; color: #64748b; text-transform: uppercase; letter-spacing: 0.12em; font-weight: 700; }
.cond-cell .val { font-size: 9.5px; color: #0f172a; font-weight: 600; margin-top: 2px; line-height: 1.4; }

.notes {
  margin-top: 12px;
  padding: 10px 14px;
  background: #fffbeb; border-left: 3px solid #d97706;
  border-radius: 3px;
  font-size: 9.5px; color: #78350f; line-height: 1.5;
}
.notes .ttl { font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; font-size: 8.5px; margin-bottom: 2px; color: #92400e; }

/* ───── Signatures ───── */
.sigs {
  display: grid; grid-template-columns: 1fr 1fr;
  gap: 80px;
  margin-top: 36px;
  padding: 0 12px;
}
.sig-block { position: relative; text-align: center; }
.sig-stack { position: relative; min-height: 64px; }
.sig-firma {
  position: absolute; left: 50%; bottom: 2px;
  transform: translateX(-50%);
  max-height: 56px; max-width: 200px;
  opacity: 0.92;
  z-index: 2;
}
.sig-sello {
  position: absolute; right: 0; bottom: -8px;
  width: 92px; height: 92px;
  object-fit: contain;
  opacity: 0.58;
  transform: rotate(-9deg);
  mix-blend-mode: multiply;
  z-index: 1;
  pointer-events: none;
}
.sig-line {
  border-top: 1.2px solid #0f172a;
  margin-top: 4px;
}
.sig-name {
  margin-top: 5px;
  font-size: 10px; font-weight: 800; color: #0f172a;
  text-transform: uppercase; letter-spacing: 0.04em;
}
.sig-role {
  font-size: 8.5px; color: #64748b; margin-top: 1px;
  letter-spacing: 0.04em;
}

/* ───── Footer ───── */
.footer {
  position: absolute; left: 0; right: 0; bottom: 0;
  padding: 10px 36px 14px;
  border-top: 1px solid #e2e8f0;
  display: grid; grid-template-columns: 1fr auto 1fr;
  align-items: center;
  font-size: 7.5px; color: #94a3b8;
  background: white;
}
.footer .left  { text-align: left; }
.footer .ctr   { text-align: center; font-weight: 700; color: #475569; letter-spacing: 0.06em; text-transform: uppercase; font-size: 7.5px; }
.footer .right { text-align: right; }

/* ───── Watermark ANULADA ───── */
.watermark {
  position: absolute;
  top: 42%; left: 50%; transform: translate(-50%, -50%) rotate(-20deg);
  font-size: 130px; font-weight: 900;
  color: #ef4444; opacity: 0.07;
  letter-spacing: 0.08em; text-transform: uppercase;
  pointer-events: none; z-index: 5;
}
.watermark.cotizacion {
  color: #1e40af; opacity: 0.045; font-size: 110px;
}
`

function renderDocumento(opts) {
  const {
    tipo,            // 'cotizacion' | 'factura'
    numero,          // string ej. 'COT-2026-0512-001'
    ncf,             // factura NCF (opt)
    tipoNcf,         // 'B01' / 'B02' / etc.
    empresa,         // EmpresaPerfil row (NO defaults: si falta algo, oculta esa sección)
    cliente,         // { razonSocial, rnc, direccion, sector, provincia, telefono, email }
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

  const emp = empresa ?? {}
  const assets = emp.assets ?? {}
  const repFull = [emp.representanteNombre, emp.representanteApellido].filter(Boolean).join(' ').trim()
  const direccionEmp = buildDireccion([emp.direccion, emp.sector, emp.provincia])
  const direccionCli = buildDireccion([cliente?.direccion, cliente?.sector, cliente?.provincia])

  const watermark = estado === 'Anulada'
    ? '<div class="watermark">Anulada</div>'
    : (!isFactura ? '<div class="watermark cotizacion">Cotización</div>' : '')

  const itemsRows = (items ?? []).map((it, idx) => {
    const importe = Number(it.cantidad) * Number(it.precioUnitario)
    return `<tr>
      <td class="num center">${String(idx + 1).padStart(2, '0')}</td>
      <td>
        <div class="desc-main">${escape(it.descripcion)}</div>
        ${it.detalle ? `<div class="desc-sub">${escape(it.detalle)}</div>` : ''}
        ${it.sku     ? `<div class="sku mono">SKU · ${escape(it.sku)}</div>` : ''}
      </td>
      <td class="center mono">${Number(it.cantidad).toLocaleString('es-DO')}</td>
      <td class="right mono">${fmtMoney(it.precioUnitario)}</td>
      <td class="right mono"><strong>${fmtMoney(importe)}</strong></td>
    </tr>`
  }).join('')

  const cond = condiciones ?? {}
  const condCards = (cond.validez || cond.pago || cond.entrega || cond.garantia) ? `
    <div class="cond-grid">
      ${cond.validez  ? `<div class="cond-cell"><div class="lbl">Validez</div><div class="val">${escape(cond.validez)}</div></div>`  : ''}
      ${cond.pago     ? `<div class="cond-cell"><div class="lbl">Forma de Pago</div><div class="val">${escape(cond.pago)}</div></div>` : ''}
      ${cond.entrega  ? `<div class="cond-cell"><div class="lbl">Entrega</div><div class="val">${escape(cond.entrega)}</div></div>` : ''}
      ${cond.garantia ? `<div class="cond-cell"><div class="lbl">Garantía</div><div class="val">${escape(cond.garantia)}</div></div>` : ''}
    </div>` : ''

  const corpRows = [
    emp.rnc                ? `<div class="row"><span class="lbl">RNC</span><span class="val mono">${escape(emp.rnc)}</span></div>` : '',
    emp.registroMercantil  ? `<div class="row"><span class="lbl">RM</span><span class="val mono">${escape(emp.registroMercantil)}</span></div>` : '',
    direccionEmp           ? `<div class="row"><span class="lbl">Dirección</span><span class="val">${escape(direccionEmp)}</span></div>` : '',
    emp.telefono           ? `<div class="row"><span class="lbl">Tel.</span><span class="val mono">${escape(emp.telefono)}</span></div>` : '',
    emp.email              ? `<div class="row"><span class="lbl">Email</span><span class="val">${escape(emp.email)}</span></div>` : '',
    emp.website            ? `<div class="row"><span class="lbl">Web</span><span class="val">${escape(emp.website)}</span></div>` : '',
  ].filter(Boolean).join('')

  const legalNote = isFactura
    ? `<div class="legal-note">
        <div class="ttl">Información Fiscal</div>
        Esta factura cumple con el reglamento del Decreto 254-06 y la Norma General 06-2018 de la DGII.
        Verifica el NCF en <strong>dgii.gov.do/consultas</strong>.
        ${ncf ? `Comprobante: <strong class="mono">${escape(ncf)}</strong>${tipoNcf ? ` (${escape(tipoNcf)})` : ''}.` : ''}
      </div>`
    : `<div class="legal-note">
        <div class="ttl">Condiciones Generales</div>
        Esta cotización tiene carácter informativo y no constituye documento fiscal.
        Los precios pueden estar sujetos a cambio sin previo aviso fuera del período de validez.
        Para emisión de factura formal con NCF se requiere confirmación por escrito.
      </div>`

  const numeroPrincipal = isFactura ? (ncf || numero) : numero
  const numeroSecundario = isFactura && ncf ? numero : null

  return `<!DOCTYPE html>
<html lang="es"><head>
  <meta charset="UTF-8"><title>${escape(tipoLabel)} ${escape(numero)}</title>
  <style>${CSS}</style>
</head><body>
<div class="sheet">

  <div class="band"></div>
  ${watermark}

  <header class="header">
    <div class="brand">
      ${assets.logoClaro ? `<div class="logo"><img src="${escape(assets.logoClaro)}" alt=""/></div>` : ''}
      <div class="brand-info">
        <div class="razon">${escape(emp.razonSocial ?? '—')}</div>
        ${emp.nombreComercial ? `<div class="nombre-comercial">${escape(emp.nombreComercial)}</div>` : ''}
        ${emp.eslogan ? `<div class="eslogan">${escape(emp.eslogan)}</div>` : ''}
      </div>
    </div>
    <div class="corp-meta">${corpRows}</div>
  </header>

  <div class="title-bar">
    <div class="doc-type">
      ${escape(tipoLabel)}
      <span class="sub">${isFactura ? 'Comprobante Fiscal · República Dominicana' : 'Propuesta Comercial'}</span>
    </div>
    <div class="doc-meta">
      <div class="num mono">${escape(numeroPrincipal)}</div>
      ${isFactura && ncf ? `<div class="tipo-ncf">NCF${tipoNcf ? ` · ${escape(tipoNcf)}` : ''}</div>` : ''}
      ${numeroSecundario ? `<div class="ncf mono" style="opacity:0.7;">${escape(numeroSecundario)}</div>` : ''}
      <div style="margin-top:6px; font-size:9px; opacity:0.85;">
        Emisión: <strong>${fechaCorta(fechaEmision)}</strong>
        ${fechaVence ? ` · ${isFactura ? 'Vence' : 'Válida hasta'}: <strong>${fechaCorta(fechaVence)}</strong>` : ''}
      </div>
      ${estado ? `<span class="estado-stamp estado-${escape(estado)}">${escape(estado)}</span>` : ''}
    </div>
  </div>

  <main class="body">

    <div class="section-label">${isFactura ? 'Facturar a' : 'Cliente'}</div>
    <div class="client-grid">
      <div class="client-cell">
        <div class="lbl">Razón Social</div>
        <div class="val">${escape(cliente?.razonSocial ?? 'Consumidor Final')}</div>
        ${cliente?.noCliente ? `<div class="val normal mono" style="margin-top:3px; color:#475569;">${escape(cliente.noCliente)}</div>` : ''}
      </div>
      <div class="client-cell">
        <div class="lbl">${cliente?.rnc ? 'RNC' : 'Cédula'}</div>
        <div class="val mono">${escape(cliente?.rnc ?? cliente?.cedula ?? '—')}</div>
        ${cliente?.telefono ? `<div class="val normal mono" style="margin-top:3px; color:#475569;">Tel. ${escape(cliente.telefono)}</div>` : ''}
      </div>
      <div class="client-cell">
        <div class="lbl">Dirección</div>
        <div class="val normal">${escape(direccionCli || '—')}</div>
        ${cliente?.email ? `<div class="val normal" style="margin-top:3px; color:#475569;">${escape(cliente.email)}</div>` : ''}
      </div>
    </div>

    <div style="margin-top:16px;" class="section-label">Detalle de productos y servicios</div>
    <table class="items">
      <thead>
        <tr>
          <th class="col-num">#</th>
          <th>Descripción</th>
          <th class="col-cant center">Cant.</th>
          <th class="col-pu right">Precio Unit.</th>
          <th class="col-amt right">Importe</th>
        </tr>
      </thead>
      <tbody>${itemsRows || `<tr><td colspan="5" style="text-align:center; padding:20px; color:#94a3b8;">Sin líneas de detalle.</td></tr>`}</tbody>
    </table>

    <div class="totals-wrap">
      ${legalNote}
      <div class="totals">
        <div class="tot-row">
          <span class="lbl">Subtotal</span>
          <span class="val mono">RD$ ${fmtMoney(subtotal)}</span>
        </div>
        ${Number(itbis) > 0 ? `
        <div class="tot-row">
          <span class="lbl">ITBIS (18%)</span>
          <span class="val mono">RD$ ${fmtMoney(itbis)}</span>
        </div>` : `
        <div class="tot-row">
          <span class="lbl">ITBIS</span>
          <span class="val mono" style="color:#94a3b8;">Exento</span>
        </div>`}
        <div class="tot-row grand">
          <span class="lbl">Total</span>
          <span class="val mono">RD$ ${fmtMoney(total)}</span>
        </div>
      </div>
    </div>

    ${condCards}

    ${notas ? `<div class="notes"><div class="ttl">Notas</div>${escape(notas)}</div>` : ''}

    <div class="sigs">
      <div class="sig-block">
        <div class="sig-stack"></div>
        <div class="sig-line"></div>
        <div class="sig-name">Aceptación del Cliente</div>
        <div class="sig-role">Firma · Sello · Fecha</div>
      </div>
      <div class="sig-block">
        <div class="sig-stack">
          ${assets.firmaGerente ? `<img class="sig-firma" src="${escape(assets.firmaGerente)}" alt=""/>` : ''}
          ${assets.selloFisico  ? `<img class="sig-sello" src="${escape(assets.selloFisico)}" alt=""/>` : ''}
        </div>
        <div class="sig-line"></div>
        <div class="sig-name">${escape(repFull || emp.razonSocial || 'Autorizado')}</div>
        <div class="sig-role">${escape(emp.representanteCargo ?? 'Representante')}${emp.razonSocial ? ` · ${escape(emp.razonSocial)}` : ''}</div>
      </div>
    </div>

  </main>

  <footer class="footer">
    <div class="left">
      ${escape(emp.razonSocial ?? '')}${emp.rnc ? ` · RNC <span class="mono">${escape(emp.rnc)}</span>` : ''}
    </div>
    <div class="ctr">Documento Electrónico Verificable</div>
    <div class="right mono">${fechaLarga(new Date())}</div>
  </footer>

</div>
</body></html>`
}

module.exports = { renderDocumento, fmtMoney, fechaLarga, fechaCorta }
