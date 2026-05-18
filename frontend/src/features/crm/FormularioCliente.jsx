import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { X, Save, User, MapPin, Briefcase, Phone, Loader2, PowerOff, Power, AlertTriangle, Map, CreditCard, Crosshair, KeyRound, Server, Eye, EyeOff, Plus, Trash2, Package, ShieldCheck, FileText } from "lucide-react";
import MapPicker from "./MapPicker";
import { apiFetch } from "@shared/utils/api";

const API = import.meta.env.VITE_API_URL || '';

const TIPOS_CREDENCIAL = ["Router","Switch","AccessPoint","NVR","DVR","Camara","Server","Firewall","ControlAcceso","Otro"];

function VaultTab({ clienteId }) {
  const [creds, setCreds] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [revealed, setRevealed] = useState({});
  const [form, setForm] = useState({ tipo: "Router", nombre: "", ip: "", usuario: "", password: "", notas: "" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiFetch(`/api/credenciales?clienteId=${clienteId}`);
      const j = await r.json();
      setCreds(Array.isArray(j.data) ? j.data : []);
    } catch { setCreds([]); }
    finally { setLoading(false); }
  }, [clienteId]);

  useEffect(() => { load(); }, [load]);

  async function crear(e) {
    e.preventDefault();
    if (!form.nombre || !form.usuario || !form.password) return toast.error("Nombre, usuario y password son obligatorios.");
    try {
      const r = await apiFetch("/api/credenciales", { method: "POST", body: JSON.stringify({ clienteId, ...form }) });
      if (r.ok) {
        toast.success("Credencial guardada (cifrada).");
        setShowNew(false);
        setForm({ tipo: "Router", nombre: "", ip: "", usuario: "", password: "", notas: "" });
        load();
      } else {
        const j = await r.json();
        toast.error(j.error ?? "Error.");
      }
    } catch { toast.error("Error de red."); }
  }

  const [revealTarget, setRevealTarget] = useState(null);

  function toggleReveal(id) {
    if (revealed[id]) {
      setRevealed(r => { const n = { ...r }; delete n[id]; return n; });
      return;
    }
    // Pide TOTP antes de llamar al backend (server lo exige obligatorio)
    setRevealTarget(id);
  }

  async function doReveal(id, totp) {
    try {
      const r = await apiFetch(`/api/credenciales/${id}/reveal`, {
        headers: { "X-TOTP": totp },
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        setRevealed(rv => ({ ...rv, [id]: j.password }));
        toast.warning("Password revelado · Evento auditado · 30s cool-down activo");
        setRevealTarget(null);
        return true;
      }
      if (j.code === "TOTP_NOT_CONFIGURED") {
        toast.error("Activa 2FA en Configuración > Mi Perfil primero.");
        setRevealTarget(null);
        return false;
      }
      if (j.code === "TOTP_INVALID" || j.code === "TOTP_REQUIRED") {
        toast.error(j.error ?? "Código TOTP inválido.");
        return false;
      }
      if (j.code === "VAULT_COOLDOWN") {
        toast.warning(`Cool-down · espera ${Math.ceil((j.retryAfterMs ?? 0) / 1000)}s`);
        setRevealTarget(null);
        return false;
      }
      toast.error(j.error ?? "Error al descifrar.");
      return false;
    } catch {
      toast.error("Error de red.");
      return false;
    }
  }

  async function eliminar(id) {
    if (!confirm("¿Eliminar credencial?")) return;
    const r = await apiFetch(`/api/credenciales/${id}`, { method: "DELETE" });
    if (r.ok) { toast.success("Eliminada."); load(); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-blue-400">
          <ShieldCheck size={16} />
          <span className="text-xs font-bold uppercase tracking-wider">Bóveda PAM (AES-256-GCM cifrado)</span>
        </div>
        <button type="button" onClick={() => setShowNew(v => !v)} className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold flex items-center gap-1.5">
          <Plus size={13} />Nueva
        </button>
      </div>

      {showNew && (
        <form onSubmit={crear} className="bg-slate-800/60 border border-blue-600/30 rounded-lg p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] text-slate-500 uppercase mb-1">Tipo</label>
              <select className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200" value={form.tipo} onChange={e => setForm({ ...form, tipo: e.target.value })}>
                {TIPOS_CREDENCIAL.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[10px] text-slate-500 uppercase mb-1">Nombre amigable *</label>
              <input className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200" placeholder="NVR Recepción" value={form.nombre} onChange={e => setForm({ ...form, nombre: e.target.value })} required />
            </div>
            <div>
              <label className="block text-[10px] text-slate-500 uppercase mb-1">IP</label>
              <input className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-xs font-mono text-slate-200" placeholder="192.168.1.10" value={form.ip} onChange={e => setForm({ ...form, ip: e.target.value })} />
            </div>
            <div>
              <label className="block text-[10px] text-slate-500 uppercase mb-1">Usuario *</label>
              <input className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-xs font-mono text-slate-200" value={form.usuario} onChange={e => setForm({ ...form, usuario: e.target.value })} required />
            </div>
            <div className="col-span-2">
              <label className="block text-[10px] text-slate-500 uppercase mb-1">Password *</label>
              <input type="password" className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-xs font-mono text-slate-200" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} required />
            </div>
            <div className="col-span-2">
              <label className="block text-[10px] text-slate-500 uppercase mb-1">Notas</label>
              <input className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200" value={form.notas} onChange={e => setForm({ ...form, notas: e.target.value })} />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setShowNew(false)} className="px-3 py-1.5 rounded text-xs text-slate-400 hover:text-slate-200">Cancelar</button>
            <button type="submit" className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold">Guardar (cifrado)</button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin text-blue-500" /></div>
      ) : creds.length === 0 ? (
        <p className="text-center text-xs text-slate-600 py-8">Sin credenciales registradas.</p>
      ) : (
        <div className="space-y-2">
          {creds.map(c => (
            <div key={c.id} className="bg-slate-800/40 border border-slate-700/50 rounded-lg p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <Server size={14} className="text-blue-400 flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-slate-100">{c.nombre}</span>
                      <span className="text-[10px] px-1.5 py-0.5 bg-blue-600/15 text-blue-400 border border-blue-600/30 rounded">{c.tipo}</span>
                    </div>
                    <div className="text-xs text-slate-400 mt-0.5 font-mono">
                      {c.ip && <span className="mr-3">{c.ip}</span>}
                      <span>usr: {c.usuario}</span>
                      <span className="mx-2">·</span>
                      {revealed[c.id]
                        ? <span className="text-emerald-400">pwd: {revealed[c.id]}</span>
                        : <span className="text-slate-600">pwd: ••••••••</span>}
                    </div>
                  </div>
                </div>
                <div className="flex gap-1">
                  <button type="button" onClick={() => toggleReveal(c.id)} className="p-1.5 rounded hover:bg-slate-700 text-slate-400 hover:text-blue-400" title={revealed[c.id] ? "Ocultar" : "Revelar (requiere 2FA + auditado)"}>
                    {revealed[c.id] ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                  <button type="button" onClick={() => eliminar(c.id)} className="p-1.5 rounded hover:bg-red-600/20 text-slate-500 hover:text-red-400">
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
              {c.notas && <p className="text-xs text-slate-500 mt-2 pl-6">{c.notas}</p>}
            </div>
          ))}
        </div>
      )}

      {revealTarget && (
        <TOTPRevealModal
          onCancel={() => setRevealTarget(null)}
          onSubmit={(totp) => doReveal(revealTarget, totp)}
        />
      )}
    </div>
  );
}

function TOTPRevealModal({ onCancel, onSubmit }) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e?.preventDefault?.();
    if (pin.length !== 6) return;
    setBusy(true);
    const ok = await onSubmit(pin);
    setBusy(false);
    if (!ok) setPin("");
  }
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <form onSubmit={submit} className="bg-slate-900 border border-red-600/40 rounded-xl w-full max-w-sm p-5 space-y-3">
        <div className="flex items-center gap-2">
          <ShieldCheck size={18} className="text-red-400" />
          <h3 className="text-sm font-bold text-slate-100">2FA requerido para revelar</h3>
        </div>
        <p className="text-xs text-slate-400 leading-snug">
          La bóveda PAM exige código TOTP en cada revelación. Cooldown de 30s + evento auditado.
        </p>
        <input
          type="text" inputMode="numeric" maxLength={6}
          value={pin}
          onChange={e => setPin(e.target.value.replace(/\D/g, ""))}
          placeholder="000000"
          autoFocus
          className="w-full text-center text-xl font-mono tracking-[0.5em] bg-slate-800 border border-slate-700 focus:border-red-500 focus:outline-none rounded px-3 py-2.5 text-slate-100"
        />
        <div className="flex gap-2">
          <button type="button" onClick={onCancel} disabled={busy} className="flex-1 py-2 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs">Cancelar</button>
          <button type="submit" disabled={pin.length !== 6 || busy} className="flex-1 py-2 rounded bg-red-600 hover:bg-red-500 text-white text-xs font-semibold disabled:opacity-50">
            {busy ? "Verificando…" : "Revelar"}
          </button>
        </div>
      </form>
    </div>
  );
}

