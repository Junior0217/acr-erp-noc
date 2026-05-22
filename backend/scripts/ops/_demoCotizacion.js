/**
 * backend/scripts/ops/_demoCotizacion.js
 *
 * Dataset compartido por los tres generadores (PDF demo, XLSX, DOCX).
 * Garantiza paridad de contenido: cliente, items, fechas y cálculos
 * son IDÉNTICOS entre los tres formatos para inspección visual lado a lado.
 *
 * Si se cambia un valor aquí, los tres archivos generados reflejan el
 * cambio. No se duplican datos en cada script.
 */

const path = require('path');
const fs   = require('fs');

const ITBIS_RATE = 0.18;

const EMPRESA = {
  razonSocial:     'ACR Networks & Solutions, SRL',
  nombreComercial: 'ACR NETWORKS & SOLUTIONS',
  eslogan:         'Infraestructura de Redes · Seguridad Electrónica · Fibra Óptica',
  rnc:             '1-32-12345-6',
  direccion:       'Av. Winston Churchill #95, Edificio Acrópolis, Piantini, Santo Domingo, R.D.',
  telefono:        '(809) 547-2828',
  telefono2:       '(829) 547-2828',
  email:           'ventas@acrnetworks.do',
  website:         'https://acrnetworks.do',
  representanteNombre:   'Cristian',
  representanteApellido: 'Rosario',
  representanteCargo:    'Gerente de Operaciones',
};

const CLIENTE = {
  razonSocial: 'Plaza Comercial Bella Vista, SRL',
  noCliente:   'CLI-2026-00128',
  rnc:         '1-30-50128-3',
  contacto:    'Sr. Ramón Pérez · Administrador',
  telefono:    '(809) 555-0032',
  email:       'administracion@plazabellavista.do',
  direccion:   'Av. Sarasota #45, Bella Vista, Santo Domingo, R.D.',
};

// ─── Proyecto: Instalación CCTV de 32 cámaras + infraestructura completa ────
const ITEMS = [
  // ── CCTV ──
  { codigo: 'HIK-4MP-BUL', descripcion: 'Cámara IP HIKVISION 4MP Bullet DS-2CD2143G2-I',  detalle: 'IR 30m, PoE 802.3af, lente fija 2.8mm, IP67, H.265+, audio bidireccional',          cantidad: 24, precioUnitario:  6850.00 },
  { codigo: 'HIK-4MP-DOM', descripcion: 'Cámara IP HIKVISION 4MP Dome DS-2CD2143G2-IS',   detalle: 'Anti-vandálica IK10, IR 30m, PoE, lente 2.8mm, audio in/out, micro SD slot',        cantidad:  8, precioUnitario:  7450.00 },
  // ── NVR + Storage ──
  { codigo: 'HIK-NVR-32',  descripcion: 'NVR HIKVISION DS-7632NI-K2/32P',                 detalle: '32 canales, 32 puertos PoE+, H.265+, 2 bahías HDD, salida HDMI 4K, hasta 320Mbps',  cantidad:  1, precioUnitario: 58500.00 },
  { codigo: 'HDD-WD-10TB', descripcion: 'Disco Duro WD Purple 10TB Surveillance',         detalle: 'CMR, 7200 RPM, 256MB caché, SATA III, 24/7, 1.5M horas MTBF, AllFrame AI',          cantidad:  2, precioUnitario: 14800.00 },
  // ── Red ──
  { codigo: 'SW-POE-24',   descripcion: 'Switch PoE+ 24 puertos Gigabit + 2× SFP',         detalle: 'Total budget 400W IEEE 802.3at, Layer 2 manageable, VLAN/QoS, rack-mountable',     cantidad:  1, precioUnitario: 28500.00 },
  { codigo: 'PATCH-CAT6',  descripcion: 'Patch Panel 24 puertos Cat6 1U',                  detalle: 'Keystone tooless, certificación EIA/TIA-568-B, organizador trasero incluido',     cantidad:  2, precioUnitario:  4250.00 },
  // ── Cableado ──
  { codigo: 'UTP-CAT6-305', descripcion: 'Cable UTP Cat6 23AWG CMR — caja 305m',           detalle: 'Conductor cobre puro, certificación TIA, color azul, pull-box auto-dispensador', cantidad:  4, precioUnitario:  5450.00 },
  { codigo: 'RJ45-CAT6',   descripcion: 'Conector RJ45 Cat6 Pass-Through — caja 100u',    detalle: 'Contactos chapados oro 50µ, polycarbonato, compatible Cat5e/Cat6/Cat6a',           cantidad:  2, precioUnitario:  1850.00 },
  // ── Montaje ──
  { codigo: 'BRK-CAM-PV',  descripcion: 'Bracket pared/poste para cámara bullet',          detalle: 'Aluminio fundido, ajuste 360°, anti-vandalismo, cubre cableado',                  cantidad: 32, precioUnitario:    485.00 },
  { codigo: 'RACK-12U',    descripcion: 'Rack de pared 12U 600×450mm',                     detalle: 'Puerta cerradura con llave, ventiladores 4× incluidos, organizadores 2×',         cantidad:  1, precioUnitario: 18500.00 },
  // ── Energía ──
  { codigo: 'UPS-APC-2K',  descripcion: 'UPS APC Smart-UPS 2200VA SMT2200I-AR',            detalle: 'Line-Interactive, 8 salidas IEC, software PowerChute, expansión batería opcional', cantidad: 2, precioUnitario: 38500.00 },
  // ── Servicio ──
  { codigo: 'INST-CCTV32', descripcion: 'Servicio de Instalación y Configuración — 32 Cámaras', detalle: 'Tendido cableado horizontal, montaje cámaras, terminación y certificación, configuración NVR + cuentas, integración red cliente, capacitación 4h al personal de TI', cantidad:  1, precioUnitario: 145000.00 },
];

