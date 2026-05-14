/**
 * Página pública /verify/:hash — valida la autenticidad de un PDF emitido.
 *
 * Backend recomputa el HMAC sobre la factura activa y compara con :hash. Si
 * un atacante editó el PDF en Photoshop (cambió un monto o NCF), el hash que
 * imprime el PDF ya no matchea con el real -> esta página devuelve "no
 * encontrado o alterado".
 */
import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { Loader2, CheckCircle2, ShieldAlert, FileText, Building2, Calendar, DollarSign, Hash } from 'lucide-react'

const API = import.meta.env.VITE_API_URL ?? ''

export default function VerifyDocument() {
  const { hash } = useParams()
  const [state, setState] = useState({ loading: true, data: null, error: null })

  useEffect(() => {
    let cancel = false
    fetch(`${API}/api/publico/verify/${encodeURIComponent(hash)}`)
      .then(async r => {
        const j = await r.json().catch(() => ({}))
        if (cancel) return
        if (r.ok && j.valid) setState({ loading: false, data: j, error: null })
        else                 setState({ loading: false, data: null, error: j.error ?? 'No se pudo verificar.' })
      })
      .catch(() => { if (!cancel) setState({ loading: false, data: null, error: 'Error de red.' }) })
    return () => { cancel = true }
  }, [hash])

  const fmtMoney = n => new Intl.NumberFormat('es-DO', { style: 'currency', currency: 'DOP' }).format(Number(n) || 0).replace('DOP', 'RD$')
  const fmtDate  = d => new Date(d).toLocaleDateString('es-DO', { day: '2-digit', month: 'long', year: 'numeric' })

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <h1 className="text-xl font-black uppercase tracking-widest text-slate-300">Verificación de Documento</h1>
          <p className="text-xs text-slate-500 mt-1 font-mono">Hash · <span className="text-slate-300">{hash}</span></p>
        </div>

        {state.loading && (
          <div className="bg-slate-800/60 border border-slate-700/50 rounded-2xl p-8 flex flex-col items-center gap-3">
            <Loader2 size={28} className="text-blue-400 animate-spin" />
            <p className="text-sm text-slate-400">Verificando autenticidad…</p>
          </div>
        )}

        {!state.loading && state.error && (
          <div className="bg-red-900/20 border border-red-700/40 rounded-2xl p-6 text-center space-y-3">
            <ShieldAlert size={36} className="text-red-400 mx-auto" />
            <div>
              <p className="text-base font-bold text-red-300">Documento no válido</p>
              <p className="text-xs text-red-400/80 mt-1">{state.error}</p>
            </div>
            <p className="text-[10px] text-slate-500 leading-relaxed">
              Si recibiste un PDF con este código y aparece como inválido, el archivo pudo haber sido alterado.
              Contacta a la empresa emisora para confirmar la información original.
            </p>
          </div>
        )}

        {!state.loading && state.data && (
          <div className="bg-slate-800/60 border border-emerald-600/30 rounded-2xl overflow-hidden">
            <div className="bg-emerald-900/30 border-b border-emerald-700/40 px-5 py-3 flex items-center gap-2">
              <CheckCircle2 size={18} className="text-emerald-400" />
              <span className="text-sm font-bold text-emerald-300 uppercase tracking-wider">Documento Auténtico</span>
            </div>
            <div className="p-5 space-y-3">
              <Row icon={Building2} label="Empresa Emisora" value={state.data.empresa?.razonSocial} sub={state.data.empresa?.rnc ? `RNC ${state.data.empresa.rnc}` : null} />
              <Row icon={FileText}  label={state.data.tipo === 'cotizacion' ? 'Cotización' : 'Factura'} value={state.data.noFactura} sub={state.data.ncf ? `NCF ${state.data.ncf}` : null} />
              <Row icon={Hash}      label="Cliente" value={state.data.cliente ?? 'Consumidor Final'} />
              <Row icon={Calendar}  label="Emisión" value={fmtDate(state.data.fechaEmision)} />
              <Row icon={DollarSign} label="Monto Total" value={fmtMoney(state.data.total)} sub={`Estado: ${state.data.estado}`} highlight />
            </div>
            <div className="border-t border-slate-700/50 px-5 py-3 bg-slate-900/40 text-[10px] text-slate-600 leading-relaxed">
              Esta validación confirma que el documento existe en los registros de la empresa con los datos mostrados.
              Si tu PDF muestra valores distintos, fue manipulado y no es válido.
            </div>
          </div>
        )}

        <div className="text-center mt-6">
          <Link to="/" className="text-xs text-slate-500 hover:text-slate-300 transition-colors">← Volver al sitio</Link>
        </div>
      </div>
    </div>
  )
}

function Row({ icon: Icon, label, value, sub, highlight }) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-8 h-8 rounded-lg bg-slate-700/40 border border-slate-700 flex items-center justify-center flex-shrink-0 mt-0.5">
        <Icon size={14} className="text-slate-400" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{label}</p>
        <p className={`text-sm font-semibold mt-0.5 truncate ${highlight ? 'text-emerald-300 text-lg font-black' : 'text-slate-100'}`}>{value ?? '—'}</p>
        {sub && <p className="text-[11px] text-slate-500 mt-0.5 font-mono">{sub}</p>}
      </div>
    </div>
  )
}