function AssetsTab({ clienteId }) {
  const [activos, setActivos] = useState([]);
  const [loading, setLoading] = useState(false);
  const ahora = Date.now();

  useEffect(() => {
    setLoading(true);
    apiFetch(`/api/activos-cliente?clienteId=${clienteId}`)
      .then(r => r.json())
      .then(j => setActivos(Array.isArray(j.data) ? j.data : []))
      .catch(() => setActivos([]))
      .finally(() => setLoading(false));
  }, [clienteId]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-blue-400">
        <Package size={16} />
        <span className="text-xs font-bold uppercase tracking-wider">CMDB · Equipos instalados ({activos.length})</span>
      </div>
      {loading ? (
        <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin text-blue-500" /></div>
      ) : activos.length === 0 ? (
        <p className="text-center text-xs text-slate-600 py-8">Sin equipos instalados registrados.<br/>Se cargan automáticamente al cerrar Órdenes de Trabajo.</p>
      ) : (
        <div className="space-y-2">
          {activos.map(a => {
            const vencido = a.finGarantia && new Date(a.finGarantia).getTime() < ahora;
            return (
              <div key={a.id} className="bg-slate-800/40 border border-slate-700/50 rounded-lg p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-slate-100">{a.producto?.nombre ?? "—"}</span>
                      <span className="text-[10px] font-mono text-slate-500">{a.producto?.sku}</span>
                      {a.cantidad > 1 && <span className="text-[10px] px-1.5 py-0.5 bg-blue-600/15 text-blue-400 border border-blue-600/30 rounded">×{a.cantidad}</span>}
                    </div>
                    <div className="text-xs text-slate-400 mt-1">
                      Instalado: {new Date(a.fechaInstalacion).toLocaleDateString("es-DO")}
                      {a.orden?.noOT && <span className="ml-2 font-mono text-blue-400">{a.orden.noOT}</span>}
                      {a.ubicacion && <span className="ml-2">· {a.ubicacion}</span>}
                    </div>
                  </div>
                  {a.finGarantia && (
                    <span className={`text-[10px] px-2 py-1 rounded-full border whitespace-nowrap ${vencido ? "bg-red-500/15 text-red-400 border-red-500/30" : "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"}`}>
                      Garantía: {new Date(a.finGarantia).toLocaleDateString("es-DO")}
                    </span>
                  )}
                </div>
                {a.numeroSerie && <p className="text-xs text-slate-500 mt-1 font-mono">S/N: {a.numeroSerie}</p>}
                <AssetTimeline activoId={a.id} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AssetTimeline({ activoId }) {
  const [open, setOpen]     = useState(false);
  const [eventos, setEventos] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [evento, setEvento] = useState("mantenimiento");
  const [notas, setNotas]   = useState("");

  async function cargar() {
    setLoading(true);
    try {
      const r = await apiFetch(`/api/activos-cliente/${activoId}/timeline`);
      const j = await r.json();
      setEventos(Array.isArray(j.data) ? j.data : []);
    } catch { setEventos([]); }
    finally { setLoading(false); }
  }

  function toggle() {
    if (!open && eventos === null) cargar();
    setOpen(o => !o);
  }

  async function agregar(e) {
    e.preventDefault();
    if (notas.length < 2) { toast.error("Describe el evento."); return; }
    try {
      const r = await apiFetch(`/api/activos-cliente/${activoId}/timeline`, {
        method: "POST",
        body: JSON.stringify({ evento, notas }),
      });
      if (r.ok) {
        toast.success("Evento registrado");
        setNotas(""); setShowAdd(false);
        cargar();
      } else {
        toast.error("Error al registrar evento.");
      }
    } catch { toast.error("Error de red."); }
  }

  const EVENTO_COLOR = {
    instalado:           "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    reparado:            "bg-blue-500/15 text-blue-400 border-blue-500/30",
    trasladado:          "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
    retirado:            "bg-orange-500/15 text-orange-400 border-orange-500/30",
    garantia_reclamada:  "bg-red-500/15 text-red-400 border-red-500/30",
    mantenimiento:       "bg-purple-500/15 text-purple-400 border-purple-500/30",
    inspeccion:          "bg-slate-500/15 text-slate-400 border-slate-500/30",
  };

  return (
    <div className="mt-2 pt-2 border-t border-slate-800">
      <button type="button" onClick={toggle} className="text-[10px] text-slate-500 hover:text-blue-400 flex items-center gap-1">
        {open ? "▼" : "▶"} Historial {eventos != null && `(${eventos.length})`}
      </button>
      {open && (
        <div className="mt-2 space-y-1.5">
          {loading ? (
            <div className="flex justify-center py-2"><Loader2 size={14} className="animate-spin text-blue-500" /></div>
          ) : eventos?.length === 0 ? (
            <p className="text-[10px] text-slate-600 italic">Sin eventos registrados.</p>
          ) : (
            eventos?.map(e => (
              <div key={e.id} className="flex items-start gap-2 text-[10.5px]">
                <span className={`px-1.5 py-0.5 rounded-full border whitespace-nowrap ${EVENTO_COLOR[e.evento] ?? EVENTO_COLOR.inspeccion}`}>
                  {e.evento}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-slate-400">
                    {new Date(e.fecha).toLocaleDateString("es-DO")} · <span className="text-slate-500">{e.tecnico?.nombre ?? "—"}</span>
                    {e.orden?.noOT && <span className="ml-2 text-blue-400 font-mono">{e.orden.noOT}</span>}
                  </div>
                  {e.notas && <p className="text-slate-500 leading-snug">{e.notas}</p>}
                </div>
              </div>
            ))
          )}
          {showAdd ? (
            <form onSubmit={agregar} className="flex gap-1.5 mt-2">
              <select value={evento} onChange={ev => setEvento(ev.target.value)} className="bg-slate-900 border border-slate-700 rounded text-[10px] px-1.5 py-1 text-slate-200">
                {Object.keys(EVENTO_COLOR).map(k => <option key={k} value={k}>{k}</option>)}
              </select>
              <input value={notas} onChange={ev => setNotas(ev.target.value)} placeholder="Nota..." className="flex-1 bg-slate-900 border border-slate-700 rounded text-[10px] px-1.5 py-1 text-slate-200" />
              <button type="submit" className="text-[10px] px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded">Agregar</button>
              <button type="button" onClick={() => setShowAdd(false)} className="text-[10px] px-2 py-1 text-slate-400 hover:text-slate-200">×</button>
            </form>
          ) : (
            <button type="button" onClick={() => setShowAdd(true)} className="text-[10px] text-blue-400 hover:text-blue-300">+ Agregar evento</button>
          )}
        </div>
      )}
    </div>
  );
}

const INPUT =
  "w-full bg-slate-800 border border-blue-600/30 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition";
const LABEL =
  "block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1";
const SECTION =
  "text-xs font-bold text-blue-400 uppercase tracking-widest border-b border-blue-600/20 pb-1 mb-3 col-span-full flex items-center gap-2";

// Figuras jurídicas RD. El backend `_derivarTipoNcf` mapea cada una a su
// tipoNcf DGII canónico (B01/B02/B14/B15/B16). Cambiar la spelling aquí
// rompe el mapping — sincronizar también en backend/modules/crm/clientes/service.js.
const TIPOS_EMPRESA = [
  "Persona Física",
  "Informal / Sin Comprobante",
  "EIRL",
  "SRL",
  "SA",
  "SAS",
  "Gobierno Central",
  "Ayuntamiento / Municipal",
  "ONG / Sin fines de lucro",
  "Zona Franca",
  "Extranjero",
];
const TIPOS_CLIENTE  = ["Empresarial", "Pyme", "Corporativo", "Residencial", "Gobierno"];
const TIPOS_SERVICIO = [
  "WISP (Internet)", "CCTV & Videovigilancia", "Redes Estructuradas",
  "Cercos Eléctricos", "Control de Acceso", "Múltiples Servicios",
];
const PROVINCIAS = [
  "Distrito Nacional", "Santiago", "San Pedro de Macorís",
  "La Vega", "La Romana", "Puerto Plata", "Otra",
];

function formatPhone(v) {
  const d = v.replace(/\D/g, "").slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}

function formatCedula(v) {
  const d = v.replace(/\D/g, "").slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 10) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 10)}-${d.slice(10)}`;
}

function formatRNC(v) {
  const d = v.replace(/\D/g, "").slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 8) return `${d.slice(0, 3)}-${d.slice(3)}`;
  if (d.length === 9) return `${d.slice(0, 3)}-${d.slice(3, 8)}-${d.slice(8)}`;
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 10)}-${d.slice(10)}`;
}

const EMPTY = {
  noCliente:       "",
  razonSocial:     "",
  nombreComercial: "",
  rnc:             "",
  regMercantil:    "",
  tipoEmpresa:     "SRL",
  fechaInicio:     new Date().toISOString().split("T")[0],
  telefono:        "",
  telefonoAlt:     "",
  email:           "",
  website:         "",
  direccion:       "",
  sector:          "",
  provincia:       "Distrito Nacional",
  latitud:         "",
  longitud:        "",
  nombre:          "",
  apellido:        "",
  cedula:          "",
  cargo:           "",
  tipoCliente:     "Empresarial",
  tipoServicio:    "WISP (Internet)",
  itbis:           true,
  activo:          true,
  fechaInactivo:   "",
  promHorasMes:    "",
  limiteCredito:   0,
  diasCredito:     0,
  tipoNcf:         "Consumidor Final",
};

export default function FormularioCliente({ onClose, onSave, onToggleStatus, nextId = "CLI-001", initialData = null, prospectoOrigen = null }) {
  const isEdit = Boolean(initialData?.id);
  const [form, setForm] = useState({ ...EMPTY, noCliente: nextId });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [apiError, setApiError] = useState("");
  const [showMapPicker, setShowMapPicker] = useState(false);

  useEffect(() => {
    if (!initialData && prospectoOrigen) {
      setForm({
        ...EMPTY,
        noCliente: nextId,
        nombre:    prospectoOrigen.nombre?.split(" ")[0] ?? "",
        apellido:  prospectoOrigen.nombre?.split(" ").slice(1).join(" ") ?? "",
        telefono:  prospectoOrigen.telefono ?? "",
        tipoServicio: prospectoOrigen.servicioInteresado ?? EMPTY.tipoServicio,
        latitud:   prospectoOrigen.latitud ?? "",
        longitud:  prospectoOrigen.longitud ?? "",
      });
      return;
    }
    if (!initialData) {
      setForm({ ...EMPTY, noCliente: nextId });
      return;
    }
    setForm({
      noCliente:       initialData.noCliente ?? nextId,
      razonSocial:     initialData.razonSocial ?? "",
      nombreComercial: initialData.nombreComercial ?? "",
      rnc:             formatRNC(initialData.rnc ?? ""),
      regMercantil:    initialData.registroMercantil ?? "",
      tipoEmpresa:     initialData.tipoEmpresa ?? "SRL",
      fechaInicio:     initialData.fechaInicio
                         ? initialData.fechaInicio.split("T")[0]
                         : new Date().toISOString().split("T")[0],
      telefono:        formatPhone(initialData.telefonoPrincipal ?? ""),
      telefonoAlt:     formatPhone(initialData.telefonoAlternativo ?? ""),
      email:           initialData.email ?? "",
      website:         initialData.website ?? "",
      direccion:       initialData.direccion ?? "",
      sector:          initialData.sector ?? "",
      provincia:       initialData.provincia ?? "Distrito Nacional",
      latitud:         initialData.latitud ?? "",
      longitud:        initialData.longitud ?? "",
      nombre:          initialData.nombreContacto ?? "",
      apellido:        initialData.apellidoContacto ?? "",
      cedula:          formatCedula(initialData.cedula ?? ""),
      cargo:           initialData.cargo ?? "",
      tipoCliente:     initialData.tipoCliente ?? "Empresarial",
      tipoServicio:    initialData.tipoServicio ?? "WISP (Internet)",
      itbis:           initialData.itbis ?? true,
      activo:          initialData.activo ?? true,
      fechaInactivo:   initialData.fechaInactivo
                         ? initialData.fechaInactivo.split("T")[0]
                         : "",
      promHorasMes:    initialData.promHorasMes ?? "",
      limiteCredito:   initialData.limiteCredito ?? 0,
      diasCredito:     initialData.diasCredito ?? 0,
      tipoNcf:         initialData.tipoNcf ?? "Consumidor Final",
    });
  }, [initialData, nextId, prospectoOrigen]);

  const set = (field) => (e) =>
    setForm((prev) => ({
      ...prev,
      [field]: e.target.type === "checkbox" ? e.target.checked : e.target.value,
    }));

  const masked = (field, fn) => (e) =>
    setForm((prev) => ({ ...prev, [field]: fn(e.target.value) }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsSubmitting(true);
    setApiError("");

    const payload = {
      ...(prospectoOrigen?.id && !isEdit ? { prospectoOrigenId: prospectoOrigen.id } : {}),
      razonSocial:         form.razonSocial,
      nombreComercial:     form.nombreComercial,
      rnc:                 form.rnc,
      registroMercantil:   form.regMercantil,
      tipoEmpresa:         form.tipoEmpresa,
      fechaInicio:         form.fechaInicio || undefined,
      nombreContacto:      form.nombre,
      apellidoContacto:    form.apellido,
      cedula:              form.cedula,
      cargo:               form.cargo,
      direccion:           form.direccion,
      sector:              form.sector,
      provincia:           form.provincia,
      latitud:             form.latitud,
      longitud:            form.longitud,
      telefonoPrincipal:   form.telefono,
      telefonoAlternativo: form.telefonoAlt,
      email:               form.email,
      website:             form.website,
      tipoCliente:         form.tipoCliente,
      tipoServicio:        form.tipoServicio,
      itbis:               Boolean(form.itbis),
      activo:              Boolean(form.activo),
      fechaInactivo:       !form.activo && form.fechaInactivo ? form.fechaInactivo : undefined,
      promHorasMes:        form.promHorasMes !== "" ? parseInt(form.promHorasMes, 10) : undefined,
      limiteCredito:       parseFloat(form.limiteCredito) || 0,
      diasCredito:         parseInt(form.diasCredito, 10) || 0,
      tipoNcf:             form.tipoNcf,
    };

    if (!isEdit) payload.noCliente = form.noCliente;

    try {
      const res = await fetch(
        isEdit ? `${API}/api/clientes/${initialData.id}` : `${API}/api/clientes`,
        {
          method: isEdit ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || `Error ${res.status}`);
      }
      onSave();
    } catch (err) {
      setApiError(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const canOpenMap = form.latitud && form.longitud;

  const handleMapPick = (la, lo) => {
    setForm((prev) => ({ ...prev, latitud: String(la.toFixed(6)), longitud: String(lo.toFixed(6)) }));
  };

  const [activeTab, setActiveTab] = useState("datos");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-blue-600/30 rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-4 bg-slate-900 border-b border-blue-600/20">
          <div>
            <h2 className="text-lg font-bold text-slate-100 tracking-tight">
              {isEdit ? "Editar Cliente" : "Nuevo Cliente"}
            </h2>
            <p className="text-xs text-blue-400 font-mono mt-0.5">{form.noCliente}</p>
          </div>
          <button type="button" onClick={onClose} disabled={isSubmitting}
            className="p-2 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition disabled:opacity-50">
            <X size={18} />
          </button>
        </div>

        {isEdit && (
          <div className="sticky top-[68px] z-10 flex gap-1 px-6 py-2 bg-slate-900 border-b border-slate-800">
            {[
              { id: "datos",   label: "Datos",     Icon: User },
              { id: "vault",   label: "Bóveda",    Icon: KeyRound },
              { id: "activos", label: "Activos",   Icon: Package },
            ].map(({ id, label, Icon }) => (
              <button key={id} type="button" onClick={() => setActiveTab(id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                  activeTab === id ? "bg-blue-600 text-white" : "text-slate-400 hover:text-slate-200 hover:bg-slate-800"
                }`}>
                <Icon size={13} />{label}
              </button>
            ))}
          </div>
        )}

        {isEdit && activeTab === "vault" && (
          <div className="p-6"><VaultTab clienteId={initialData.id} /></div>
        )}
        {isEdit && activeTab === "activos" && (
          <div className="p-6"><AssetsTab clienteId={initialData.id} /></div>
        )}

        <form onSubmit={handleSubmit} className={`p-6 space-y-6 ${isEdit && activeTab !== "datos" ? "hidden" : ""}`}>

          {/* ── Datos Generales ─────────────────────────────────── */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div className={SECTION}><User size={13} />Datos Generales</div>

            <div>
              <label className={LABEL}># Cliente</label>
              <input readOnly className={`${INPUT} opacity-50 cursor-not-allowed`} value={form.noCliente} />
            </div>
            <div className="sm:col-span-1 lg:col-span-2">
              <label className={LABEL}>Razón Social *</label>
              <input required className={INPUT} value={form.razonSocial} onChange={set("razonSocial")} placeholder="ACR Networks & Solutions S.R.L." />
            </div>
            <div>
              <label className={LABEL}>Nombre Comercial</label>
              <input className={INPUT} value={form.nombreComercial} onChange={set("nombreComercial")} placeholder="ACR Networks" />
            </div>
            <div>
              <label className={LABEL}>RNC</label>
              <input
                readOnly={isEdit}
                className={`${INPUT} ${isEdit ? "opacity-50 cursor-not-allowed" : ""}`}
                value={form.rnc}
                onChange={isEdit ? undefined : masked("rnc", formatRNC)}
                placeholder="1-33-69267-8"
                maxLength={13}
              />
            </div>
            <div>
              <label className={LABEL}>Registro Mercantil</label>
              <input className={INPUT} value={form.regMercantil} onChange={set("regMercantil")} placeholder="220982SD" />
            </div>
            <div>
              <label className={LABEL}>Tipo Empresa</label>
              <select className={INPUT} value={form.tipoEmpresa} onChange={set("tipoEmpresa")}>
                {TIPOS_EMPRESA.map((t) => <option key={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className={LABEL}>Fecha Inicio</label>
              <input type="date" className={INPUT} value={form.fechaInicio} onChange={set("fechaInicio")} />
            </div>
          </div>

          {/* ── Contacto ─────────────────────────────────────────── */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className={SECTION}><Phone size={13} />Contacto</div>
            <div>
              <label className={LABEL}>Teléfono Principal</label>
              <input className={INPUT} value={form.telefono} onChange={masked("telefono", formatPhone)} placeholder="809-XXX-XXXX (opcional)" maxLength={12} />
            </div>
            <div>
              <label className={LABEL}>Teléfono Alternativo</label>
              <input className={INPUT} value={form.telefonoAlt} onChange={masked("telefonoAlt", formatPhone)} placeholder="849-XXX-XXXX" maxLength={12} />
            </div>
            <div>
              <label className={LABEL}>Email *</label>
              <input required type="email" className={INPUT} value={form.email} onChange={set("email")} placeholder="ranetworkssolutions@gmail.com" />
            </div>
            <div>
              <label className={LABEL}>Website</label>
              <input className={INPUT} value={form.website} onChange={set("website")} placeholder="www.acrnetworks.com.do" />
            </div>
          </div>

          {/* ── Ubicación & Coordenadas ───────────────────────────── */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div className={SECTION}><MapPin size={13} />Ubicación & Coordenadas</div>
            <div className="sm:col-span-2 lg:col-span-3">
              <label className={LABEL}>Dirección *</label>
              <input required className={INPUT} value={form.direccion} onChange={set("direccion")} placeholder="Calle, número, edificio..." />
            </div>
            <div>
              <label className={LABEL}>Sector</label>
              <input className={INPUT} value={form.sector} onChange={set("sector")} placeholder="Cristo Rey" />
            </div>
            <div>
              <label className={LABEL}>Provincia</label>
              <select className={INPUT} value={form.provincia} onChange={set("provincia")}>
                {PROVINCIAS.map((p) => <option key={p}>{p}</option>)}
              </select>
            </div>
            <div />
            <div>
              <label className={LABEL}>Latitud</label>
              <input type="text" className={INPUT} value={form.latitud} onChange={set("latitud")} placeholder="18.4510" />
            </div>
            <div>
              <label className={LABEL}>Longitud</label>
              <input type="text" className={INPUT} value={form.longitud} onChange={set("longitud")} placeholder="-69.2980" />
            </div>
            <div className="flex items-end gap-2">
              <button
                type="button"
                onClick={() => setShowMapPicker((v) => !v)}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border transition ${
                  showMapPicker
                    ? "bg-blue-600/30 border-blue-500/50 text-blue-300"
                    : "bg-slate-700/60 border-slate-600/50 text-slate-300 hover:bg-blue-600/20 hover:border-blue-500/40 hover:text-white"
                }`}
              >
                <Crosshair size={14} />Fijar
              </button>
              <button
                type="button"
                disabled={!canOpenMap}
                onClick={() => window.open(`https://www.google.com/maps?q=${form.latitud},${form.longitud}`, "_blank")}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-slate-700/60 hover:bg-blue-600/30 border border-slate-600/50 hover:border-blue-500/50 rounded-lg text-sm font-medium text-slate-300 hover:text-white transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Map size={14} />Maps
              </button>
            </div>
            {showMapPicker && (
              <div className="sm:col-span-2 lg:col-span-3">
                <MapPicker lat={form.latitud} lng={form.longitud} onPick={handleMapPick} />
              </div>
            )}
          </div>

          {/* ── Datos Personales del Contacto ────────────────────── */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className={SECTION}><User size={13} />Datos Personales del Contacto</div>
            <div>
              <label className={LABEL}>Nombre *</label>
              <input required className={INPUT} value={form.nombre} onChange={set("nombre")} placeholder="Nombre" />
            </div>
            <div>
              <label className={LABEL}>Apellido *</label>
              <input required className={INPUT} value={form.apellido} onChange={set("apellido")} placeholder="Apellido" />
            </div>
            <div>
              <label className={LABEL}>Cédula</label>
              <input className={INPUT} value={form.cedula} onChange={masked("cedula", formatCedula)} placeholder="001-1234567-8" maxLength={13} />
              <p className="text-xs text-amber-500/70 mt-1">* RNC o Cédula obligatorio</p>
            </div>
            <div>
              <label className={LABEL}>Cargo</label>
              <input className={INPUT} value={form.cargo} onChange={set("cargo")} placeholder="Gerente General" />
            </div>
          </div>

          {/* ── Operativa ────────────────────────────────────────── */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div className={SECTION}><Briefcase size={13} />Operativa</div>
            <div>
              <label className={LABEL}>Tipo Cliente</label>
              <select className={INPUT} value={form.tipoCliente} onChange={set("tipoCliente")}>
                {TIPOS_CLIENTE.map((t) => <option key={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className={LABEL}>Tipo Servicio</label>
              <select className={INPUT} value={form.tipoServicio} onChange={set("tipoServicio")}>
                {TIPOS_SERVICIO.map((t) => <option key={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className={LABEL}>Prom. Horas / Mes</label>
              <input type="number" min="0" max="744" className={INPUT} value={form.promHorasMes} onChange={set("promHorasMes")} placeholder="720" />
            </div>
            <div className="flex items-center gap-6 sm:col-span-2 lg:col-span-2">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={form.itbis} onChange={set("itbis")} className="w-4 h-4 rounded border-blue-600/50 bg-slate-800 accent-blue-600 cursor-pointer" />
                <span className="text-sm text-slate-300">Aplica ITBIS</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={form.activo} onChange={set("activo")} className="w-4 h-4 rounded border-blue-600/50 bg-slate-800 accent-blue-600 cursor-pointer" />
                <span className="text-sm text-slate-300">Activo</span>
              </label>
            </div>
            <div>
              <label className={`${LABEL} ${form.activo ? "opacity-40" : ""}`}>
                Fecha Inactivo
              </label>
              <input
                type="date"
                disabled={form.activo}
                className={`${INPUT} ${form.activo ? "opacity-40 cursor-not-allowed" : ""}`}
                value={form.fechaInactivo}
                onChange={set("fechaInactivo")}
              />
            </div>
          </div>

          {/* ── Condiciones Comerciales & Crédito ────────────── */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className={SECTION}><CreditCard size={13} />Condiciones Comerciales & Crédito</div>
            <div>
              <label className={LABEL}>Límite de Crédito (RD$)</label>
              <input
                type="number" min="0" step="0.01"
                className={INPUT}
                value={form.limiteCredito}
                onChange={set("limiteCredito")}
                placeholder="0.00"
              />
            </div>
            <div>
              <label className={LABEL}>Días de Crédito</label>
              <select className={INPUT} value={form.diasCredito} onChange={set("diasCredito")}>
                <option value={0}>Contado (0 días)</option>
                <option value={15}>15 días</option>
                <option value={30}>30 días</option>
                <option value={45}>45 días</option>
                <option value={60}>60 días</option>
              </select>
            </div>
            <div>
              <label className={LABEL}>Tipo de Comprobante (NCF)</label>
              <select className={INPUT} value={form.tipoNcf} onChange={set("tipoNcf")}>
                <option>Consumidor Final</option>
                <option>Crédito Fiscal</option>
                <option>Gubernamental</option>
              </select>
            </div>
          </div>

          {apiError && (
            <p className="flex items-center gap-2 text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-2">
              <AlertTriangle size={15} className="shrink-0" />
              {apiError}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-800">
            <div className="flex gap-2">
              {isEdit && (
                <button
                  type="button"
                  onClick={onToggleStatus}
                  disabled={isSubmitting}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border transition disabled:opacity-50 ${
                    initialData.activo
                      ? "bg-red-600/20 hover:bg-red-600/40 border-red-500/40 text-red-400 hover:text-red-300"
                      : "bg-emerald-600/20 hover:bg-emerald-600/40 border-emerald-500/40 text-emerald-400 hover:text-emerald-300"
                  }`}
                >
                  {initialData.activo ? <PowerOff size={14} /> : <Power size={14} />}
                  {initialData.activo ? "Desactivar" : "Activar"}
                </button>
              )}
            </div>
            <div className="flex gap-2 ml-auto">
              <button type="button" onClick={onClose}
                className="px-5 py-2 rounded-lg text-sm font-medium text-slate-400 hover:text-slate-200 hover:bg-slate-800 border border-slate-700 transition">
                Cancelar
              </button>
              <button type="submit" disabled={isSubmitting || (!form.activo && !form.fechaInactivo)}
                className="flex items-center gap-2 px-5 py-2 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 rounded-lg text-sm font-semibold text-white transition shadow-lg shadow-blue-600/20 disabled:opacity-60 disabled:cursor-not-allowed">
                {isSubmitting ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                {isSubmitting ? "Guardando..." : isEdit ? "Actualizar Cliente" : "Guardar Cliente"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