// ─── Cálculos derivados ─────────────────────────────────────────────────────
function calcular(items) {
  const subtotal = items.reduce((acc, it) => acc + (Number(it.cantidad) * Number(it.precioUnitario)), 0);
  const itbis    = subtotal * ITBIS_RATE;
  const total    = subtotal + itbis;
  return { subtotal, itbis, total };
}

// ─── Fechas ─────────────────────────────────────────────────────────────────
function fechaEmision() { return new Date(); }
function fechaVence()   { const d = new Date(); d.setDate(d.getDate() + 30); return d; }
function fechaISO(d)    { return d.toISOString().slice(0, 10); }

// ─── Condiciones ────────────────────────────────────────────────────────────
const CONDICIONES = {
  validez:  '30 días desde la emisión',
  pago:     '50% confirmación · 50% contra entrega',
  entrega:  '7-10 días laborables',
  garantia: '12 meses · defectos de fábrica',
};

const NOTAS = (
  'Proyecto: Implementación de sistema de videovigilancia IP de 32 cámaras (24 bullet '
+ 'perimetrales + 8 dome interiores), grabación centralizada en NVR de 32 canales con '
+ 'redundancia de almacenamiento (20 TB efectivos), red dedicada con switch PoE+ '
+ 'manejable, respaldo eléctrico vía 2× UPS APC 2200VA, y rack de pared 12U para '
+ 'concentración de equipos. Garantía sobre defectos de fábrica únicamente — no cubre '
+ 'daños por descargas eléctricas, manipulación incorrecta ni eventos atmosféricos.'
);

// ─── Logo (PNG base64) ──────────────────────────────────────────────────────
function logoBuffer() {
  const p = path.resolve(__dirname, '..', '..', 'assets', 'logo-acr.png');
  return fs.existsSync(p) ? fs.readFileSync(p) : null;
}

function logoDataUri() {
  const buf = logoBuffer();
  return buf ? `data:image/png;base64,${buf.toString('base64')}` : null;
}

// ─── Número y fechas demo ───────────────────────────────────────────────────
const NUMERO    = 'COT-2026-0521-001';

module.exports = {
  EMPRESA,
  CLIENTE,
  ITEMS,
  ITBIS_RATE,
  CONDICIONES,
  NOTAS,
  NUMERO,
  calcular,
  fechaEmision,
  fechaVence,
  fechaISO,
  logoBuffer,
  logoDataUri,
};
