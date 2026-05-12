import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  Users, Truck, UserPlus, Search, Plus, Eye, X,
  CheckCircle, XCircle, Loader2, ChevronLeft, ChevronRight, Download, ShieldOff,
  ClipboardList,
} from "lucide-react";
import { exportCsv } from "../utils/exportCsv";
import { apiFetch } from "../utils/api";
import { useAuth } from "../contexts/AuthContext";
import FormularioCliente from "../components/crm/FormularioCliente";
import FormularioSuplidor from "../components/crm/FormularioSuplidor";
import FormularioProspecto from "../components/crm/FormularioProspecto";

const LIMIT  = 50;

const EMPTY_META = { total: 0, page: 1, totalPages: 1 };

function formatCurrency(val) {
  return new Intl.NumberFormat("es-DO", {
    style: "currency", currency: "DOP",
    minimumFractionDigits: 0, maximumFractionDigits: 0,
  }).format(Number(val) || 0);
}

function Badge({ activo }) {
  return activo ? (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
      <CheckCircle size={11} />Activo
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-500/15 text-red-400 border border-red-500/30">
      <XCircle size={11} />Inactivo
    </span>
  );
}

const ESTADO_COLORS = {
  Nuevo:       "bg-blue-500/15 text-blue-400 border-blue-500/30",
  Contactado:  "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
  Interesado:  "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  Negociación: "bg-orange-500/15 text-orange-400 border-orange-500/30",
  Perdido:     "bg-red-500/15 text-red-400 border-red-500/30",
  Convertido:  "bg-purple-500/15 text-purple-400 border-purple-500/30",
};

