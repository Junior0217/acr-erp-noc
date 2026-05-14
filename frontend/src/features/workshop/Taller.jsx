import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import {
  Wrench, Plus, X, Search, Loader2, ChevronRight, Copy, ShieldOff,
  AlertTriangle, Package, Eye,
} from "lucide-react";
import { apiFetch } from "@shared/utils/api";
import { useAuth } from "@shared/contexts/AuthContext";
import { EmptyState } from "@features/sales/panels/_shared";

const ESTADOS = [
  { id: "Recibido",       label: "Recibido",        color: "bg-blue-500/15 text-blue-400 border-blue-500/30" },
  { id: "Diagnostico",    label: "Diagnóstico",     color: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30" },
  { id: "EsperandoPieza", label: "Esperando Pieza", color: "bg-orange-500/15 text-orange-400 border-orange-500/30" },
  { id: "Listo",          label: "Listo",           color: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" },
  { id: "Entregado",      label: "Entregado",       color: "bg-slate-500/15 text-slate-400 border-slate-500/30" },
  { id: "Cancelado",      label: "Cancelado",       color: "bg-red-500/15 text-red-400 border-red-500/30" },
];

const INPUT  = "w-full bg-slate-800 border border-blue-600/30 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500";
const LABEL  = "block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1";
const SELECT = "w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500";

function EstadoBadge({ estado }) {
  const e = ESTADOS.find(x => x.id === estado) ?? ESTADOS[0];
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border ${e.color}`}>{e.label}</span>;
}

function NuevoTicketModal({ onClose, onCreated }) {
  const [clientes, setClientes] = useState([]);
  const [form, setForm] = useState({
    clienteId: "", equipo: "", marca: "", modelo: "", numeroSerie: "", falla: "", notas: "", costoEstimado: "",
  });
  const [busy, setBusy] = useState(false);
  const [searchCli, setSearchCli] = useState("");

  useEffect(() => {
    const t = setTimeout(async () => {
      const params = new URLSearchParams({ limit: 30 });
      if (searchCli) params.set("search", searchCli);
      const r = await apiFetch(`/api/clientes?${params}`);
      const j = await r.json();
      setClientes(Array.isArray(j.data) ? j.data : []);
    }, searchCli ? 300 : 0);
    return () => clearTimeout(t);
  }, [searchCli]);

  async function submit(e) {
    e.preventDefault();
    if (!form.clienteId || !form.equipo || !form.falla) return toast.error("Cliente, equipo y falla son obligatorios.");
    setBusy(true);
    try {
      const body = { ...form, costoEstimado: form.costoEstimado ? Number(form.costoEstimado) : null };
      const r = await apiFetch("/api/taller", { method: "POST", body: JSON.stringify(body) });
      if (r.ok) {
        const t = await r.json();
        toast.success(`Ticket ${t.noTicket} creado. PIN: ${t.codigoPin}`);
        onCreated();
      } else {
        const j = await r.json();
        toast.error(j.error ?? "Error al crear ticket.");
      }
    } catch { toast.error("Error de red."); }
    finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-blue-600/30 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <Wrench size={18} className="text-blue-400" />
            <h2 className="text-base font-semibold text-slate-100">Nuevo Ticket de Taller</h2>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200 p-1"><X size={18} /></button>
        </div>
        <form onSubmit={submit} className="p-6 space-y-4">
          <div>
            <label className={LABEL}>Cliente *</label>
            <input className={INPUT} placeholder="Buscar cliente..." value={searchCli} onChange={e => setSearchCli(e.target.value)} />
            <div className="mt-2 max-h-32 overflow-y-auto rounded-lg border border-slate-700 divide-y divide-slate-800">
              {clientes.map(c => (
                <button type="button" key={c.id}
                  onClick={() => { setForm(f => ({ ...f, clienteId: c.id })); setSearchCli(c.razonSocial); }}
                  className={`w-full text-left px-3 py-2 text-xs hover:bg-slate-800 ${form.clienteId === c.id ? "bg-blue-600/10 text-blue-300" : "text-slate-300"}`}>
                  <span className="font-mono text-blue-400 mr-2">{c.noCliente}</span>{c.razonSocial}
                </button>
              ))}
              {clientes.length === 0 && <p className="text-xs text-slate-600 text-center py-2">Sin resultados</p>}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={LABEL}>Equipo *</label><input required className={INPUT} placeholder="Laptop, PC, NVR..." value={form.equipo} onChange={e => setForm({ ...form, equipo: e.target.value })} /></div>
            <div><label className={LABEL}>Marca</label><input className={INPUT} placeholder="Dell, HP, Hikvision..." value={form.marca} onChange={e => setForm({ ...form, marca: e.target.value })} /></div>
            <div><label className={LABEL}>Modelo</label><input className={INPUT} value={form.modelo} onChange={e => setForm({ ...form, modelo: e.target.value })} /></div>
            <div><label className={LABEL}>No. Serie</label><input className={INPUT} value={form.numeroSerie} onChange={e => setForm({ ...form, numeroSerie: e.target.value })} /></div>
          </div>
          <div>
            <label className={LABEL}>Falla reportada *</label>
            <textarea required rows={3} className={INPUT} placeholder="Descripción del problema..." value={form.falla} onChange={e => setForm({ ...form, falla: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={LABEL}>Costo Estimado (DOP)</label><input type="number" min="0" step="100" className={INPUT} value={form.costoEstimado} onChange={e => setForm({ ...form, costoEstimado: e.target.value })} /></div>
            <div><label className={LABEL}>Notas internas</label><input className={INPUT} value={form.notas} onChange={e => setForm({ ...form, notas: e.target.value })} /></div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm text-slate-300">Cancelar</button>
            <button type="submit" disabled={busy} className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold disabled:opacity-50 flex items-center gap-2">
              {busy && <Loader2 size={14} className="animate-spin" />} Crear Ticket
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function DetalleTicketModal({ ticket, onClose, onUpdated }) {
  const [estado, setEstado] = useState(ticket.estado);
  const [diagnostico, setDiagnostico] = useState(ticket.diagnostico ?? "");
  const [costoEstimado, setCostoEstimado] = useState(ticket.costoEstimado ?? "");
  const [busy, setBusy] = useState(false);

  async function guardar() {
    setBusy(true);
    try {
      const body = { estado, diagnostico: diagnostico || null, costoEstimado: costoEstimado ? Number(costoEstimado) : null };
      const r = await apiFetch(`/api/taller/${ticket.id}/estado`, { method: "PATCH", body: JSON.stringify(body) });
      if (r.ok) { toast.success("Ticket actualizado."); onUpdated(); }
      else { const j = await r.json(); toast.error(j.error ?? "Error."); }
    } catch { toast.error("Error de red."); }
    finally { setBusy(false); }
  }

  function copiarPin() {
    navigator.clipboard.writeText(ticket.codigoPin);
    toast.success(`PIN ${ticket.codigoPin} copiado.`);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-blue-600/30 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <Wrench size={18} className="text-blue-400" />
            <div>
              <h2 className="text-base font-semibold text-slate-100">{ticket.noTicket}</h2>
              <p className="text-xs text-slate-500">{ticket.cliente?.razonSocial}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200 p-1"><X size={18} /></button>
        </div>
        <div className="p-6 space-y-4">
          <div className="bg-slate-800/60 border border-slate-700/50 rounded-lg p-4 flex items-center justify-between">
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wider">PIN de Tracking</p>
              <p className="text-2xl font-mono font-bold text-blue-400 mt-1">{ticket.codigoPin}</p>
            </div>
            <button onClick={copiarPin} className="px-3 py-2 rounded-lg bg-blue-600/15 hover:bg-blue-600/25 border border-blue-600/30 text-blue-300 text-xs font-semibold flex items-center gap-1.5">
              <Copy size={13} />Copiar
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div><span className="text-slate-500">Equipo:</span> <span className="text-slate-200">{ticket.equipo}</span></div>
            <div><span className="text-slate-500">Marca/Modelo:</span> <span className="text-slate-200">{ticket.marca ?? "—"} / {ticket.modelo ?? "—"}</span></div>
            <div className="col-span-2"><span className="text-slate-500">Falla:</span> <span className="text-slate-200">{ticket.falla}</span></div>
          </div>
          <div>
            <label className={LABEL}>Estado</label>
            <select className={SELECT} value={estado} onChange={e => setEstado(e.target.value)}>
              {ESTADOS.map(e => <option key={e.id} value={e.id}>{e.label}</option>)}
            </select>
          </div>
          <div>
            <label className={LABEL}>Diagnóstico técnico</label>
            <textarea rows={4} className={INPUT} value={diagnostico} onChange={e => setDiagnostico(e.target.value)} placeholder="Resultado del diagnóstico, piezas necesarias..." />
          </div>
          <div>
            <label className={LABEL}>Costo estimado (DOP)</label>
            <input type="number" min="0" step="100" className={INPUT} value={costoEstimado} onChange={e => setCostoEstimado(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm text-slate-300">Cerrar</button>
            <button type="button" onClick={guardar} disabled={busy} className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold disabled:opacity-50 flex items-center gap-2">
              {busy && <Loader2 size={14} className="animate-spin" />} Guardar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Taller() {
  const { tienePermiso } = useAuth();
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch]   = useState("");
  const [estadoFilter, setEstadoFilter] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [detalle, setDetalle] = useState(null);

  const fetchTickets = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (estadoFilter) params.set("estado", estadoFilter);
      if (search)        params.set("search", search);
      const r = await apiFetch(`/api/taller?${params}`);
      const j = await r.json();
      setTickets(Array.isArray(j.data) ? j.data : []);
    } catch { setTickets([]); }
    finally { setLoading(false); }
  }, [search, estadoFilter]);

  useEffect(() => {
    const t = setTimeout(fetchTickets, search ? 300 : 0);
    return () => clearTimeout(t);
  }, [fetchTickets, search]);

  const conteoPorEstado = ESTADOS.reduce((acc, e) => {
    acc[e.id] = tickets.filter(t => t.estado === e.id).length;
    return acc;
  }, {});

  if (!tienePermiso("ot:ver")) return (
    <div className="flex flex-col items-center justify-center h-64 gap-3 text-slate-500">
      <ShieldOff size={32} />
      <p className="text-sm font-medium">Sin acceso al Taller.</p>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 p-4 md:p-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-100 tracking-tight flex items-center gap-2">
            <Wrench size={22} className="text-blue-400" /> Taller (RMA)
          </h1>
          <p className="text-slate-400 text-sm mt-0.5">Recepción y diagnóstico de equipos · {tickets.length} ticket{tickets.length !== 1 ? "s" : ""}</p>
        </div>
        {tienePermiso("ot:crear") && (
          <button onClick={() => setShowNew(true)} className="flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-semibold text-white shadow-lg shadow-blue-600/20">
            <Plus size={16} />Nuevo Ticket
          </button>
        )}
      </div>

      {/* Counters por estado */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        <button onClick={() => setEstadoFilter("")} className={`p-3 rounded-lg border text-left transition-all ${!estadoFilter ? "bg-blue-600/20 border-blue-600/50" : "bg-slate-800/40 border-slate-700/50 hover:border-slate-600"}`}>
          <p className="text-[10px] text-slate-500 uppercase tracking-wider">Total</p>
          <p className="text-xl font-bold text-slate-100">{tickets.length}</p>
        </button>
        {ESTADOS.slice(0, 5).map(e => (
          <button key={e.id} onClick={() => setEstadoFilter(e.id)} className={`p-3 rounded-lg border text-left transition-all ${estadoFilter === e.id ? "bg-blue-600/20 border-blue-600/50" : "bg-slate-800/40 border-slate-700/50 hover:border-slate-600"}`}>
            <p className="text-[10px] text-slate-500 uppercase tracking-wider">{e.label}</p>
            <p className="text-xl font-bold text-slate-100">{conteoPorEstado[e.id] ?? 0}</p>
          </button>
        ))}
      </div>

      <div className="flex gap-2">
        <div className="relative flex-1 max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar por PIN, equipo, ticket..." className={`${INPUT} pl-9`} />
        </div>
      </div>

      <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700/70 bg-slate-800/60 text-left">
                <th className="px-4 py-3 text-slate-400 font-semibold text-xs uppercase tracking-wider">No. Ticket</th>
                <th className="px-4 py-3 text-slate-400 font-semibold text-xs uppercase tracking-wider">PIN</th>
                <th className="px-4 py-3 text-slate-400 font-semibold text-xs uppercase tracking-wider">Cliente</th>
                <th className="px-4 py-3 text-slate-400 font-semibold text-xs uppercase tracking-wider">Equipo</th>
                <th className="px-4 py-3 text-slate-400 font-semibold text-xs uppercase tracking-wider">Estado</th>
                <th className="px-4 py-3 text-slate-400 font-semibold text-xs uppercase tracking-wider">Recibido</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {loading ? (
                <tr><td colSpan={7} className="text-center py-10"><Loader2 size={20} className="animate-spin text-blue-500 mx-auto" /></td></tr>
              ) : tickets.length === 0 ? (
                <tr><td colSpan={7}><EmptyState icon={Wrench} title="Sin tickets" description="Crea el primer ticket con 'Nuevo Ticket'." /></td></tr>
              ) : tickets.map(t => (
                <tr key={t.id} className="hover:bg-slate-800/50 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs text-blue-400 whitespace-nowrap">{t.noTicket}</td>
                  <td className="px-4 py-3 font-mono text-sm font-bold text-emerald-400 whitespace-nowrap tracking-wider">{t.codigoPin}</td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <div className="text-slate-100 text-sm">{t.cliente?.razonSocial ?? "—"}</div>
                    <div className="text-xs text-slate-500">{t.cliente?.telefonoPrincipal}</div>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <div className="text-slate-200 text-sm">{t.equipo}</div>
                    <div className="text-xs text-slate-500">{t.marca} {t.modelo}</div>
                  </td>
                  <td className="px-4 py-3"><EstadoBadge estado={t.estado} /></td>
                  <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">{new Date(t.recibidoEn).toLocaleDateString("es-DO")}</td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => setDetalle(t)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-700/60 hover:bg-slate-600/60 border border-slate-600/50 text-slate-300 hover:text-white text-xs font-medium">
                      <Eye size={13} />Ver
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showNew   && <NuevoTicketModal onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); fetchTickets(); }} />}
      {detalle   && <DetalleTicketModal ticket={detalle} onClose={() => setDetalle(null)} onUpdated={() => { setDetalle(null); fetchTickets(); }} />}
    </div>
  );
}
