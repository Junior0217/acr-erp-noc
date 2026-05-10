import { useEffect, useState } from "react";
import { MapContainer, TileLayer, Marker, useMapEvents, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { Navigation } from "lucide-react";

const PIN = L.divIcon({
  className: "",
  html: `<div style="width:14px;height:14px;background:#3b82f6;border:2px solid white;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,0.5)"></div>`,
  iconSize: [14, 14], iconAnchor: [7, 7],
});

function ClickHandler({ onPick }) {
  useMapEvents({ click: (e) => onPick(e.latlng.lat, e.latlng.lng) });
  return null;
}

function GeoButton({ onPick }) {
  const map = useMap();
  const [busy, setBusy] = useState(false);

  const locate = () => {
    if (!navigator.geolocation) return;
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        map.flyTo([lat, lng], 16, { duration: 1 });
        onPick(lat, lng);
        setBusy(false);
      },
      () => setBusy(false),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  };

  return (
    <button
      type="button"
      onClick={locate}
      disabled={busy}
      title="Mi ubicación actual"
      style={{
        position: "absolute", bottom: 10, right: 10, zIndex: 1000,
        background: busy ? "#475569" : "#1e40af",
        border: "2px solid white", borderRadius: 8,
        padding: "6px 10px", cursor: busy ? "wait" : "pointer",
        display: "flex", alignItems: "center", gap: 6,
        color: "white", fontSize: 11, fontWeight: 700,
        boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
      }}
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="3 11 22 2 13 21 11 13 3 11"/>
      </svg>
      {busy ? "Localizando..." : "Mi Ubicación"}
    </button>
  );
}

export default function MapPicker({ lat, lng, onPick }) {
  const la = parseFloat(lat);
  const lo = parseFloat(lng);
  const hasPos = !isNaN(la) && !isNaN(lo) && (la !== 0 || lo !== 0);
  const center = hasPos ? [la, lo] : [18.7357, -70.1627];

  return (
    <div className="relative h-52 rounded-lg overflow-hidden border border-blue-600/30 mt-2">
      <div className="absolute top-2 left-1/2 -translate-x-1/2 z-[1000] pointer-events-none">
        <span className="bg-slate-900/85 text-xs text-slate-300 px-2.5 py-1 rounded-full backdrop-blur-sm">
          Clic en el mapa para fijar coordenadas
        </span>
      </div>
      <MapContainer center={center} zoom={hasPos ? 15 : 8} className="h-full w-full z-0" scrollWheelZoom>
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          attribution="&copy; CARTO"
        />
        <ClickHandler onPick={onPick} />
        <GeoButton onPick={onPick} />
        {hasPos && <Marker position={[la, lo]} icon={PIN} />}
      </MapContainer>
    </div>
  );
}