function EstadoBadge({ estado }) {
  const cls = ESTADO_COLORS[estado] || "bg-slate-500/15 text-slate-400 border-slate-500/30";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${cls}`}>
      {estado}
    </span>
  );
}

const TH = "text-left px-4 py-3 text-slate-400 font-semibold text-xs uppercase tracking-wider whitespace-nowrap";

function SearchInput({ value, onChange, placeholder }) {
  return (
    <div className="relative">
      <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
      <input
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="pl-9 pr-8 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 w-full sm:w-64 transition"
      />
      {value && (
        <button
          onClick={() => onChange("")}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}

function Paginador({ meta, onPage, loading }) {
  if (meta.totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700/50">
      <span className="text-xs text-slate-500">
        {meta.total} registro{meta.total !== 1 ? "s" : ""} · Página {meta.page} de {meta.totalPages}
      </span>
      <div className="flex gap-1">
        <button
          onClick={() => onPage(meta.page - 1)}
          disabled={meta.page <= 1 || loading}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-xs font-medium transition disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ChevronLeft size={13} />Anterior
        </button>
        <button
          onClick={() => onPage(meta.page + 1)}
          disabled={meta.page >= meta.totalPages || loading}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-xs font-medium transition disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Siguiente<ChevronRight size={13} />
        </button>
      </div>
    </div>
  );
}

export default function CRM() {
  const { tienePermiso } = useAuth();
  const navigate = useNavigate();
  const [tab, setTab] = useState("clientes");

  const [searchClientes,   setSearchClientes]   = useState("");
  const [searchSuplidores, setSearchSuplidores] = useState("");
  const [searchProspectos, setSearchProspectos] = useState("");

  const [pageClientes,   setPageClientes]   = useState(1);
  const [pageSuplidores, setPageSuplidores] = useState(1);
  const [pageProspectos, setPageProspectos] = useState(1);

  const [clientes,   setClientes]   = useState([]);
  const [suplidores, setSuplidores] = useState([]);
  const [prospectos, setProspectos] = useState([]);

  const [metaClientes,   setMetaClientes]   = useState(EMPTY_META);
  const [metaSuplidores, setMetaSuplidores] = useState(EMPTY_META);
  const [metaProspectos, setMetaProspectos] = useState(EMPTY_META);

  const [loadingClientes,   setLoadingClientes]   = useState(false);
  const [loadingSuplidores, setLoadingSuplidores] = useState(false);
  const [loadingProspectos, setLoadingProspectos] = useState(false);

  const [modalOpen,             setModalOpen]             = useState(false);
  const [registroEnEdicion,     setRegistroEnEdicion]     = useState(null);
  const [prospectoParaConvertir, setProspectoParaConvertir] = useState(null);

  // Stable fetch refs to prevent stale closures in pagination
  const fetchClientes = useCallback(async (search, page) => {
    setLoadingClientes(true);
    try {
      const params = new URLSearchParams({ page, limit: LIMIT });
      if (search) params.set("search", search);
      const res  = await apiFetch(`/api/clientes?${params}`);
      const json = await res.json();
      setClientes(Array.isArray(json.data) ? json.data : []);
      setMetaClientes(json.meta || EMPTY_META);
    } catch { setClientes([]); setMetaClientes(EMPTY_META); }
    finally  { setLoadingClientes(false); }
  }, []);

  const fetchSuplidores = useCallback(async (search, page) => {
    setLoadingSuplidores(true);
    try {
      const params = new URLSearchParams({ page, limit: LIMIT });
      if (search) params.set("search", search);
      const res  = await apiFetch(`/api/suplidores?${params}`);
      const json = await res.json();
      setSuplidores(Array.isArray(json.data) ? json.data : []);
      setMetaSuplidores(json.meta || EMPTY_META);
    } catch { setSuplidores([]); setMetaSuplidores(EMPTY_META); }
    finally  { setLoadingSuplidores(false); }
  }, []);

  const fetchProspectos = useCallback(async (search, page) => {
    setLoadingProspectos(true);
    try {
      const params = new URLSearchParams({ page, limit: LIMIT });
      if (search) params.set("search", search);
      const res  = await apiFetch(`/api/prospectos?${params}`);
      const json = await res.json();
      setProspectos(Array.isArray(json.data) ? json.data : []);
      setMetaProspectos(json.meta || EMPTY_META);
    } catch { setProspectos([]); setMetaProspectos(EMPTY_META); }
    finally  { setLoadingProspectos(false); }
  }, []);

  // Reset page to 1 when search changes, then fetch
  const prevSearchC = useRef(searchClientes);
  const prevSearchS = useRef(searchSuplidores);
  const prevSearchP = useRef(searchProspectos);

  useEffect(() => {
    if (tab !== "clientes") return;
    const searchChanged = searchClientes !== prevSearchC.current;
    prevSearchC.current = searchClientes;
    const nextPage = searchChanged ? 1 : pageClientes;
    if (searchChanged) setPageClientes(1);
    const delay = searchClientes ? 300 : 0;
    const t = setTimeout(() => fetchClientes(searchClientes, nextPage), delay);
    return () => clearTimeout(t);
  }, [tab, searchClientes, pageClientes, fetchClientes]);

  useEffect(() => {
    if (tab !== "suplidores") return;
    const searchChanged = searchSuplidores !== prevSearchS.current;
    prevSearchS.current = searchSuplidores;
    const nextPage = searchChanged ? 1 : pageSuplidores;
    if (searchChanged) setPageSuplidores(1);
    const delay = searchSuplidores ? 300 : 0;
    const t = setTimeout(() => fetchSuplidores(searchSuplidores, nextPage), delay);
    return () => clearTimeout(t);
  }, [tab, searchSuplidores, pageSuplidores, fetchSuplidores]);

  useEffect(() => {
    if (tab !== "prospectos") return;
    const searchChanged = searchProspectos !== prevSearchP.current;
    prevSearchP.current = searchProspectos;
    const nextPage = searchChanged ? 1 : pageProspectos;
    if (searchChanged) setPageProspectos(1);
    const delay = searchProspectos ? 300 : 0;
    const t = setTimeout(() => fetchProspectos(searchProspectos, nextPage), delay);
    return () => clearTimeout(t);
  }, [tab, searchProspectos, pageProspectos, fetchProspectos]);

  // Initial fetch when switching tabs
  useEffect(() => {
    if (tab === "clientes")   fetchClientes(searchClientes, pageClientes);
    if (tab === "suplidores") fetchSuplidores(searchSuplidores, pageSuplidores);
    if (tab === "prospectos") fetchProspectos(searchProspectos, pageProspectos);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const closeModal = () => {
    setModalOpen(false);
    setRegistroEnEdicion(null);
    setProspectoParaConvertir(null);
  };

  const handleSaveCliente   = () => { closeModal(); fetchClientes(searchClientes, pageClientes); };
  const handleSaveSuplidor  = () => { closeModal(); fetchSuplidores(searchSuplidores, pageSuplidores); };
  const handleSaveProspecto = () => { closeModal(); fetchProspectos(searchProspectos, pageProspectos); };

  const handleToggleCliente = async () => {
    if (!registroEnEdicion?.id) return;
    try { await apiFetch(`/api/clientes/${registroEnEdicion.id}/toggle`, { method: "PATCH" }); } catch {}
    closeModal(); fetchClientes(searchClientes, pageClientes);
  };

  const handleToggleSuplidor = async () => {
    if (!registroEnEdicion?.id) return;
    try { await apiFetch(`/api/suplidores/${registroEnEdicion.id}/toggle`, { method: "PATCH" }); } catch {}
    closeModal(); fetchSuplidores(searchSuplidores, pageSuplidores);
  };

  const openConvertirComoCliente = (prospecto) => {
    setProspectoParaConvertir(prospecto);
    setRegistroEnEdicion(null);
    setTab("clientes");
    setModalOpen(true);
  };

  // Use server total for building next ID correctly
  const nextClienteId  = `CLI-${String(metaClientes.total + 1).padStart(3, "0")}`;
  const nextSuplidorId = `SUP-${String(metaSuplidores.total + 1).padStart(3, "0")}`;

  if (!tienePermiso('crm:ver')) return (
    <div className="flex flex-col items-center justify-center h-64 gap-3 text-slate-500">
      <ShieldOff size={32} />
      <p className="text-sm font-medium">Sin acceso al módulo CRM</p>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 p-4 md:p-6 space-y-6">
      {/* Tab switcher */}
      <div className="flex gap-1 bg-slate-800/60 border border-slate-700/50 rounded-xl p-1 w-fit">
        {[
          { id: "clientes",   label: "Clientes",  Icon: Users    },
          { id: "suplidores", label: "Suplidores", Icon: Truck    },
          { id: "prospectos", label: "Prospectos", Icon: UserPlus },
        ].map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 ${
              tab === id
                ? "bg-blue-600 text-white shadow-lg shadow-blue-600/20"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-700/50"
            }`}
          >
            <Icon size={16} />{label}
          </button>
        ))}
      </div>

      {/* ── CLIENTES ── */}
      {tab === "clientes" && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold text-slate-100 tracking-tight">Clientes</h1>
              <p className="text-slate-400 text-sm mt-0.5">
                {metaClientes.total} registro{metaClientes.total !== 1 ? "s" : ""}
              </p>
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <SearchInput value={searchClientes} onChange={setSearchClientes} placeholder="Buscar cliente..." />
              {tienePermiso('crm:exportar') && (
                <button
                  onClick={() => exportCsv('clientes', [
                    { header: 'No. Cliente',  getValue: c => c.noCliente },
                    { header: 'Razón Social', getValue: c => c.razonSocial },
                    { header: 'Comercial',    getValue: c => c.nombreComercial ?? '' },
                    { header: 'RNC/Cédula',   getValue: c => c.rnc ?? c.cedula ?? '' },
                    { header: 'Contacto',     getValue: c => `${c.nombreContacto} ${c.apellidoContacto ?? ''}`.trim() },
                    { header: 'Teléfono',     getValue: c => c.telefonoPrincipal },
                    { header: 'Email',        getValue: c => c.email },
                    { header: 'Provincia',    getValue: c => c.provincia },
                    { header: 'Crédito',      getValue: c => c.limiteCredito },
                    { header: 'Días Crédito', getValue: c => c.diasCredito },
                    { header: 'Estado',       getValue: c => c.activo ? 'Activo' : 'Inactivo' },
                  ], clientes)}
                  className="flex items-center justify-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 border border-slate-600 rounded-lg text-sm font-semibold text-slate-200 transition-colors whitespace-nowrap"
                >
                  <Download size={15} />Exportar CSV
                </button>
              )}
              {tienePermiso('crm:crear') && (
                <button
                  onClick={() => { setRegistroEnEdicion(null); setProspectoParaConvertir(null); setModalOpen(true); }}
                  className="flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 rounded-lg text-sm font-semibold text-white transition-colors shadow-lg shadow-blue-600/20 whitespace-nowrap"
                >
                  <Plus size={16} />Nuevo Cliente
                </button>
              )}
            </div>
          </div>
          <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700/70 bg-slate-800/60">
                    <th className={TH}>ID</th>
                    <th className={TH}>Razón Social</th>
                    <th className={TH}>RNC</th>
                    <th className={TH}>Contacto</th>
                    <th className={TH}>Teléfono</th>
                    <th className={TH}>Crédito</th>
                    <th className={TH}>Estado</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/80">
                  {loadingClientes ? (
                    <tr><td colSpan={8} className="text-center py-10"><Loader2 size={20} className="animate-spin text-blue-500 mx-auto" /></td></tr>
                  ) : clientes.length === 0 ? (
                    <tr><td colSpan={8} className="text-center py-10 text-slate-500">No se encontraron clientes.</td></tr>
                  ) : clientes.map((c) => (
                    <tr key={c.id} className="hover:bg-slate-800/50 transition-colors">
                      <td className="px-4 py-3 font-mono text-xs text-slate-400 whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          {c.noCliente}
                          {c.noCliente?.startsWith('PRT-') && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-blue-600/20 text-blue-400 border border-blue-600/30 uppercase tracking-wider">Portal B2C</span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-100 whitespace-nowrap">{c.razonSocial}</div>
                        <div className="text-xs text-slate-500">{c.nombreComercial}</div>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-300 whitespace-nowrap">{c.rnc || c.cedula || "—"}</td>
                      <td className="px-4 py-3 text-slate-300 whitespace-nowrap">{c.nombreContacto} {c.apellidoContacto}</td>
                      <td className="px-4 py-3 text-slate-300 whitespace-nowrap">{c.telefonoPrincipal}</td>
                      <td className="px-4 py-3 font-mono text-xs whitespace-nowrap">
                        {Number(c.limiteCredito) > 0
                          ? <span className="text-emerald-400 font-semibold">{formatCurrency(c.limiteCredito)}</span>
                          : <span className="text-slate-600">—</span>}
                      </td>
                      <td className="px-4 py-3"><Badge activo={c.activo} /></td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center gap-1.5 justify-end">
                          <button
                            onClick={() => { setRegistroEnEdicion(c); setModalOpen(true); }}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-700/60 hover:bg-slate-600/60 border border-slate-600/50 hover:border-slate-500/50 text-slate-300 hover:text-white text-xs font-medium transition-all whitespace-nowrap"
                          >
                            <Eye size={13} />Ver / Editar
                          </button>
                          <button
                            onClick={() => navigate(`/ventas?cliente=${c.id}&nombre=${encodeURIComponent(c.razonSocial)}`)}
                            title="Nueva Orden de Trabajo"
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600/15 hover:bg-blue-600/25 border border-blue-600/30 hover:border-blue-600/50 text-blue-400 hover:text-blue-300 text-xs font-medium transition-all whitespace-nowrap"
                          >
                            <ClipboardList size={13} />Nueva OT
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Paginador meta={metaClientes} onPage={setPageClientes} loading={loadingClientes} />
          </div>
        </div>
      )}

      {/* ── SUPLIDORES ── */}
      {tab === "suplidores" && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold text-slate-100 tracking-tight">Suplidores</h1>
              <p className="text-slate-400 text-sm mt-0.5">
                {metaSuplidores.total} registro{metaSuplidores.total !== 1 ? "s" : ""}
              </p>
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <SearchInput value={searchSuplidores} onChange={setSearchSuplidores} placeholder="Buscar suplidor..." />
              <button
                onClick={() => { setRegistroEnEdicion(null); setModalOpen(true); }}
                className="flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 rounded-lg text-sm font-semibold text-white transition-colors shadow-lg shadow-blue-600/20 whitespace-nowrap"
              >
                <Plus size={16} />Nuevo Suplidor
              </button>
            </div>
          </div>
          <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700/70 bg-slate-800/60">
                    <th className={TH}>ID</th>
                    <th className={TH}>Razón Social</th>
                    <th className={TH}>RNC</th>
                    <th className={TH}>Contacto</th>
                    <th className={TH}>Teléfono</th>
                    <th className={TH}>Crédito</th>
                    <th className={TH}>Estado</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/80">
                  {loadingSuplidores ? (
                    <tr><td colSpan={8} className="text-center py-10"><Loader2 size={20} className="animate-spin text-blue-500 mx-auto" /></td></tr>
                  ) : suplidores.length === 0 ? (
                    <tr><td colSpan={8} className="text-center py-10 text-slate-500">No se encontraron suplidores.</td></tr>
                  ) : suplidores.map((s) => (
                    <tr key={s.id} className="hover:bg-slate-800/50 transition-colors">
                      <td className="px-4 py-3 font-mono text-xs text-slate-400 whitespace-nowrap">{s.noSuplidor}</td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-100 whitespace-nowrap">{s.razonSocial}</div>
                        <div className="text-xs text-slate-500">{s.nombreComercial}</div>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-300 whitespace-nowrap">{s.rnc || s.cedula || "—"}</td>
                      <td className="px-4 py-3 text-slate-300 whitespace-nowrap">{s.nombreContacto}</td>
                      <td className="px-4 py-3 text-slate-300 whitespace-nowrap">{s.telefonoPrincipal}</td>
                      <td className="px-4 py-3 font-mono text-xs whitespace-nowrap">
                        {Number(s.limiteCredito) > 0
                          ? <span className="text-emerald-400 font-semibold">{formatCurrency(s.limiteCredito)}</span>
                          : <span className="text-slate-600">—</span>}
                      </td>
                      <td className="px-4 py-3"><Badge activo={s.activo} /></td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => { setRegistroEnEdicion(s); setModalOpen(true); }}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-700/60 hover:bg-slate-600/60 border border-slate-600/50 hover:border-slate-500/50 text-slate-300 hover:text-white text-xs font-medium transition-all whitespace-nowrap"
                        >
                          <Eye size={13} />Ver / Editar
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Paginador meta={metaSuplidores} onPage={setPageSuplidores} loading={loadingSuplidores} />
          </div>
        </div>
      )}

      {/* ── PROSPECTOS ── */}
      {tab === "prospectos" && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold text-slate-100 tracking-tight">Prospectos</h1>
              <p className="text-slate-400 text-sm mt-0.5">
                {metaProspectos.total} registro{metaProspectos.total !== 1 ? "s" : ""}
              </p>
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <SearchInput value={searchProspectos} onChange={setSearchProspectos} placeholder="Buscar prospecto..." />
              <button
                onClick={() => { setRegistroEnEdicion(null); setModalOpen(true); }}
                className="flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 rounded-lg text-sm font-semibold text-white transition-colors shadow-lg shadow-blue-600/20 whitespace-nowrap"
              >
                <Plus size={16} />Nuevo Prospecto
              </button>
            </div>
          </div>
          <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700/70 bg-slate-800/60">
                    <th className={TH}>Nombre</th>
                    <th className={TH}>Teléfono</th>
                    <th className={TH}>Servicio</th>
                    <th className={TH}>Origen</th>
                    <th className={TH}>Estado</th>
                    <th className={TH}>Fecha</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/80">
                  {loadingProspectos ? (
                    <tr><td colSpan={7} className="text-center py-10"><Loader2 size={20} className="animate-spin text-blue-500 mx-auto" /></td></tr>
                  ) : prospectos.length === 0 ? (
                    <tr><td colSpan={7} className="text-center py-10 text-slate-500">No se encontraron prospectos.</td></tr>
                  ) : prospectos.map((p) => (
                    <tr key={p.id} className="hover:bg-slate-800/50 transition-colors">
                      <td className="px-4 py-3 font-medium text-slate-100 whitespace-nowrap">{p.nombre}</td>
                      <td className="px-4 py-3 text-slate-300 whitespace-nowrap">{p.telefono}</td>
                      <td className="px-4 py-3 text-slate-300 whitespace-nowrap">{p.servicioInteresado}</td>
                      <td className="px-4 py-3 text-slate-400 text-xs whitespace-nowrap">{p.origen}</td>
                      <td className="px-4 py-3"><EstadoBadge estado={p.estado} /></td>
                      <td className="px-4 py-3 text-slate-500 text-xs whitespace-nowrap">
                        {new Date(p.createdAt).toLocaleDateString("es-DO")}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => { setRegistroEnEdicion(p); setModalOpen(true); }}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-700/60 hover:bg-slate-600/60 border border-slate-600/50 hover:border-slate-500/50 text-slate-300 hover:text-white text-xs font-medium transition-all whitespace-nowrap"
                        >
                          <Eye size={13} />Ver / Editar
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Paginador meta={metaProspectos} onPage={setPageProspectos} loading={loadingProspectos} />
          </div>
        </div>
      )}

      {/* ── MODALS ── */}
      {modalOpen && tab === "clientes" && (
        <FormularioCliente
          nextId={nextClienteId}
          initialData={registroEnEdicion}
          prospectoOrigen={prospectoParaConvertir}
          onClose={closeModal}
          onSave={handleSaveCliente}
          onToggleStatus={handleToggleCliente}
        />
      )}
      {modalOpen && tab === "suplidores" && (
        <FormularioSuplidor
          nextId={nextSuplidorId}
          initialData={registroEnEdicion}
          onClose={closeModal}
          onSave={handleSaveSuplidor}
          onToggleStatus={handleToggleSuplidor}
        />
      )}
      {modalOpen && tab === "prospectos" && (
        <FormularioProspecto
          initialData={registroEnEdicion}
          onClose={closeModal}
          onSave={handleSaveProspecto}
          onConvertir={openConvertirComoCliente}
        />
      )}
    </div>
  );
}
