import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Package, ClipboardList, FileText, Settings2, ScrollText, ShoppingBag } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import PanelCatalogo      from './panels/PanelCatalogo'
import PanelOrdenes       from './panels/PanelOrdenes'
import PanelFacturas      from './panels/PanelFacturas'
import PanelNCF           from './panels/PanelNCF'
import PanelCotizaciones  from './panels/PanelCotizaciones'
import PanelPOS           from './panels/PanelPOS'

export default function Ventas() {
  const [searchParams] = useSearchParams()
  const { tienePermiso } = useAuth()
  const canEdit     = tienePermiso('catalogo:editar')
  const canSeeCosts = tienePermiso('catalogo:ver_costos')
  const canPOS      = tienePermiso('pos:ver') || tienePermiso('sistema:owner')

  const clienteIdInit     = searchParams.get('cliente') ?? ''
  const clienteNombreInit = searchParams.get('nombre')  ?? ''

  const [tab, setTab] = useState(clienteIdInit ? 'ordenes' : 'catalogo')

  const TABS = [
    { key: 'catalogo',      label: 'Catálogo',       Icon: Package,       show: true       },
    { key: 'ordenes',       label: 'Órdenes',         Icon: ClipboardList,  show: true       },
    { key: 'facturas',      label: 'Facturas',        Icon: FileText,       show: true       },
    { key: 'cotizaciones',  label: 'Cotizaciones',    Icon: ScrollText,     show: true       },
    { key: 'pos',           label: 'POS',             Icon: ShoppingBag,    show: canPOS     },
    { key: 'ncf',           label: 'Config NCF',      Icon: Settings2,      show: true       },
  ].filter(t => t.show)

  return (
    <div className="space-y-5 max-w-7xl">
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
        {tab === 'catalogo'     && <PanelCatalogo canEdit={canEdit} canSeeCosts={canSeeCosts} />}
        {tab === 'ordenes'      && <PanelOrdenes  canEdit={canEdit} clienteIdInit={clienteIdInit} clienteNombreInit={clienteNombreInit} />}
        {tab === 'facturas'     && <PanelFacturas />}
        {tab === 'cotizaciones' && <PanelCotizaciones />}
        {tab === 'pos'          && <PanelPOS />}
        {tab === 'ncf'          && <PanelNCF />}
      </div>
    </div>
  )
}
