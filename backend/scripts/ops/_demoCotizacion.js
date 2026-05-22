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
  razonSocial: 'TechSolutions Caribe, SRL',
  noCliente:   'CLI-2026-00128',
  rnc:         '1-30-50128-3',
  contacto:    'Ing. Luis Martínez',
  telefono:    '(809) 555-1234',
  email:       'compras@techsolutions.com.do',
  direccion:   'Av. 27 de Febrero #500, Ensanche Naco, Santo Domingo, R.D.',
};

const ITEMS = [
  { codigo: 'MKT-RB5009', descripcion: 'Router MikroTik RB5009UG+S+IN', detalle: 'CPU 4-core ARM, 9× Gigabit, 1× SFP+ 10G, RouterOS L5', cantidad: 1,    precioUnitario: 24500.00 },
  { codigo: 'FO-SM-1KM',  descripcion: 'Cable de Fibra Óptica Single-Mode 9/125µm',                detalle: 'Armado, exterior, anti-roedor — rollo 1000 m',       cantidad: 1500, precioUnitario:    78.00 },
  { codigo: 'SC-APC-50',  descripcion: 'Conectores SC/APC Pre-pulidos',                            detalle: 'Conector mecánico, pérdida <0.3 dB',                 cantidad: 50,   precioUnitario:   145.00 },
  { codigo: 'HIK-DS-4MP', descripcion: 'Cámara IP HIKVISION 4MP DS-2CD2143G2',                     detalle: 'Bullet, IR 30m, PoE, lente 2.8mm, IP67',             cantidad: 8,    precioUnitario:  6850.00 },
  { codigo: 'HIK-NVR16',  descripcion: 'NVR HIKVISION DS-7616NI-K2/16P',                           detalle: '16 canales, 16 puertos PoE, H.265+, 2 bahías HDD',   cantidad: 1,    precioUnitario: 21500.00 },
  { codigo: 'HDD-WD-6TB', descripcion: 'Disco Duro WD Purple 6TB Surveillance',                    detalle: '24/7, 256 MB caché, SATA III',                       cantidad: 2,    precioUnitario:  7950.00 },
  { codigo: 'UPS-APC15K', descripcion: 'UPS APC Smart-UPS 1500VA Line-Interactive',                detalle: 'Salidas IEC, batería sellada, software PowerChute',  cantidad: 1,    precioUnitario: 18500.00 },
  { codigo: 'INST-CCTV',  descripcion: 'Servicio de Instalación y Configuración CCTV',             detalle: 'Tendido cableado UTP Cat6, configuración NVR, capacitación',  cantidad: 1, precioUnitario: 35000.00 },
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
  'Proyecto: Instalación de sistema CCTV de 8 cámaras IP + tendido de fibra óptica '
+ 'punto a punto entre las dos sedes del cliente. La instalación incluye configuración '
+ 'del NVR, integración con red existente del cliente y capacitación básica al personal '
+ 'de TI. Garantía sobre defectos de fábrica únicamente — no cubre daños por descargas '
+ 'eléctricas, manipulación incorrecta ni eventos atmosféricos.'
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
