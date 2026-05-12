import { useState, useEffect } from "react";
import { apiFetch } from "../utils/api";
import { useAuth } from "../contexts/AuthContext";
import {
  TrendingUp, BarChart2, Loader2, Users2, Wrench, DollarSign,
  CalendarDays, ShieldOff,
} from "lucide-react";

function formatCurrency(val) {
  return new Intl.NumberFormat("es-DO", {
    style: "currency", currency: "DOP",
    minimumFractionDigits: 0, maximumFractionDigits: 0,
  }).format(Number(val) || 0);
}

function StatCard({ icon: Icon, label, value, sub, color = "blue" }) {
  const colors = {
    blue:   "bg-blue-600/15 text-blue-400 border-blue-600/30",
    emerald:"bg-emerald-600/15 text-emerald-400 border-emerald-600/30",
    orange: "bg-orange-600/15 text-orange-400 border-orange-600/30",
    purple: "bg-purple-600/15 text-purple-400 border-purple-600/30",
  };
  return (
    <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-5 flex items-center gap-4">
      <div className={`p-3 rounded-xl border ${colors[color]}`}>
        <Icon size={20} />
      </div>
      <div>
        <p className="text-xs text-slate-500 font-medium uppercase tracking-wider">{label}</p>
        <p className="text-2xl font-bold text-slate-100 mt-0.5">{value}</p>
        {sub && <p className="text-xs text-slate-500 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

function BarMini({ label, value, max, color = "bg-blue-500" }) {
  const pct = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  const day = label?.slice(5);
  return (
    <div className="flex flex-col items-center gap-1.5 flex-1 min-w-0">
      <div className="w-full bg-slate-700/50 rounded-full overflow-hidden h-24 flex flex-col justify-end">
        <div
          className={`${color} rounded-t-sm transition-all duration-500`}
          style={{ height: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] text-slate-500 font-mono">{day}</span>
    </div>
  );
}

const MESES = [
  "Enero","Febrero","Marzo","Abril","Mayo","Junio",
  "Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre",
];

export default function Reportes() {
  const { tienePermiso } = useAuth();
  const [tab, setTab] = useState("semanal");

  const [semanal, setSemanal] = useState(null);
  const [loadingSemanal, setLoadingSemanal] = useState(false);

  const now = new Date();
  const [mesCom,  setMesCom]  = useState(now.getMonth() + 1);
  const [anioCom, setAnioCom] = useState(now.getFullYear());
  const [comisiones, setComisiones] = useState(null);
  const [loadingCom, setLoadingCom] = useState(false);

  useEffect(() => {
    if (tab !== "semanal") return;
    setLoadingSemanal(true);
    apiFetch("/api/reportes/semanal")
      .then(r => r.json())
      .then(j => setSemanal(j))
      .catch(() => {})
      .finally(() => setLoadingSemanal(false));
  }, [tab]);

  useEffect(() => {
    if (tab !== "comisiones") return;
    setLoadingCom(true);
    apiFetch(`/api/reportes/comisiones?mes=${mesCom}&anio=${anioCom}`)
      .then(r => r.json())
      .then(j => setComisiones(j))
      .catch(() => {})
      .finally(() => setLoadingCom(false));
  }, [tab, mesCom, anioCom]);

  if (!tienePermiso("sistema:owner")) return (
    <div className="flex flex-col items-center justify-center h-64 gap-3 text-slate-500">
      <ShieldOff size={32} />
      <p className="text-sm font-medium">Solo propietarios pueden ver reportes.</p>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 p-4 md:p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-100 tracking-tight">Reportes</h1>
        <p className="text-slate-400 text-sm mt-0.5">KPIs · Análisis · Comisiones</p>
      </div>

      <div className="flex gap-1 bg-slate-800/60 border border-slate-700/50 rounded-xl p-1 w-fit">
        {[
          { id: "semanal",    label: "Resumen Semanal", Icon: TrendingUp },
          { id: "comisiones", label: "Comisiones",      Icon: Users2     },
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

      {/* ── SEMANAL ── */}
      {tab === "semanal" && (
        <div className="space-y-6">
          {loadingSemanal ? (
            <div className="flex justify-center py-16">
              <Loader2 size={28} className="animate-spin text-blue-500" />
            </div>
          ) : semanal ? (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <StatCard icon={DollarSign}  label="Ingresos Semana"  value={formatCurrency(semanal.totalSemana)}  color="emerald" />
                <StatCard icon={CalendarDays} label="Ingresos Mes"   value={formatCurrency(semanal.totalMes)}      color="blue" />
                <StatCard icon={Wrench}       label="OTs Cerradas"   value={semanal.otsCerradas}                    color="orange" />
                <StatCard icon={BarChart2}    label="Categorías"     value={Object.keys(semanal.ingresosPorCategoria).length} color="purple" />
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Bar chart */}
                <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-5">
                  <h3 className="text-sm font-semibold text-slate-300 mb-4">Ingresos por Día (últimos 7 días)</h3>
                  <div className="flex items-end gap-2 h-28">
                    {Object.entries(semanal.ingresoPorDia).map(([day, val]) => {
                      const max = Math.max(...Object.values(semanal.ingresoPorDia), 1);
                      return <BarMini key={day} label={day} value={val} max={max} />;
                    })}
                  </div>
                </div>

                {/* Por categoría */}
                <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-5">
                  <h3 className="text-sm font-semibold text-slate-300 mb-4">Ingresos por Categoría (semana)</h3>
                  <div className="space-y-2">
                    {Object.entries(semanal.ingresosPorCategoria).length === 0 && (
                      <p className="text-xs text-slate-600 text-center py-4">Sin datos esta semana.</p>
                    )}
                    {Object.entries(semanal.ingresosPorCategoria)
                      .sort((a, b) => b[1] - a[1])
                      .map(([cat, val]) => {
                        const maxVal = Math.max(...Object.values(semanal.ingresosPorCategoria), 1);
                        const pct = (val / maxVal) * 100;
                        return (
                          <div key={cat}>
                            <div className="flex justify-between text-xs mb-1">
                              <span className="text-slate-400">{cat}</span>
                              <span className="text-slate-200 font-mono">{formatCurrency(val)}</span>
                            </div>
                            <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
                              <div className="h-full bg-blue-500 rounded-full" style={{ width: `${pct}%` }} />
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </div>
              </div>

              {/* OTs detalle */}
              {semanal.otsDetalle?.length > 0 && (
                <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl overflow-hidden">
                  <div className="px-5 py-4 border-b border-slate-700/50">
                    <h3 className="text-sm font-semibold text-slate-300">OTs Cerradas esta Semana</h3>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-slate-700/50 bg-slate-800/60">
                          <th className="text-left px-4 py-3 text-slate-400 text-xs font-semibold uppercase tracking-wider">No. OT</th>
                          <th className="text-left px-4 py-3 text-slate-400 text-xs font-semibold uppercase tracking-wider">Tipo</th>
                          <th className="text-left px-4 py-3 text-slate-400 text-xs font-semibold uppercase tracking-wider">Técnico</th>
                          <th className="text-left px-4 py-3 text-slate-400 text-xs font-semibold uppercase tracking-wider">Fecha Cierre</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/80">
                        {semanal.otsDetalle.map(ot => (
                          <tr key={ot.id} className="hover:bg-slate-800/50 transition-colors">
                            <td className="px-4 py-3 font-mono text-xs text-slate-400">{ot.noOT}</td>
                            <td className="px-4 py-3 text-slate-300">{ot.tipoOT}</td>
                            <td className="px-4 py-3 text-slate-300">{ot.tecnicoNombre ?? "—"}</td>
                            <td className="px-4 py-3 text-slate-500 text-xs">
                              {new Date(ot.updatedAt).toLocaleDateString("es-DO")}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          ) : (
            <p className="text-slate-600 text-sm text-center py-10">Sin datos.</p>
          )}
        </div>
      )}

      {/* ── COMISIONES ── */}
      {tab === "comisiones" && (
        <div className="space-y-6">
          <div className="flex flex-wrap gap-3 items-center">
            <select
              value={mesCom}
              onChange={e => setMesCom(Number(e.target.value))}
              className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
            >
              {MESES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
            </select>
            <select
              value={anioCom}
              onChange={e => setAnioCom(Number(e.target.value))}
              className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
            >
              {[2024, 2025, 2026].map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>

          {loadingCom ? (
            <div className="flex justify-center py-16">
              <Loader2 size={28} className="animate-spin text-blue-500" />
            </div>
          ) : comisiones ? (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <StatCard icon={DollarSign} label="Total Comisiones" value={formatCurrency(comisiones.totalComisiones)} color="emerald" />
                <StatCard icon={Users2}     label="Técnicos"         value={comisiones.tecnicos?.length ?? 0}          color="blue" />
                <StatCard icon={Wrench}     label="OTs Calculadas"   value={comisiones.tecnicos?.reduce((s, t) => s + t.ots, 0) ?? 0} color="orange" />
              </div>

              {comisiones.tecnicos?.length === 0 ? (
                <p className="text-slate-600 text-sm text-center py-10">Sin OTs cerradas este período.</p>
              ) : (
                <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-slate-700/50 bg-slate-800/60">
                          <th className="text-left px-4 py-3 text-slate-400 text-xs font-semibold uppercase tracking-wider">Técnico</th>
                          <th className="text-right px-4 py-3 text-slate-400 text-xs font-semibold uppercase tracking-wider">OTs</th>
                          <th className="text-right px-4 py-3 text-slate-400 text-xs font-semibold uppercase tracking-wider">Facturado</th>
                          <th className="text-right px-4 py-3 text-slate-400 text-xs font-semibold uppercase tracking-wider">Comisión</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/80">
                        {comisiones.tecnicos.map(t => (
                          <tr key={t.nombre} className="hover:bg-slate-800/50 transition-colors">
                            <td className="px-4 py-3 font-medium text-slate-100">{t.nombre}</td>
                            <td className="px-4 py-3 text-right text-slate-300">{t.ots}</td>
                            <td className="px-4 py-3 text-right font-mono text-xs text-slate-300">{formatCurrency(t.totalFacturado)}</td>
                            <td className="px-4 py-3 text-right font-mono text-xs text-emerald-400 font-semibold">{formatCurrency(t.comisionTotal)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          ) : (
            <p className="text-slate-600 text-sm text-center py-10">Sin datos.</p>
          )}
        </div>
      )}
    </div>
  );
}
