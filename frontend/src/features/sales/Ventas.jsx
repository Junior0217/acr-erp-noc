import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Package, ClipboardList, FileText, ScrollText, ShoppingBag, Shield } from 'lucide-react'
import { useAuth } from '@shared/contexts/AuthContext'
import PanelCatalogo      from './panels/PanelCatalogo'
import PanelOrdenes       from './panels/PanelOrdenes'
import PanelFacturas      from './panels/PanelFacturas'
import PanelCotizaciones  from './panels/PanelCotizaciones'
import PanelPOS           from './panels/PanelPOS'
import PanelAuditCaja     from './panels/PanelAuditCaja'
// PanelNCF eliminado: la config NCF vive ahora solo en /empresa (Mi Empresa).
// Mantener dos puntos de edición causaba drift y confundía al cajero.

export default function Ventas() {
  const [searchParams] = useSearchParams()
  const { tienePermiso } = useAuth()
  const canEdit       = tienePermiso('catalogo:editar')
  // Granular: precio, costo y margen visibles según permiso por rol. Por
  // default los flags nuevos son TRUE para owner; para otros roles requieren
  // que el owner los marque en /configuracion → Roles. Si el rol no los
  // tiene, las columnas se ocultan en el listado.
  const canSeeCosts   = tienePermiso('catalogo:ver_costos') || tienePermiso('sistema:owner')
  const canSeePrecio  = tienePermiso('catalogo:ver_precio') || tienePermiso('sistema:owner')
  const canSeeMargen  = tienePermiso('catalogo:ver_margen') || tienePermiso('sistema:owner')
  const canPOS        = tienePermiso('pos:ver') || tienePermiso('sistema:owner')
  const isOwner       = tienePermiso('sistema:owner')

  const clienteIdInit     = searchParams.get('cliente') ?? ''
  const clienteNombreInit = searchParams.get('nombre')  ?? ''
  const tabInit           = searchParams.get('tab')     ?? ''

  const [tab, setTab] = useState(
    tabInit || (clienteIdInit ? 'ordenes' : 'catalogo')
  )

  // Contextual nav state
  const [posPreload,      setPosPreload]      = useState([])  // items to pre-add to POS cart
  const [facturaHighlight, setFacturaHighlight] = useState(null) // facturaId to highlight after POS

  function sellNow(item) {
    setPosPreload([item])
    setTab('pos')
  }

  function onFacturaCreada(facturaId) {
    setFacturaHighlight(facturaId)
    setTab('facturas')
  }

  const TABS = [
    { key: 'catalogo',      label: 'Catálogo',       Icon: Package,       show: true       },
    { key: 'ordenes',       label: 'Órdenes',         Icon: ClipboardList,  show: true       },
    { key: 'facturas',      label: 'Facturas',        Icon: FileText,       show: true       },
    { key: 'cotizaciones',  label: 'Cotizaciones',    Icon: ScrollText,     show: true       },
    { key: 'pos',           label: 'POS',             Icon: ShoppingBag,    show: canPOS     },
    { key: 'audit',         label: 'Auditoría',       Icon: Shield,         show: isOwner    },
  ].filter(t => t.show)

  return (
    <div className="space-y-5 w-full">
      <div>
        <h1 className="text-2xl font-bold text-slate-100 font-mono tracking-tight">Ventas & Servicios</h1>
        <p className="text-sm text-slate-500 mt-0.5">Catálogo Universal · Órdenes de Trabajo · Facturación NCF · POS Interno</p>
      </div>

      <div className="flex gap-1 bg-slate-800/50 rounded-xl p-1 w-fit border border-slate-700/50 flex-wrap">
        {TABS.map(({ key, label, Icon }) => (
          <button key={key} onClick={() => setTab(key)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              tab === key
                ? key === 'pos' ? 'bg-orange-600 text-white shadow-sm' : 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-100'
            }`}>
            <Icon size={14} />{label}
          </button>
        ))}
      </div>

      <div>
        {tab === 'catalogo'     && <PanelCatalogo canEdit={canEdit} canSeeCosts={canSeeCosts} canSeePrecio={canSeePrecio} canSeeMargen={canSeeMargen} canPOS={canPOS} onSellNow={sellNow} />}
        {tab === 'ordenes'      && <PanelOrdenes  canEdit={canEdit} clienteIdInit={clienteIdInit} clienteNombreInit={clienteNombreInit} />}
        {tab === 'facturas'     && <PanelFacturas highlightId={facturaHighlight} />}
        {tab === 'cotizaciones' && <PanelCotizaciones onIrPOS={() => setTab('pos')} canPOS={canPOS} />}
        {tab === 'pos'          && <PanelPOS preloadItems={posPreload} onClearPreload={() => setPosPreload([])} onFacturaCreada={onFacturaCreada} />}
        {tab === 'audit'        && isOwner && <PanelAuditCaja />}
      </div>
    </div>
  )
}
