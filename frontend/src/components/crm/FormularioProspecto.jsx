import { useState, useEffect } from "react";
import { X, Save, Trash2, UserCheck, MapPin, Crosshair, Map } from "lucide-react";
import MapPicker from "./MapPicker";

const API = "http://localhost:3000";

const SERVICIOS = [
  "Internet WISP", "Fibra Óptica", "CCTV / Videovigilancia",
  "Alarma", "Red LAN/WiFi", "Telefonía IP", "Mantenimiento", "Otro",
];
const ORIGENES = ["WhatsApp", "Llamada", "Referido", "Web", "Presencial", "Otro"];
const ESTADOS  = ["Nuevo", "Contactado", "Interesado", "Negociación", "Perdido", "Convertido"];

function formatPhone(v) {
  const d = String(v).replace(/\D/g, "").slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}

const EMPTY = {
  nombre: "", telefono: "", servicioInteresado: "", origen: "WhatsApp",
  estado: "Nuevo", latitud: "", longitud: "", notas: "",
};

const INPUT = "w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition";
const LABEL = "block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1";

export default function FormularioProspecto({ initialData, onClose, onSave, onConvertir }) {
  const isEdit = !!initialData?.id;
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [showMapPicker, setShowMapPicker] = useState(false);

  useEffect(() => {
    if (initialData) {
      setForm({
        nombre:             initialData.nombre             || "",
        telefono:           formatPhone(initialData.telefono || ""),
        servicioInteresado: initialData.servicioInteresado || "",
        origen:             initialData.origen             || "WhatsApp",
        estado:             initialData.estado             || "Nuevo",
        latitud:            initialData.latitud            || "",
        longitud:           initialData.longitud           || "",
        notas:              initialData.notas              || "",
      });
    } else {
      setForm(EMPTY);
    }
    setError("");
    setShowMapPicker(false);
  }, [initialData]);

  const set = (field, value) => setForm(prev => ({ ...prev, [field]: value }));
  const masked = (field, fn) => (e) => set(field, fn(e.target.value));

  const handleMapPick = (la, lo) => {
    setForm(prev => ({ ...prev, latitud: String(la.toFixed(6)), longitud: String(lo.toFixed(6)) }));
  };

  const buildPayload = () => ({
    nombre:             form.nombre,
    telefono:           form.telefono.replace(/\D/g, ""),
    servicioInteresado: form.servicioInteresado,
    origen:             form.origen,
    estado:             form.estado,
    latitud:            form.latitud  || null,
    longitud:           form.longitud || null,
    notas:              form.notas    || null,
  });

  const handleSave = async () => {
    setError("");
    if (!form.nombre.trim())                          { setError("El nombre es obligatorio."); return; }
    if (form.telefono.replace(/\D/g, "").length < 7)  { setError("Teléfono inválido."); return; }
    if (!form.servicioInteresado)                     { setError("Selecciona un servicio."); return; }
    setSaving(true);
    try {
      const url    = isEdit ? `${API}/api/prospectos/${initialData.id}` : `${API}/api/prospectos`;
      const method = isEdit ? "PUT" : "POST";
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(buildPayload()) });
      if (!res.ok) { const j = await res.json(); setError(j.error || "Error al guardar."); return; }
      onSave();
    } catch { setError("Error de conexión."); }
    finally { setSaving(false); }
  };

  const handleDelete = async () => {
    if (!isEdit || !window.confirm(`¿Eliminar prospecto "${form.nombre}"?`)) return;
    setDeleting(true);
    try { await fetch(`${API}/api/prospectos/${initialData.id}`, { method: "DELETE" }); onSave(); }
    catch { setError("Error al eliminar."); }
    finally { setDeleting(false); }
  };

  const canOpenMap = form.latitud && form.longitud;
  const canConvert = isEdit && form.estado !== "Convertido";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-700/60 rounded-2xl w-full max-w-lg shadow-2xl flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700/50">
          <div>
            <h2 className="text-lg font-bold text-slate-100">{isEdit ? "Editar Prospecto" : "Nuevo Prospecto"}</h2>
            {isEdit && <p className="text-xs text-slate-500 mt-0.5">Ingresado: {new Date(initialData.createdAt).toLocaleDateString("es-DO")}</p>}
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition"><X size={18} /></button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-4">

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <label className={LABEL}>Nombre completo *</label>
              <input className={INPUT} placeholder="Juan Pérez" value={form.nombre} onChange={(e) => set("nombre", e.target.value)} />
            </div>
            <div>
              <label className={LABEL}>Teléfono *</label>
              <input className={INPUT} placeholder="809-000-0000" value={form.telefono} onChange={masked("telefono", formatPhone)} />
            </div>
            <div>
              <label className={LABEL}>Origen</label>
              <select className={INPUT} value={form.origen} onChange={(e) => set("origen", e.target.value)}>
                {ORIGENES.map(o => <option key={o}>{o}</option>)}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className={LABEL}>Servicio interesado *</label>
              <select className={INPUT} value={form.servicioInteresado} onChange={(e) => set("servicioInteresado", e.target.value)}>
                <option value="">Seleccionar...</option>
                {SERVICIOS.map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className={LABEL}>Estado</label>
              <select className={INPUT} value={form.estado} onChange={(e) => set("estado", e.target.value)}>
                {ESTADOS.map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className={LABEL}>Notas</label>
            <textarea
              value={form.notas}
              onChange={(e) => set("notas", e.target.value)}
              rows={3}
              placeholder="Detalles adicionales..."
              className={`${INPUT} resize-none`}
            />
          </div>

          {/* Ubicación */}
          <div>
            <label className={LABEL}>Ubicación (opcional)</label>
            <div className="grid grid-cols-2 gap-2 mb-2">
              <input className={INPUT} placeholder="Latitud" value={form.latitud} onChange={(e) => set("latitud", e.target.value)} />
              <input className={INPUT} placeholder="Longitud" value={form.longitud} onChange={(e) => set("longitud", e.target.value)} />
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowMapPicker((v) => !v)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
                  showMapPicker
                    ? "bg-blue-600/30 border-blue-500/50 text-blue-300"
                    : "bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200 hover:border-blue-500/40"
                }`}
              >
                <Crosshair size={12} />Fijar en mapa
              </button>
              {canOpenMap && (
                <a
                  href={`https://www.google.com/maps?q=${form.latitud},${form.longitud}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200 hover:border-blue-500/40 transition"
                >
                  <Map size={12} />Ver en Maps
                </a>
              )}
            </div>
            <p className="text-xs text-slate-600 mt-1.5 flex items-center gap-1"><MapPin size={10} />Ej: 18.4861, -69.9312</p>
            {showMapPicker && (
              <MapPicker lat={form.latitud} lng={form.longitud} onPick={handleMapPick} />
            )}
          </div>

          {error && (
            <div className="px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">{error}</div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-700/50 flex items-center justify-between gap-3">
          <div className="flex gap-2">
            {isEdit && (
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-red-400 text-sm font-medium transition disabled:opacity-50"
              >
                <Trash2 size={14} />{deleting ? "Eliminando..." : "Eliminar"}
              </button>
            )}
            {canConvert && (
              <button
                onClick={() => onConvertir({ ...initialData, ...buildPayload(), id: initialData.id })}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cyan-600/20 hover:bg-cyan-500/30 border border-cyan-500/50 text-cyan-300 hover:text-cyan-100 text-sm font-semibold transition shadow-lg shadow-cyan-600/10"
              >
                <UserCheck size={14} />Convertir a Cliente
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-300 text-sm font-medium transition">
              Cancelar
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-2 px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition disabled:opacity-50 shadow-lg shadow-blue-600/20"
            >
              <Save size={15} />{saving ? "Guardando..." : isEdit ? "Actualizar" : "Guardar"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
