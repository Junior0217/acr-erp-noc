import { useState, useEffect } from "react";
import { X, Save, User, MapPin, Briefcase, Phone, Loader2, PowerOff, Power, AlertTriangle, Map, CreditCard, Crosshair } from "lucide-react";
import MapPicker from "./MapPicker";

const API = "http://localhost:3000";

const INPUT =
  "w-full bg-slate-800 border border-blue-600/30 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition";
const LABEL =
  "block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1";
const SECTION =
  "text-xs font-bold text-blue-400 uppercase tracking-widest border-b border-blue-600/20 pb-1 mb-3 col-span-full flex items-center gap-2";

const TIPOS_EMPRESA = ["SRL", "SA", "EIRL", "SAS", "Unipersonal"];
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

        <form onSubmit={handleSubmit} className="p-6 space-y-6">

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
              <label className={LABEL}>Teléfono Principal *</label>
              <input required className={INPUT} value={form.telefono} onChange={masked("telefono", formatPhone)} placeholder="809-XXX-XXXX" maxLength={12} />
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
