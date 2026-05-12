import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  Wrench, CheckCircle, Clock, AlertTriangle, Package,
  ArrowRight, Search, Loader2, MapPin,
} from "lucide-react";
import ACRLogo from "../components/ACRLogo";

const API = import.meta.env.VITE_API_URL || "";

const ESTADO_STEPS = [
  { id: "Recibido",       label: "Recibido",        Icon: Package    },
  { id: "Diagnostico",    label: "En Diagnóstico",  Icon: Search     },
  { id: "EsperandoPieza", label: "Esperando Pieza", Icon: AlertTriangle },
  { id: "Listo",          label: "Listo",            Icon: CheckCircle},
  { id: "Entregado",      label: "Entregado",        Icon: CheckCircle},
];

const ESTADO_INDEX = { Recibido: 0, Diagnostico: 1, EsperandoPieza: 2, Listo: 3, Entregado: 4, Cancelado: -1 };

function formatCurrency(val) {
  return new Intl.NumberFormat("es-DO", { style: "currency", currency: "DOP", minimumFractionDigits: 0 }).format(Number(val) || 0);
}

export default function TrackTicket() {
  const { pin: pinParam } = useParams();
  const navigate = useNavigate();
  const [pin, setPin]         = useState(pinParam ?? "");
  const [ticket, setTicket]   = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState("");

  async function consultar(pinStr) {
    const p = (pinStr ?? pin).trim().toUpperCase();
    if (!/^[A-Z2-9]{6}$/.test(p)) { setError("PIN inválido. Debe ser 6 caracteres."); return; }
    setLoading(true); setError(""); setTicket(null);
    try {
      const r = await fetch(`${API}/api/track/${p}`);
      if (r.status === 404) { setError("No se encontró ningún ticket con ese PIN."); return; }
      if (!r.ok)             { setError("Error consultando. Intenta de nuevo."); return; }
      const j = await r.json();
      setTicket(j);
      navigate(`/track/${p}`, { replace: true });
    } catch { setError("Error de red."); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    if (pinParam) consultar(pinParam);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinParam]);

  const currentIdx = ticket ? (ESTADO_INDEX[ticket.estado] ?? -1) : -1;
  const cancelled  = ticket?.estado === "Cancelado";

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="bg-slate-900 border-b border-slate-800 px-4 py-4">
        <div className="max-w-3xl mx-auto flex items-center gap-3">
          <ACRLogo size={32} />
          <div>
            <h1 className="text-base font-bold text-slate-100">ACR Networks · Tracking de Equipo</h1>
            <p className="text-xs text-slate-500">Consulta el estado de tu equipo en taller</p>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-8 space-y-6">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
          <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">PIN de Tracking (6 caracteres)</label>
          <div className="flex gap-2">
            <input
              type="text"
              maxLength={6}
              value={pin}
              onChange={e => setPin(e.target.value.toUpperCase().replace(/[^A-Z2-9]/g, ""))}
              onKeyDown={e => e.key === "Enter" && consultar()}
              placeholder="A4F2K7"
              className="flex-1 bg-slate-800 border border-blue-600/30 rounded-lg px-4 py-3 text-xl font-mono font-bold tracking-[0.4em] text-center text-emerald-400 placeholder-slate-700 focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={() => consultar()}
              disabled={loading || pin.length !== 6}
              className="px-6 py-3 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold disabled:opacity-50 flex items-center gap-2"
            >
              {loading ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
              Consultar
            </button>
          </div>
          {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
        </div>

        {ticket && (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
            <div className="p-6 border-b border-slate-800">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <p className="text-xs text-slate-500 uppercase tracking-wider">Ticket</p>
                  <p className="text-lg font-bold font-mono text-blue-400">{ticket.noTicket}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs text-slate-500 uppercase tracking-wider">Cliente</p>
                  <p className="text-sm text-slate-200">{ticket.cliente?.razonSocial}</p>
                </div>
              </div>
              <div className="mt-4 space-y-1">
                <p className="text-sm text-slate-200"><span className="text-slate-500">Equipo:</span> {ticket.equipo}</p>
                {(ticket.marca || ticket.modelo) && <p className="text-xs text-slate-400">{ticket.marca} {ticket.modelo}</p>}
              </div>
            </div>

            {cancelled ? (
              <div className="p-6 bg-red-500/10 border-l-4 border-red-500">
                <p className="text-sm font-semibold text-red-400 flex items-center gap-2">
                  <AlertTriangle size={16} />Ticket Cancelado
                </p>
                <p className="text-xs text-slate-400 mt-1">Contacta al taller para más información.</p>
              </div>
            ) : (
              <div className="p-6">
                <p className="text-xs text-slate-500 uppercase tracking-wider mb-4">Progreso</p>
                <div className="space-y-3">
                  {ESTADO_STEPS.map((step, idx) => {
                    const Icon = step.Icon;
                    const done    = idx <  currentIdx;
                    const active  = idx === currentIdx;
                    const pending = idx >  currentIdx;
                    return (
                      <div key={step.id} className="flex items-center gap-4">
                        <div className={`flex-shrink-0 w-10 h-10 rounded-full border-2 flex items-center justify-center transition-all ${
                          done    ? "bg-emerald-500/20 border-emerald-500 text-emerald-400" :
                          active  ? "bg-blue-500/20 border-blue-500 text-blue-400 ring-4 ring-blue-500/20" :
                                    "bg-slate-800 border-slate-700 text-slate-600"
                        }`}>
                          <Icon size={16} />
                        </div>
                        <div className="flex-1">
                          <p className={`text-sm font-semibold ${active ? "text-slate-100" : done ? "text-emerald-400" : "text-slate-600"}`}>
                            {step.label}
                          </p>
                          {active && <p className="text-xs text-blue-400 mt-0.5">← Estado actual</p>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {ticket.diagnostico && (
              <div className="px-6 pb-6">
                <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Diagnóstico</p>
                <p className="text-sm text-slate-300 bg-slate-800/60 border border-slate-700/50 rounded-lg p-3">{ticket.diagnostico}</p>
              </div>
            )}

            {ticket.costoEstimado && (
              <div className="px-6 pb-6">
                <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-4 flex items-center justify-between">
                  <span className="text-xs text-emerald-400 font-semibold uppercase tracking-wider">Costo Estimado</span>
                  <span className="text-lg font-bold text-emerald-400">{formatCurrency(ticket.costoEstimado)}</span>
                </div>
              </div>
            )}

            <div className="px-6 py-4 bg-slate-800/40 border-t border-slate-800 grid grid-cols-2 gap-4 text-xs">
              <div>
                <p className="text-slate-500">Recibido</p>
                <p className="text-slate-200">{new Date(ticket.recibidoEn).toLocaleString("es-DO")}</p>
              </div>
              {ticket.listoEn && (
                <div>
                  <p className="text-slate-500">Listo desde</p>
                  <p className="text-emerald-400">{new Date(ticket.listoEn).toLocaleString("es-DO")}</p>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex items-start gap-3">
          <MapPin size={18} className="text-blue-400 flex-shrink-0 mt-0.5" />
          <div className="text-xs text-slate-400">
            <p className="text-slate-200 font-semibold mb-1">¿Tu equipo está listo?</p>
            <p>Visita ACR Networks · Av. Tiradentes, Santo Domingo. Lun-Vie 8AM-6PM, Sáb 9AM-1PM.</p>
          </div>
        </div>
      </main>
    </div>
  );
}
