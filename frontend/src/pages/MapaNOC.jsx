import { useEffect, useState, useCallback } from "react";
import { MapContainer, TileLayer, LayersControl, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";
import "leaflet.markercluster";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
import { Globe, Loader2, Search, Users, Truck, UserPlus, Wifi, SlidersHorizontal, X } from "lucide-react";

const API = "http://localhost:3000";

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({ iconRetinaUrl: markerIcon2x, iconUrl: markerIcon, shadowUrl: markerShadow });

const ACCENT = {
  cliente:   "#3b82f6",
  suplidor:  "#f97316",
  prospecto: "#facc15",
};

const SERVICIO_COLOR = {
  "WISP (Internet)": "#3b82f6", "CCTV & Videovigilancia": "#f97316",
  "Redes Estructuradas": "#10b981", "Cercos Eléctricos": "#ef4444",
  "Control de Acceso": "#8b5cf6", "Múltiples Servicios": "#f59e0b",
  "Mayorista de Fibra": "#06b6d4", "Equipos de Seguridad y CCTV": "#ea580c",
  "Materiales Eléctricos": "#ca8a04", "Consultoría/Servicios": "#7c3aed",
};

function pin(color, pulse = false) {
  return L.divIcon({
    className: "",
    html: `<span class="relative flex w-[18px] h-[18px]">
      ${pulse ? `<span class="absolute inline-flex h-full w-full rounded-full opacity-40 animate-ping" style="background:${color}"></span>` : ""}
      <span class="relative inline-flex rounded-full w-[18px] h-[18px] border-2 border-white shadow-lg" style="background:${color}"></span>
    </span>`,
    iconSize: [18, 18], iconAnchor: [9, 9], popupAnchor: [0, -14],
  });
}

function getIcon(u) {
  if (u.tipo === "prospecto") return pin(ACCENT.prospecto, true);
  const c = SERVICIO_COLOR[u.servicio] || ACCENT[u.tipo];
  return u.activo ? pin(c, true) : pin("#64748b", false);
}

function getAccent(u) {
  if (u.tipo === "prospecto") return ACCENT.prospecto;
  return SERVICIO_COLOR[u.servicio] || ACCENT[u.tipo] || "#3b82f6";
}

function popupHTML(u) {
  const accent = getAccent(u);
  const tipo = u.tipo === "cliente" ? "Cliente" : u.tipo === "suplidor" ? "Suplidor" : "Prospecto";
  const status = u.tipo === "prospecto" ? u.estado : u.activo ? "Activo" : "Inactivo";
  return `<div style="font-family:system-ui,sans-serif;min-width:200px">
    <div style="border-left:4px solid ${accent};padding-left:8px;margin-bottom:8px">
      <div style="font-size:9px;font-weight:800;color:${accent};text-transform:uppercase;letter-spacing:.1em">${tipo} · ${status}</div>
      <div style="font-weight:700;font-size:14px;color:#1e293b;margin-top:2px;line-height:1.25">${u.nombre}</div>
    </div>
    <table style="width:100%;font-size:11px;border-collapse:collapse">
      <tr><td style="color:#94a3b8;padding-bottom:4px;width:72px">Servicio</td><td style="color:#334155;padding-bottom:4px">${u.servicio || '—'}</td></tr>
      <tr><td style="color:#94a3b8">Teléfono</td><td style="color:#334155;font-family:monospace">${u.telefono || '—'}</td></tr>
    </table>
    <a href="https://www.google.com/maps?q=${u.lat},${u.lng}" target="_blank" rel="noreferrer"
      style="display:block;margin-top:8px;padding:6px 0 2px;border-top:1px solid #e2e8f0;font-size:11px;color:${accent};font-weight:700;text-decoration:none;text-align:center">
      → Ver en Google Maps
    </a>
  </div>`;
}

function ClusterLayer({ items }) {
  const map = useMap();

  useEffect(() => {
    if (!items.length) return;
    const mcg = L.markerClusterGroup({
      chunkedLoading: true,
      maxClusterRadius: 60,
      iconCreateFunction: (cluster) => L.divIcon({
        html: `<div style="width:32px;height:32px;border-radius:50%;background:#1e40af;border:2px solid white;display:flex;align-items:center;justify-content:center;color:white;font-size:11px;font-weight:800;box-shadow:0 2px 10px rgba(0,0,0,0.5)">${cluster.getChildCount()}</div>`,
        iconSize: [32, 32], iconAnchor: [16, 16], className: "",
      }),
    });

    items.forEach(u => {
      const m = L.marker([u.lat, u.lng], { icon: getIcon(u) });
      m.bindTooltip(`<b style="font-size:12px">${u.nombre}</b>`, { direction: "top", offset: [0, -12], opacity: 0.93 });
      m.bindPopup(popupHTML(u), { minWidth: 210 });
      mcg.addLayer(m);
    });

    map.addLayer(mcg);
    return () => map.removeLayer(mcg);
  }, [map, items]);

  return null;
}

function MapController({ flyTarget }) {
  const map = useMap();
  useEffect(() => {
    if (flyTarget) map.flyTo([flyTarget.lat, flyTarget.lng], 15, { duration: 1.2 });
  }, [flyTarget, map]);
  return null;
}

export default function MapaNOC() {
  const [markers, setMarkers]           = useState([]);
  const [totales, setTotales]           = useState({ clientes: 0, suplidores: 0, prospectos: 0 });
  const [loading, setLoading]           = useState(true);
  const [showClientes, setShowClientes] = useState(true);
  const [showSuplidores, setShowSuplidores] = useState(true);
  const [showProspectos, setShowProspectos] = useState(true);
  const [soloActivos, setSoloActivos]   = useState(false);
  const [filtersOpen, setFiltersOpen]   = useState(false);
  const [searchQuery, setSearchQuery]   = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [flyTarget, setFlyTarget]       = useState(null);

  useEffect(() => {
    fetch(`${API}/api/mapa-noc`)
      .then(r => r.json())
      .then(({ markers: m, totales: t }) => {
        setMarkers(Array.isArray(m) ? m : []);
        setTotales(t || { clientes: 0, suplidores: 0, prospectos: 0 });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!searchQuery.trim()) { setSearchResults([]); return; }
    const q = searchQuery.toLowerCase();
    setSearchResults(markers.filter(u => u.nombre?.toLowerCase().includes(q)).slice(0, 8));
  }, [searchQuery, markers]);

  const visible = markers.filter(u => {
    if (u.tipo === "cliente"   && !showClientes)  return false;
    if (u.tipo === "suplidor"  && !showSuplidores) return false;
    if (u.tipo === "prospecto" && !showProspectos) return false;
    if (soloActivos && u.tipo !== "prospecto" && !u.activo) return false;
    return true;
  });

  const activosCount = markers.filter(u => u.tipo === "cliente" && u.activo).length;

  const selectResult = useCallback((u) => {
    setFlyTarget({ lat: u.lat, lng: u.lng });
    setSearchQuery(""); setSearchResults([]);
  }, []);

  const FilterBtn = ({ active, color, label, onClick }) => (
    <button onClick={onClick} className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs font-medium transition-all border ${
      active ? `bg-${color}-600/25 text-${color}-300 border-${color}-500/40` : "bg-slate-800 text-slate-500 border-slate-700"
    }`}>
      <span className={`w-2.5 h-2.5 rounded-full bg-${color}-500 flex-shrink-0`} />{label}
    </button>
  );

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center gap-3 flex-1">
          <Globe size={22} className="text-blue-400 flex-shrink-0" />
          <div>
            <h1 className="text-2xl font-bold text-slate-100 tracking-tight">Mapa NOC</h1>
            <p className="text-slate-400 text-sm">Cobertura geográfica en tiempo real</p>
          </div>
        </div>
        {/* Search */}
        <div className="relative sm:w-80">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <input
            type="text"
            placeholder="Buscar y centrar en el mapa..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition"
          />
          {searchResults.length > 0 && (
            <div className="absolute top-full left-0 right-0 z-50 mt-1 bg-slate-800 border border-slate-700 rounded-lg overflow-hidden shadow-2xl">
              {searchResults.map(u => (
                <button key={`${u.tipo}-${u.id}`} onClick={() => selectResult(u)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-slate-700/70 transition-colors border-b border-slate-700/50 last:border-0">
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: getAccent(u) }} />
                  <div className="min-w-0">
                    <p className="text-sm text-slate-200 font-medium truncate">{u.nombre}</p>
                    <p className="text-xs text-slate-500 truncate">{u.servicio}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center rounded-xl bg-slate-800/40 border border-slate-700/50" style={{ height: "calc(100vh - 140px)" }}>
          <Loader2 size={28} className="animate-spin text-blue-400" />
        </div>
      ) : (
        <div className="flex gap-4" style={{ height: "calc(100vh - 140px)" }}>

          {/* ── Mapa ── */}
          <div className="flex-1 relative min-h-0">
            <MapContainer center={[18.7357, -70.1627]} zoom={8} className="h-full w-full rounded-xl z-0">
              <LayersControl position="topright">
                <LayersControl.BaseLayer checked name="NOC Dark">
                  <TileLayer url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" attribution="&copy; CARTO" maxZoom={19} />
                </LayersControl.BaseLayer>
                <LayersControl.BaseLayer name="Satelital">
                  <TileLayer url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}" attribution="Tiles &copy; Esri" maxZoom={18} />
                </LayersControl.BaseLayer>
                <LayersControl.BaseLayer name="Calles (OSM)">
                  <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap" maxZoom={19} />
                </LayersControl.BaseLayer>
              </LayersControl>

              <ClusterLayer items={visible} />
              <MapController flyTarget={flyTarget} />
            </MapContainer>

            {/* Filter panel — desktop: always visible | mobile: collapsible */}
            {/* Mobile toggle button */}
            <button
              onClick={() => setFiltersOpen(v => !v)}
              className="md:hidden absolute bottom-4 left-4 z-[1001] w-11 h-11 rounded-full bg-slate-900/95 border border-slate-600 shadow-xl flex items-center justify-center text-slate-300 hover:text-white transition"
            >
              {filtersOpen ? <X size={18} /> : <SlidersHorizontal size={18} />}
            </button>

            {/* Panel — hidden on mobile when closed; always visible on md+ */}
            <div className={`absolute z-[1000] bg-slate-900/95 backdrop-blur-sm border border-slate-700/50 rounded-xl p-3 shadow-xl space-y-1.5 min-w-[136px]
              md:top-4 md:left-14 md:bottom-auto md:block
              ${filtersOpen ? "bottom-[60px] left-4 block" : "hidden md:block"}`}>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest px-0.5 pb-1">Filtros</p>
              <button onClick={() => setShowClientes(v => !v)}
                className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs font-medium transition-all border ${showClientes ? "bg-blue-600/25 text-blue-300 border-blue-500/40" : "bg-slate-800 text-slate-500 border-slate-700"}`}>
                <span className="w-2.5 h-2.5 rounded-full bg-blue-500 flex-shrink-0" />Clientes
              </button>
              <button onClick={() => setShowSuplidores(v => !v)}
                className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs font-medium transition-all border ${showSuplidores ? "bg-orange-600/25 text-orange-300 border-orange-500/40" : "bg-slate-800 text-slate-500 border-slate-700"}`}>
                <span className="w-2.5 h-2.5 rounded-full bg-orange-500 flex-shrink-0" />Suplidores
              </button>
              <button onClick={() => setShowProspectos(v => !v)}
                className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs font-medium transition-all border ${showProspectos ? "bg-yellow-600/25 text-yellow-300 border-yellow-500/40" : "bg-slate-800 text-slate-500 border-slate-700"}`}>
                <span className="w-2.5 h-2.5 rounded-full bg-yellow-400 flex-shrink-0" />Prospectos
              </button>
              <button onClick={() => setSoloActivos(v => !v)}
                className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs font-medium transition-all border ${soloActivos ? "bg-emerald-600/25 text-emerald-300 border-emerald-500/40" : "bg-slate-800 text-slate-500 border-slate-700"}`}>
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 flex-shrink-0" />Solo Activos
              </button>
            </div>
          </div>

          {/* ── Side Panel ── */}
          <div className="hidden lg:flex w-60 flex-shrink-0 flex-col gap-3 overflow-y-auto">

            {/* Métricas de infraestructura */}
            <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-4 space-y-3 flex-shrink-0">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Infraestructura</p>
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Wifi size={14} className="text-emerald-400" />
                    <span className="text-sm text-slate-300">Nodos Activos</span>
                  </div>
                  <span className="text-xl font-bold text-emerald-400 font-mono">{activosCount}</span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Users size={14} className="text-blue-400" />
                    <span className="text-sm text-slate-300">Clientes</span>
                  </div>
                  <span className="text-xl font-bold text-slate-100 font-mono">{totales.clientes}</span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <UserPlus size={14} className="text-yellow-400" />
                    <span className="text-sm text-slate-300">Leads en zona</span>
                  </div>
                  <span className="text-xl font-bold text-yellow-400 font-mono">{totales.prospectos}</span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Truck size={14} className="text-orange-400" />
                    <span className="text-sm text-slate-300">Suplidores</span>
                  </div>
                  <span className="text-xl font-bold text-slate-100 font-mono">{totales.suplidores}</span>
                </div>
              </div>
            </div>

            {/* Coords summary */}
            <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-3 flex-shrink-0">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2.5">Cobertura</p>
              <div className="space-y-1.5 text-xs">
                <div className="flex justify-between text-slate-400"><span>Con coordenadas</span><span className="text-slate-200 font-mono font-semibold">{markers.length}</span></div>
                <div className="flex justify-between text-slate-400"><span>Visibles ahora</span><span className="text-slate-200 font-mono font-semibold">{visible.length}</span></div>
              </div>
            </div>

            {/* List */}
            <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-3 flex-1 overflow-y-auto min-h-0">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">En el Mapa</p>
              {visible.length === 0 ? (
                <p className="text-xs text-slate-600 text-center py-6">Sin registros visibles</p>
              ) : (
                <div className="space-y-1">
                  {visible.map(u => (
                    <button key={`${u.tipo}-${u.id}`} onClick={() => selectResult(u)}
                      className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-slate-700/50 transition-colors group">
                      <div className="flex items-start gap-2">
                        <span className="w-2 h-2 rounded-full mt-1 flex-shrink-0" style={{ background: getAccent(u) }} />
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-slate-300 group-hover:text-slate-100 truncate leading-tight">{u.nombre}</p>
                          <p className="text-[10px] text-slate-600 truncate">{u.servicio}</p>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
