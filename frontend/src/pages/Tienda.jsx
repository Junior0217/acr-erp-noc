import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  ShoppingCart, Shield, Wrench, Cable, Camera, Server, Eye, EyeOff,
  X, Plus, Minus, Lock, LogIn, ArrowRight, Loader2, Trash2,
} from "lucide-react";
import ACRLogo from "../components/ACRLogo";

const API = import.meta.env.VITE_API_URL || "";
const CART_KEY = "acr_cart_v1";

const CATEGORIA_ICON = {
  CCTV:          Camera,
  Redes:         Cable,
  CercoElectrico:Shield,
  SoporteTecnico:Wrench,
  Reparacion:    Wrench,
  ProyectoCCTV:  Camera,
};

function formatCurrency(val) {
  if (val == null) return "—";
  return new Intl.NumberFormat("es-DO", { style: "currency", currency: "DOP", minimumFractionDigits: 0 }).format(Number(val) || 0);
}

function readCart() {
  try { return JSON.parse(localStorage.getItem(CART_KEY)) || []; } catch { return []; }
}

function writeCart(items) {
  try { localStorage.setItem(CART_KEY, JSON.stringify(items)); } catch {}
  window.dispatchEvent(new CustomEvent("cart:updated"));
}

function CartDrawer({ open, onClose, items, onChange, isLoggedIn, navigate }) {
  const [busy, setBusy] = useState(false);

  const subtotal = items.reduce((s, i) => s + (Number(i.precio) || 0) * i.cantidad, 0);
  const itbis    = Math.round(subtotal * 0.18 * 100) / 100;
  const total    = Math.round((subtotal + itbis) * 100) / 100;

  function setCant(id, delta) {
    const next = items.map(i => i.id === id ? { ...i, cantidad: Math.max(0, i.cantidad + delta) } : i).filter(i => i.cantidad > 0);
    writeCart(next); onChange(next);
  }

  function quitar(id) {
    const next = items.filter(i => i.id !== id);
    writeCart(next); onChange(next);
  }

  async function checkout() {
    if (!isLoggedIn) {
      toast.message("Inicia sesión para completar tu compra.");
      navigate("/portal");
      return;
    }
    if (items.length === 0) return;
    setBusy(true);
    try {
      const body = { items: items.map(i => ({ itemCatalogoId: i.id, cantidad: i.cantidad })), metodoPago: "Tarjeta" };
      const r = await fetch(`${API}/api/portal/checkout`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) { toast.error(j.error ?? "Error en checkout."); return; }
      toast.success(`Pago generado: ${formatCurrency(j.total)}`, { description: `Referencia: ${j.paymentRef.slice(0, 8)}…` });
      if (j.sandbox) {
        toast.warning("Pasarela en modo sandbox. Carmelo confirma manualmente por ahora.");
      }
      writeCart([]); onChange([]);
      onClose();
    } catch { toast.error("Error de red."); }
    finally { setBusy(false); }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-slate-900 border-l border-slate-700 w-full max-w-md h-full overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="sticky top-0 bg-slate-900 border-b border-slate-800 px-5 py-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2"><ShoppingCart size={18} className="text-blue-400" />Tu carrito</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200"><X size={18} /></button>
        </div>

        {items.length === 0 ? (
          <div className="text-center py-16 text-slate-600 text-sm px-5">
            Tu carrito está vacío.<br /><span className="text-xs">Explora nuestros servicios y agrega lo que necesitas.</span>
          </div>
        ) : (
          <>
            <div className="divide-y divide-slate-800">
              {items.map(i => (
                <div key={i.id} className="p-4 flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-slate-100">{i.nombre}</p>
                    <p className="text-xs text-slate-500 mt-0.5">{i.categoria}</p>
                    <p className="text-sm text-emerald-400 font-mono mt-1">{i.precio != null ? formatCurrency(i.precio) : "Inicia sesión para ver precio"}</p>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <button onClick={() => quitar(i.id)} className="text-slate-600 hover:text-red-400"><Trash2 size={13} /></button>
                    <div className="flex items-center gap-2 bg-slate-800 rounded-lg p-1">
                      <button onClick={() => setCant(i.id, -1)} className="p-1 hover:bg-slate-700 rounded text-slate-400"><Minus size={12} /></button>
                      <span className="text-xs font-mono text-slate-200 min-w-[20px] text-center">{i.cantidad}</span>
                      <button onClick={() => setCant(i.id, +1)} className="p-1 hover:bg-slate-700 rounded text-slate-400"><Plus size={12} /></button>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="p-5 border-t border-slate-800 space-y-2 bg-slate-900/95 sticky bottom-0">
              {isLoggedIn ? (
                <>
                  <div className="flex justify-between text-xs text-slate-500"><span>Subtotal</span><span className="font-mono">{formatCurrency(subtotal)}</span></div>
                  <div className="flex justify-between text-xs text-slate-500"><span>ITBIS (18%)</span><span className="font-mono">{formatCurrency(itbis)}</span></div>
                  <div className="flex justify-between text-base font-bold text-slate-100 pt-2 border-t border-slate-800"><span>Total</span><span className="font-mono text-emerald-400">{formatCurrency(total)}</span></div>
                  <button onClick={checkout} disabled={busy || items.length === 0}
                    className="w-full mt-3 px-4 py-3 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-bold flex items-center justify-center gap-2 disabled:opacity-50">
                    {busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
                    Procesar pago
                  </button>
                </>
              ) : (
                <button onClick={() => navigate("/portal")} className="w-full px-4 py-3 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-bold flex items-center justify-center gap-2">
                  <LogIn size={16} />Inicia sesión para ver precio y pagar
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function Tienda() {
  const navigate = useNavigate();
  const [items, setItems]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [cart, setCart]       = useState([]);
  const [open, setOpen]       = useState(false);
  const [isLoggedIn, setLogged] = useState(false);

  useEffect(() => {
    setCart(readCart());
    // Detecta si hay sesión portal vía /api/portal/auth/me
    fetch(`${API}/api/portal/auth/me`, { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then(u => setLogged(!!u))
      .catch(() => setLogged(false));
  }, []);

  useEffect(() => {
    // Cuando logged: usa endpoint con precios. Cuando no: público sin precios.
    const url = isLoggedIn ? "/api/portal/catalogo" : "/api/catalogo-publico";
    setLoading(true);
    fetch(`${API}${url}`, { credentials: "include" })
      .then(r => r.ok ? r.json() : { data: [] })
      .then(j => setItems(j.data || []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [isLoggedIn]);

  function agregar(item) {
    const existing = cart.find(c => c.id === item.id);
    const next = existing
      ? cart.map(c => c.id === item.id ? { ...c, cantidad: c.cantidad + 1 } : c)
      : [...cart, { id: item.id, nombre: item.nombre, categoria: item.categoria, precio: item.precio, cantidad: 1 }];
    writeCart(next); setCart(next);
    toast.success(`${item.nombre} agregado al carrito.`);
  }

  const grouped = items.reduce((acc, i) => {
    (acc[i.categoria] = acc[i.categoria] || []).push(i);
    return acc;
  }, {});

  const cartCount = cart.reduce((s, i) => s + i.cantidad, 0);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="bg-slate-900 border-b border-slate-800 sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <ACRLogo size={32} />
            <div>
              <h1 className="text-base font-bold text-slate-100">ACR Networks · Tienda</h1>
              <p className="text-xs text-slate-500">Servicios IT, CCTV y Reparaciones</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {isLoggedIn ? (
              <span className="text-xs text-emerald-400 hidden sm:flex items-center gap-1"><Eye size={12} />Sesión activa</span>
            ) : (
              <button onClick={() => navigate("/portal")} className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1">
                <LogIn size={12} />Iniciar sesión
              </button>
            )}
            <button onClick={() => setOpen(true)} className="relative p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200">
              <ShoppingCart size={18} />
              {cartCount > 0 && (
                <span className="absolute -top-1 -right-1 bg-emerald-500 text-white text-[10px] font-bold rounded-full w-5 h-5 flex items-center justify-center">{cartCount}</span>
              )}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8">
        {!isLoggedIn && (
          <div className="mb-6 bg-blue-600/10 border border-blue-600/30 rounded-xl p-4 flex items-start gap-3">
            <Lock size={16} className="text-blue-400 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-blue-300">Inicia sesión para ver precios y comprar</p>
              <p className="text-xs text-slate-400 mt-1">Nuestros servicios IT requieren un cliente vinculado para garantía y SLA. Regístrate en menos de 60 segundos.</p>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-20"><Loader2 size={28} className="animate-spin text-blue-500" /></div>
        ) : Object.keys(grouped).length === 0 ? (
          <p className="text-center text-slate-600 py-20">Sin servicios disponibles.</p>
        ) : (
          Object.entries(grouped).map(([cat, list]) => {
            const Icon = CATEGORIA_ICON[cat] ?? Server;
            return (
              <section key={cat} className="mb-8">
                <h2 className="flex items-center gap-2 text-base font-bold text-slate-300 uppercase tracking-wider mb-4 border-b border-slate-800 pb-2">
                  <Icon size={16} className="text-blue-400" />{cat}
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {list.map(item => (
                    <div key={item.id} className="bg-slate-900 border border-slate-800 hover:border-blue-600/40 rounded-xl p-5 transition-all">
                      <h3 className="text-sm font-bold text-slate-100">{item.nombre}</h3>
                      {item.descripcion && <p className="text-xs text-slate-500 mt-1 line-clamp-2">{item.descripcion}</p>}
                      <div className="mt-4 flex items-end justify-between">
                        <div>
                          {item.precio != null ? (
                            <p className="text-xl font-bold text-emerald-400 font-mono">{formatCurrency(item.precio)}</p>
                          ) : (
                            <p className="text-xs text-slate-600 italic flex items-center gap-1"><Lock size={11} />Inicia sesión</p>
                          )}
                          <p className="text-[10px] text-slate-600 uppercase tracking-wider mt-0.5">{item.tipo === "Recurrente" ? "Mensual" : item.tipo === "Servicio" ? "Por servicio" : "Único"}</p>
                        </div>
                        <button onClick={() => agregar(item)}
                          disabled={item.precio == null}
                          className="px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold flex items-center gap-1 disabled:opacity-30 disabled:cursor-not-allowed">
                          <Plus size={12} />Agregar
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            );
          })
        )}
      </main>

      <CartDrawer open={open} onClose={() => setOpen(false)} items={cart} onChange={setCart} isLoggedIn={isLoggedIn} navigate={navigate} />
    </div>
  );
}
