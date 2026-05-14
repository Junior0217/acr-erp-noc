/**
 * ALERTA STOCK — WhatsApp Cloud API stub
 *
 * Detecta productos con stockActual <= stockMinimo y notifica a Carmelo.
 * Sin credenciales (WHATSAPP_TOKEN + WHATSAPP_PHONE_ID + WHATSAPP_TO):
 * solo imprime el mensaje que mandaría.
 *
 * Setup:
 *   1. https://developers.facebook.com/apps → crea app → añade producto WhatsApp
 *   2. Copia el token temporal o genera permanent token con permisos whatsapp_business_messaging
 *   3. Define en .env:
 *        WHATSAPP_TOKEN=EAAxxxx...
 *        WHATSAPP_PHONE_ID=123456789012345
 *        WHATSAPP_TO=18094589955
 *
 * Cron sugerido (Render):
 *   *\/30 * * * *  node backend/scripts/alerta-stock.js
 */
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()

const args = process.argv.slice(2)
const DRY = args.includes('--dry-run')

async function enviarWhatsApp(mensaje) {
  const token = process.env.WHATSAPP_TOKEN
  const phoneId = process.env.WHATSAPP_PHONE_ID
  const to = process.env.WHATSAPP_TO
  if (!token || !phoneId || !to) {
    console.log('  [STUB] WhatsApp no configurado. Mensaje hubiera sido:\n  ' + mensaje.split('\n').join('\n  '))
    return { stub: true }
  }
  try {
    const r = await fetch(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: mensaje },
      }),
    })
    const j = await r.json()
    if (!r.ok) { console.error('  [WA ERROR]', j); return { ok: false, error: j } }
    console.log('  ✓ Enviado WhatsApp id=' + (j.messages?.[0]?.id ?? 'sin id'))
    return { ok: true }
  } catch (e) {
    console.error('  [WA EXCEPTION]', e.message)
    return { ok: false, error: e.message }
  }
}

;(async () => {
  console.log('\n══ ALERTA STOCK ACR ════════════════════════════════════')
  const criticos = await p.producto.findMany({
    where:   { stockActual: { lte: p.producto.fields ? undefined : 0 } }, // safe fallback
    select:  { id: true, sku: true, nombre: true, stockActual: true, stockMinimo: true },
    orderBy: { stockActual: 'asc' },
  }).then(async (todos) => {
    // Re-filtro manual: stockActual <= stockMinimo (no se puede comparar campos via Prisma sin raw).
    const all = await p.producto.findMany({ select: { id: true, sku: true, nombre: true, stockActual: true, stockMinimo: true }, orderBy: { stockActual: 'asc' } })
    return all.filter(x => x.stockActual <= x.stockMinimo)
  })

  if (criticos.length === 0) {
    console.log('  ✓ Sin productos en stock crítico.')
    await p.$disconnect()
    return
  }

  console.log(`  ⚠ ${criticos.length} producto(s) en stock crítico:`)
  for (const prod of criticos.slice(0, 20)) {
    console.log(`     ${prod.sku.padEnd(18)} ${prod.nombre.slice(0, 40).padEnd(40)} · stock=${prod.stockActual} (min ${prod.stockMinimo})`)
  }

  const mensaje =
    `⚠️ ACR Stock Crítico (${criticos.length} items)\n\n` +
    criticos.slice(0, 8).map(c => `• ${c.nombre}: ${c.stockActual} und. (mín ${c.stockMinimo})`).join('\n') +
    (criticos.length > 8 ? `\n• ... y ${criticos.length - 8} más` : '') +
    `\n\nReordenar o ajustar mínimos.\nERP: https://acr-erp-noc.vercel.app/inventario`

  if (DRY) {
    console.log('\n  [DRY-RUN] Mensaje preview:\n  ' + mensaje.split('\n').join('\n  '))
  } else {
    console.log('\n  Enviando WhatsApp...')
    await enviarWhatsApp(mensaje)
  }

  console.log('\n══ DONE ══════════════════════════════════════════════════')
  await p.$disconnect()
})().catch(e => { console.error('\n[ALERTA STOCK ERROR]', e); process.exit(1) })
