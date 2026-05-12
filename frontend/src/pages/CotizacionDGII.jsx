import { useEffect } from "react"
import ACRLogo from "../components/ACRLogo"

const ITEMS = [
  {
    n:     1,
    sku:   "CCTV-16CH-4K",
    desc:  "Suministro e Instalación de Sistema CCTV 16 Cámaras IP Hikvision 4K",
    detalle: "16 cámaras IP 4K Hikvision · NVR 16CH · Disco 4TB · Cableado UTP Cat6 · Configuración DDNS · Acceso móvil iOS/Android · 1 año de garantía",
    cant:  1,
    precio: 85000,
  },
  {
    n:     2,
    sku:   "RED-LAN-12P",
    desc:  "Mantenimiento, Configuración e Instalación de Red LAN — 12 puntos Cat6",
    detalle: "Cableado estructurado Cat6 · 12 puntos · Patch panel 24p · Switch administrable 24p · Certificación · Documentación técnica",
    cant:  1,
    precio: 22000,
  },
]

function fmt(n) {
  return new Intl.NumberFormat("es-DO", {
    style: "currency", currency: "DOP",
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(n).replace("DOP", "RD$")
}

function nextNoCotizacion() {
  const d = new Date()
  return `COT-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-001`
}

function fechaLarga(d = new Date()) {
  return d.toLocaleDateString("es-DO", { day: "numeric", month: "long", year: "numeric" })
}

function fechaVence() {
  const v = new Date()
  v.setDate(v.getDate() + 15)
  return v.toLocaleDateString("es-DO", { day: "numeric", month: "long", year: "numeric" })
}

export default function CotizacionDGII() {
  useEffect(() => { document.title = "Cotización ACR Networks · DGII" }, [])

  const subtotal = ITEMS.reduce((s, i) => s + i.precio * i.cant, 0)
  const itbis    = +(subtotal * 0.18).toFixed(2)
  const total    = +(subtotal + itbis).toFixed(2)

  return (
    <>
      <style>{`
        @page { size: Letter; margin: 8mm 10mm; }
        @media print {
          html, body { background: white !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .no-print { display: none !important; }
          .cot-page { box-shadow: none !important; margin: 0 !important; width: 100% !important; min-height: 0 !important; padding: 0 !important; page-break-after: avoid; page-break-inside: avoid; }
          .cot-page table { page-break-inside: avoid; }
          .cot-page section { page-break-inside: avoid; }
          .cot-page footer { page-break-inside: avoid; }
        }
        .cot-page { font-family: 'Inter', 'Segoe UI', system-ui, sans-serif; color: #1a202c; font-size: 11px; line-height: 1.35; }
        .cot-page h1, .cot-page h2, .cot-page h3 { font-family: 'Inter', 'Segoe UI', system-ui, sans-serif; letter-spacing: -0.01em; }
        .cot-page .label-mono { font-family: ui-monospace, 'SF Mono', Menlo, monospace; }
      `}</style>

      <div className="bg-slate-300 min-h-screen py-6 print:bg-white print:py-0">
        {/* Toolbar */}
        <div className="no-print max-w-[820px] mx-auto mb-3 flex items-center justify-between bg-white border border-slate-300 rounded-lg p-3 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-blue-600/10 flex items-center justify-center">
              <ACRLogo size={26} />
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-800">Cotización — 1 página · listo para PDF</p>
              <p className="text-xs text-slate-500">
                <kbd className="px-1.5 py-0.5 bg-slate-100 border border-slate-300 rounded text-[10px] font-mono">Ctrl+P</kbd>
                {" "}→ Destino: <b>PDF</b> · Tamaño: <b>Carta</b> · Márgenes: <b>Ninguno</b> · Gráficos de fondo: <b>ON</b>
              </p>
            </div>
          </div>
          <button
            onClick={() => window.print()}
            className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold shadow"
          >
            🖨️ Guardar PDF
          </button>
        </div>

        {/* Hoja */}
        <div
          className="cot-page mx-auto bg-white shadow-2xl print:shadow-none"
          style={{ width: "820px", padding: "26px 34px" }}
        >
          {/* ── HEADER compacto ── */}
          <header className="flex items-start justify-between pb-3 border-b-[3px] border-blue-700">
            <div className="flex items-start gap-3">
              <ACRLogo size={54} />
              <div>
                <h1 className="text-[18px] font-extrabold text-slate-900 leading-tight">ACR NETWORKS &amp; SOLUTIONS, S.R.L.</h1>
                <p className="text-[10px] text-slate-600 tracking-wide leading-snug">Soluciones en Seguridad Electrónica, Redes y Soporte IT Corporativo</p>
                <div className="mt-1.5 grid grid-cols-2 gap-x-5 text-[10px] text-slate-700 leading-tight">
                  <div><span className="font-semibold text-slate-500">RNC:</span> <span className="label-mono">133-69267-8</span></div>
                  <div><span className="font-semibold text-slate-500">Reg. Mercantil:</span> <span className="label-mono">161830SD</span></div>
                  <div className="col-span-2"><span className="font-semibold text-slate-500">Dirección:</span> Calle Feliz Evaristo Mejía No. 406, Cristo Rey, D.N.</div>
                  <div><span className="font-semibold text-slate-500">Tel.:</span> <span className="label-mono">849-458-9955</span></div>
                  <div className="truncate"><span className="font-semibold text-slate-500">Email:</span> ranetworkssolutions@gmail.com</div>
                </div>
              </div>
            </div>

            <div className="text-right flex-shrink-0 ml-3">
              <div className="bg-blue-700 text-white px-4 py-2 rounded-tl-xl rounded-br-xl whitespace-nowrap">
                <p className="text-[9px] uppercase tracking-[0.18em] opacity-80 leading-none">Cotización</p>
                <p className="text-[18px] font-extrabold label-mono mt-0.5 leading-none whitespace-nowrap">{nextNoCotizacion()}</p>
              </div>
              <div className="mt-2 text-[10px] text-slate-700 space-y-0 leading-tight">
                <p><span className="font-semibold text-slate-500">Emisión:</span> {fechaLarga()}</p>
                <p><span className="font-semibold text-slate-500">Válida hasta:</span> {fechaVence()}</p>
                <p><span className="font-semibold text-slate-500">Moneda:</span> DOP</p>
              </div>
            </div>
          </header>

          {/* ── CLIENTE ── */}
          <section className="mt-3">
            <div className="flex items-center gap-1.5 mb-1">
              <div className="w-0.5 h-3.5 bg-blue-700 rounded" />
              <h2 className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.16em]">Cotizado a / Cliente</h2>
            </div>
            <div className="border border-slate-200 rounded-md p-2.5 bg-slate-50/50">
              <div className="grid grid-cols-3 gap-3 text-[11px]">
                <div className="col-span-3">
                  <p className="text-[9px] uppercase font-semibold text-slate-500 tracking-wider leading-none">Razón Social</p>
                  <p className="text-[14px] font-bold text-slate-900 leading-tight">CONSTRUCTORA J&amp;P DOMINICANA, S.R.L.</p>
                </div>
                <div>
                  <p className="text-[9px] uppercase font-semibold text-slate-500 tracking-wider leading-none">RNC</p>
                  <p className="label-mono text-slate-800 leading-tight">130-00000-1</p>
                </div>
                <div className="col-span-2">
                  <p className="text-[9px] uppercase font-semibold text-slate-500 tracking-wider leading-none">Dirección</p>
                  <p className="text-slate-800 leading-tight">Av. Winston Churchill, Piantini, Santo Domingo, D.N.</p>
                </div>
              </div>
            </div>
          </section>

          {/* ── ITEMS ── */}
          <section className="mt-3">
            <div className="flex items-center gap-1.5 mb-1">
              <div className="w-0.5 h-3.5 bg-blue-700 rounded" />
              <h2 className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.16em]">Servicios y Productos Cotizados</h2>
            </div>

            <table className="w-full text-[11px] border-collapse">
              <thead>
                <tr className="bg-blue-700 text-white">
                  <th className="px-2 py-1.5 text-left font-semibold w-8">#</th>
                  <th className="px-2 py-1.5 text-left font-semibold">Descripción</th>
                  <th className="px-2 py-1.5 text-center font-semibold w-12">Cant.</th>
                  <th className="px-2 py-1.5 text-right font-semibold w-28">P. Unitario</th>
                  <th className="px-2 py-1.5 text-right font-semibold w-28">Importe</th>
                </tr>
              </thead>
              <tbody>
                {ITEMS.map((it, idx) => (
                  <tr key={it.n} className={idx % 2 ? "bg-slate-50" : "bg-white"}>
                    <td className="px-2 py-1.5 align-top text-slate-500 label-mono">{String(it.n).padStart(2, "0")}</td>
                    <td className="px-2 py-1.5 align-top">
                      <p className="font-semibold text-slate-900 leading-tight">{it.desc}</p>
                      <p className="text-[9.5px] text-slate-600 mt-0.5 leading-snug">{it.detalle}</p>
                      <p className="text-[9px] text-slate-400 label-mono mt-0.5">SKU: {it.sku}</p>
                    </td>
                    <td className="px-2 py-1.5 align-top text-center label-mono text-slate-700">{it.cant}</td>
                    <td className="px-2 py-1.5 align-top text-right label-mono text-slate-700 whitespace-nowrap">{fmt(it.precio)}</td>
                    <td className="px-2 py-1.5 align-top text-right label-mono font-semibold text-slate-900 whitespace-nowrap">{fmt(it.precio * it.cant)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {/* ── TOTALES ── */}
          <section className="mt-2 flex justify-end">
            <div className="w-72">
              <div className="space-y-0 text-[11px]">
                <div className="flex justify-between py-1 border-b border-slate-200">
                  <span className="text-slate-600">Subtotal</span>
                  <span className="label-mono font-semibold text-slate-900 whitespace-nowrap">{fmt(subtotal)}</span>
                </div>
                <div className="flex justify-between py-1 border-b border-slate-200">
                  <span className="text-slate-600">ITBIS (18%)</span>
                  <span className="label-mono font-semibold text-slate-900 whitespace-nowrap">{fmt(itbis)}</span>
                </div>
                <div className="flex justify-between items-center bg-blue-700 text-white px-3 py-2 rounded mt-1.5">
                  <span className="text-[10px] uppercase tracking-wider font-semibold">Total</span>
                  <span className="label-mono text-[16px] font-extrabold whitespace-nowrap">{fmt(total)}</span>
                </div>
              </div>
            </div>
          </section>

          {/* ── CONDICIONES (grid 4 columnas compactas) ── */}
          <section className="mt-3">
            <div className="flex items-center gap-1.5 mb-1">
              <div className="w-0.5 h-3.5 bg-blue-700 rounded" />
              <h2 className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.16em]">Condiciones Comerciales</h2>
            </div>
            <div className="grid grid-cols-4 gap-2 text-[10px]">
              <div className="border border-slate-200 rounded-md p-2 bg-slate-50/50">
                <p className="text-[8.5px] uppercase font-semibold text-slate-500 tracking-wider leading-none">Validez</p>
                <p className="text-slate-800 mt-0.5 font-medium leading-snug">15 días calendario.</p>
              </div>
              <div className="border border-slate-200 rounded-md p-2 bg-slate-50/50">
                <p className="text-[8.5px] uppercase font-semibold text-slate-500 tracking-wider leading-none">Forma de Pago</p>
                <p className="text-slate-800 mt-0.5 font-medium leading-snug">50% avance · 50% contra entrega.</p>
              </div>
              <div className="border border-slate-200 rounded-md p-2 bg-slate-50/50">
                <p className="text-[8.5px] uppercase font-semibold text-slate-500 tracking-wider leading-none">Tiempo de Entrega</p>
                <p className="text-slate-800 mt-0.5 font-medium leading-snug">5 a 10 días laborables.</p>
              </div>
              <div className="border border-slate-200 rounded-md p-2 bg-slate-50/50">
                <p className="text-[8.5px] uppercase font-semibold text-slate-500 tracking-wider leading-none">Garantía</p>
                <p className="text-slate-800 mt-0.5 font-medium leading-snug">1 año CCTV · 6m red · soporte 30d.</p>
              </div>
            </div>
          </section>

          {/* ── FIRMA compacta ── */}
          <section className="mt-5 flex justify-between items-end">
            <div className="text-[10px] text-slate-500 max-w-[200px] leading-snug">
              <p className="font-semibold text-slate-700 mb-1">Aceptación del Cliente</p>
              <div className="border-t border-slate-400 w-full mt-6" />
              <p className="mt-1 text-center text-[9.5px]">Firma y sello</p>
            </div>
            <div className="text-center">
              <div className="border-t-2 border-slate-700 w-56 mt-6" />
              <p className="mt-1 text-[12px] font-bold text-slate-900 whitespace-nowrap">CARMELO JUNIOR ROSARIO LOPEZ</p>
              <p className="text-[10px] text-slate-600">Gerente · ACR Networks &amp; Solutions, S.R.L.</p>
            </div>
          </section>

          {/* ── FOOTER ── */}
          <footer className="mt-3 pt-2 border-t border-slate-200 flex items-center justify-between text-[9px] text-slate-500">
            <div className="flex items-center gap-2">
              <ACRLogo size={14} />
              <span>ACR Networks &amp; Solutions, S.R.L. · RNC 133-69267-8 · Cristo Rey, D.N.</span>
            </div>
            <div className="label-mono">Generado: {fechaLarga()}</div>
          </footer>
        </div>
      </div>
    </>
  )
}
