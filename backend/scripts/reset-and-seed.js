/**
 * RESET + RE-SEED MASIVO
 *
 * Borra TODA la data transaccional y de catálogo en orden FK-safe.
 * Preserva (zero riesgo de bloqueo administrativo):
 *   - Empleado        (Carmelo + Cristian + SEED users mantienen acceso)
 *   - Rol             (RBAC intacto)
 *   - AuditLog        (forense histórica — append-only por seguridad)
 *   - IpBlock         (bloqueos activos por brute-force)
 *   - ConfiguracionNCF(secuencia DGII no se reinicia arbitrariamente)
 *   - SessionToken    (sesiones activas, no kickear)
 *   - PortalSettings  (configuración del portal)
 *   - WebAuthnCredential (2FA hardware si existiera)
 *
 * Luego ejecuta mega-seed.js para repoblar todo.
 *
 * Uso:
 *   node backend/scripts/reset-and-seed.js
 *   node backend/scripts/reset-and-seed.js --skip-seed  (solo borrar)
 *   node backend/scripts/reset-and-seed.js --yes        (sin confirmación)
 */
const { PrismaClient } = require('@prisma/client')
const { spawnSync }    = require('child_process')
const readline         = require('readline')
const path             = require('path')

const p = new PrismaClient()
const args = process.argv.slice(2)
const SKIP_SEED = args.includes('--skip-seed')
const AUTO_YES  = args.includes('--yes')

function ask(q) {
  return new Promise(res => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(q, ans => { rl.close(); res(ans) })
  })
}

// Orden FK-safe: hojas (sin dependientes) → raíces.
// Cada paso es un deleteMany con conteo previo para feedback.
const DELETE_ORDER = [
  // ── Tablas de seguridad/anti-fraude (hojas) ──
  { model: 'ordenFoto',                label: 'OrdenFoto'                 },
  { model: 'incidenciaReconciliacion', label: 'IncidenciaReconciliacion'  },
  { model: 'activoCliente',            label: 'ActivoCliente'             },
  { model: 'equipoPrestamo',           label: 'EquipoPrestamo'            },
  { model: 'credencialCliente',        label: 'CredencialCliente'         },
  { model: 'ticketTaller',             label: 'TicketTaller'              },

  // ── Carritos POS ──
  { model: 'lineaCarrito',             label: 'LineaCarrito'              },
  { model: 'carritoTemp',              label: 'CarritoTemp'               },

  // ── Facturación ──
  { model: 'lineaFactura',             label: 'LineaFactura'              },
  { model: 'factura',                  label: 'Factura'                   },

  // ── Órdenes de trabajo (modelo nuevo) ──
  { model: 'lineaOrdenTrabajo',        label: 'LineaOrdenTrabajo'         },
  { model: 'ordenTrabajo',             label: 'OrdenTrabajo'              },

  // ── Órdenes de instalación (modelo legacy) ──
  { model: 'detalleOrden',             label: 'DetalleOrden'              },
  { model: 'ordenInstalacion',         label: 'OrdenInstalacion'          },

  // ── Servicios contratados ──
  { model: 'servicio',                 label: 'Servicio'                  },

  // ── Portal B2C ──
  { model: 'usuarioPortal',            label: 'UsuarioPortal'             },

  // ── CRM ──
  { model: 'prospecto',                label: 'Prospecto'                 },
  { model: 'suplidor',                 label: 'Suplidor'                  },
  { model: 'cliente',                  label: 'Cliente'                   },

  // ── Catálogo ──
  { model: 'itemCatalogo',             label: 'ItemCatalogo'              },
  { model: 'plantillaEquipo',          label: 'PlantillaEquipo'           },
  { model: 'plan',                     label: 'Plan'                      },

  // ── Inventario ──
  { model: 'movimientoInventario',     label: 'MovimientoInventario'      },
  { model: 'producto',                 label: 'Producto'                  },
  { model: 'categoria',                label: 'Categoria'                 },

  // ── RRHH transaccional (Asistencia se borra, Empleado y Rol NO) ──
  { model: 'asistencia',               label: 'Asistencia'                },
]

const PRESERVED = ['Empleado', 'Rol', 'AuditLog', 'IpBlock', 'ConfiguracionNCF', 'SessionToken', 'PortalSettings', 'WebAuthnCredential']

;(async () => {
  console.log('\n══ RESET-AND-SEED ACR ══════════════════════════════════════')
  console.log('  Preservadas:', PRESERVED.join(', '))
  console.log('  A borrar:   ', DELETE_ORDER.map(d => d.label).join(', '))

  // Safety check: must have at least 1 Owner before resetting
  const owners = await p.empleado.findMany({
    where: { deletedAt: null, bloqueado: false, roles: { some: { permisos: { array_contains: ['sistema:owner'] } } } },
    select: { id: true, nombre: true, email: true },
  })
  if (owners.length === 0) {
    console.error('\n❌ ABORT: No se detecta ningún empleado Owner activo. Reset cancelado por seguridad.')
    console.error('   Ejecuta primero: node scripts/mega-seed.js para crear empleados base.')
    await p.$disconnect()
    process.exit(1)
  }
  console.log(`\n✓ Owners detectados (${owners.length}):`)
  owners.forEach(o => console.log(`   - ${o.nombre} <${o.email}>`))

  if (!AUTO_YES) {
    const conf = await ask('\n⚠️  Esto borrará TODA la data transaccional. Escribe "BORRAR" para confirmar: ')
    if (conf !== 'BORRAR') { console.log('Cancelado.'); await p.$disconnect(); process.exit(0) }
  }

  console.log('\n► Borrando en orden FK-safe...')
  let totalDeleted = 0
  for (const step of DELETE_ORDER) {
    try {
      const before = await p[step.model].count()
      if (before === 0) { console.log(`  ↷ ${step.label.padEnd(28)} 0 filas — skip`); continue }
      const r = await p[step.model].deleteMany({})
      totalDeleted += r.count
      console.log(`  ✓ ${step.label.padEnd(28)} ${String(r.count).padStart(5)} filas eliminadas`)
    } catch (e) {
      console.error(`  ✗ ${step.label.padEnd(28)} ERROR: ${e.message}`)
    }
  }
  console.log(`\n  Total: ${totalDeleted} filas borradas.`)

  // Reset NCF counter sequences (preserva configuración pero pone secuenciaActual=0 para que las nuevas COTs/Facturas empiecen limpio)
  try {
    await p.configuracionNCF.updateMany({ data: { secuenciaActual: 0 } })
    console.log('  ✓ Secuencias NCF reseteadas a 0 (sin tocar config DGII)')
  } catch (e) { console.error('  ✗ NCF reset error:', e.message) }

  if (SKIP_SEED) {
    console.log('\n--skip-seed presente. Done.')
    await p.$disconnect()
    return
  }

  console.log('\n► Ejecutando mega-seed.js...\n')
  await p.$disconnect()
  const seedPath = path.join(__dirname, 'mega-seed.js')
  const result = spawnSync('node', [seedPath], { stdio: 'inherit' })
  process.exit(result.status ?? 0)
})().catch(e => { console.error('\n[RESET ERROR]', e); process.exit(1) })
