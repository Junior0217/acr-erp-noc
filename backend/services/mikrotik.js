'use strict';

// ─── MikroTik RouterOS Address-List Sync ─────────────────────────────────────
//
// Controls client morosidad via RouterOS Address Lists.
// Set MIKROTIK_DRY_RUN=false + MIKROTIK_HOST/USER/PASS to go live.
//
// Address list strategy:
//   estado = 'activo'  → remove from MOROSOS list (re-enables internet)
//   estado = 'moroso'  → add to MOROSOS list (blocked by firewall rule)
//
// Firewall rule (add once on router):
//   /ip firewall filter add chain=forward src-address-list=morosos action=drop comment="ERP-mora"

const DRY_RUN      = process.env.MIKROTIK_DRY_RUN !== 'false'
const MT_HOST      = process.env.MIKROTIK_HOST || '192.168.88.1'
const MT_PORT      = parseInt(process.env.MIKROTIK_PORT || '8728')
const MT_USER      = process.env.MIKROTIK_USER || 'admin'
const MT_PASS      = process.env.MIKROTIK_PASS || ''
const LISTA_MOROSOS = process.env.MIKROTIK_LISTA_MOROSOS || 'morosos'

/**
 * Sync a client IP against RouterOS Address Lists.
 * @param {string} ip     - Client's WAN or CPE IP address
 * @param {'activo'|'moroso'} estado
 */
async function syncMikrotik(ip, estado) {
  if (!ip || !ip.trim()) return

  if (DRY_RUN) {
    console.log(`\x1b[36m[MIKROTIK SANDBOX]\x1b[0m Cliente IP \x1b[33m${ip}\x1b[0m movido a estado: \x1b[32m${estado}\x1b[0m`)
    return
  }

  // ── Real RouterOS connection ─────────────────────────────────────────────
  const { RouterOSAPI } = require('node-routeros')
  const conn = new RouterOSAPI({ host: MT_HOST, port: MT_PORT, user: MT_USER, password: MT_PASS, timeout: 10 })

  try {
    await conn.connect()

    if (estado === 'moroso') {
      // Check if already in list to keep idempotent
      const existing = await conn.write('/ip/firewall/address-list/print', [
        `?list=${LISTA_MOROSOS}`, `?address=${ip}`,
      ])
      if (existing.length === 0) {
        await conn.write('/ip/firewall/address-list/add', [
          `=list=${LISTA_MOROSOS}`, `=address=${ip}`, `=comment=ERP-mora-auto`,
        ])
        console.log(`[MIKROTIK LIVE] ${ip} → MOROSOS list (bloqueado)`)
      }
    } else if (estado === 'activo') {
      // Remove all entries for this IP from the morosos list
      const entries = await conn.write('/ip/firewall/address-list/print', [
        `?list=${LISTA_MOROSOS}`, `?address=${ip}`,
      ])
      for (const e of entries) {
        await conn.write('/ip/firewall/address-list/remove', [`=.id=${e['.id']}`])
      }
      if (entries.length > 0) console.log(`[MIKROTIK LIVE] ${ip} → removido de MOROSOS (reactivado)`)
    }
  } catch (err) {
    console.error(`[MIKROTIK ERROR] ${ip} → ${estado}: ${err.message}`)
  } finally {
    try { conn.close() } catch {}
  }
}

module.exports = { syncMikrotik }
