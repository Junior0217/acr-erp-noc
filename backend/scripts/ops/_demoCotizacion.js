/**
 * backend/scripts/ops/_demoCotizacion.js
 *
 * Dataset compartido por el generador de PDF demo y el generador de
 * Excel editable. Replica exactamente la cotización COT-914502 de la
 * Escuela Benito Juárez — 32 cámaras (36 con repuesto) + infraestructura
 * completa — para que el Excel sea espejo 1:1 del PDF oficial.
 *
 * Datos REALES de la empresa (no placeholder):
 *   · ACR NETWORKS & SOLUTIONS, S.R.L.
 *   · RNC 133692678
 *   · Tel 849-458-9955 / 809-670-9956
 *   · acrnetworkssolutions@gmail.com
 *   · https://acr-erp-noc.vercel.app/portal
 *
 * Items en estado borrador (precio 0.00) — el técnico edita en Excel
 * y las fórmulas vivas recalculan importe/subtotal/ITBIS/total al instante.
 */

const path = require('path');
const fs   = require('fs');

const ITBIS_RATE = 0.18;

// ─── Empresa ACR real ───────────────────────────────────────────────────────
const EMPRESA = {
  razonSocial:     'ACR NETWORKS & SOLUTIONS, S.R.L.',
  nombreComercial: 'ACR NETWORKS',
  eslogan:         'Soluciones en Seguridad Electrónica, Redes y Soporte IT Corporativo',
  rnc:             '133692678',
  telefono:        '849-458-9955',
  telefono2:       '809-670-9956',
  email:           'acrnetworkssolutions@gmail.com',
  website:         'https://acr-erp-noc.vercel.app/portal',
  representanteCargo: 'Representante',
};

// ─── Cliente: Escuela Benito Juárez ─────────────────────────────────────────
const CLIENTE = {
  razonSocial: 'Escuela Benito Juárez',
  noCliente:   '',
  rnc:         '',
  contacto:    '',
  telefono:    '',
  email:       '',
  direccion:   '',
};

// ─── Items REALES (COT-914502 — 12 líneas, todas en borrador) ───────────────
const ITEMS = [
  { codigo: 'CCTV-DAH-HFW1839T',     descripcion: 'Cámara IP Dahua 4K 8MP IPC-HFW1839T1-LED tipo bullet ColorVu 2.8mm',                                           detalle: '',                                                                       cantidad: 36, precioUnitario: 0.00 },
  { codigo: 'CCTV-DAH-NVR5232',      descripcion: 'NVR Dahua 32 Canales NVR5232-EI 4K H.265+ con AI (rostros + cruce de línea)',                                  detalle: '',                                                                       cantidad:  2, precioUnitario: 0.00 },
  { codigo: 'STORAGE-WD-8TB-PURPLE', descripcion: 'Disco duro Western Digital Purple 8TB Surveillance WD84PURZ',                                                  detalle: '',                                                                       cantidad:  4, precioUnitario: 0.00 },
  { codigo: 'NET-UBQ-USW-24-POE',    descripcion: 'Switch UniFi USW-24-POE 24-puerto gigabit con 16 PoE+ (250W total)',                                           detalle: '',                                                                       cantidad:  2, precioUnitario: 0.00 },
  { codigo: 'NET-UBQ-USW-LITE-8',    descripcion: 'Switch UniFi USW-Lite-8-POE 8-puerto gigabit con 4 PoE+ (52W)',                                                detalle: '',                                                                       cantidad:  2, precioUnitario: 0.00 },
  { codigo: 'FO-DROP-2H-1000M',      descripcion: 'Bobina Fibra Óptica Drop 2 Hilos SM G657A1 1000m (interplanta entre edificios)',                              detalle: '',                                                                       cantidad:  2, precioUnitario: 0.00 },
  { codigo: 'NET-CAB-UTP6-305M',     descripcion: 'Bobina Cable UTP Cat6 305m exterior (gel-filled) para tendido entre cámaras y rack',                          detalle: '',                                                                       cantidad:  6, precioUnitario: 0.00 },
  { codigo: 'NET-RJ45-CAT6-PACK100', descripcion: 'Conectores RJ45 Cat6 blindados pack×100 con bota anti-tirón',                                                  detalle: '',                                                                       cantidad:  2, precioUnitario: 0.00 },
  { codigo: 'NET-RACK-12U',          descripcion: 'Rack mural 12U 600mm con organizador y bandeja para NVR + switches',                                           detalle: '',                                                                       cantidad:  2, precioUnitario: 0.00 },
  { codigo: 'POWER-UPS-3KVA',        descripcion: 'UPS APC SmartConnect 3000VA online con respaldo 2h al rack principal',                                         detalle: '',                                                                       cantidad:  1, precioUnitario: 0.00 },
  { codigo: 'SVC-INSTALACION',       descripcion: 'Servicio técnico',                                                                                              detalle: 'instalación · configuración remota DMSS · programación AI y entrega final con planos as-built', cantidad:  1, precioUnitario: 0.00 },
  { codigo: 'SVC-CAPACITACION',      descripcion: 'Capacitación 2 horas presencial al personal designado (uso de NVR, exportación de video, alertas móvil)',     detalle: '',                                                                       cantidad:  1, precioUnitario: 0.00 },
];

// ─── Cálculos derivados ─────────────────────────────────────────────────────
function calcular(items) {
  const subtotal = items.reduce((acc, it) => acc + (Number(it.cantidad) * Number(it.precioUnitario)), 0);
  const itbis    = subtotal * ITBIS_RATE;
  const total    = subtotal + itbis;
  return { subtotal, itbis, total };
}

// ─── Fechas (mismas del PDF: emisión 2026-05-22, vence +30d → 2026-06-21) ───
function fechaEmision() { return new Date('2026-05-22T12:00:00Z'); }
function fechaVence()   { return new Date('2026-06-21T12:00:00Z'); }
function fechaISO(d)    {
  // Formato dd/mm/yyyy igual que el PDF (es-DO)
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = d.getFullYear();
  return `${dd}/${mm}/${yy}`;
}

// ─── Condiciones (idénticas al PDF) ─────────────────────────────────────────
const CONDICIONES = {
  validez:  'Esta cotización es válida por 15 días calendarios.',
  pago:     '50% confirmación · 50% contra entrega',
  entrega:  'Entrega e instalación en 5-7 días laborables tras confirmación.',
  garantia: '12 meses contra defectos de fábrica para equipos. Mano de obra: 90 días.',
};

const NOTAS = '';

const ESTADO = 'Borrador';
const NUMERO = 'COT-914502';

// ─── Logo (PNG real, aspecto 669:373 = 1.79:1) ──────────────────────────────
function logoBuffer() {
  const p = path.resolve(__dirname, '..', '..', 'assets', 'logo-acr.png');
  return fs.existsSync(p) ? fs.readFileSync(p) : null;
}

function logoDataUri() {
  const buf = logoBuffer();
  return buf ? `data:image/png;base64,${buf.toString('base64')}` : null;
}

module.exports = {
  EMPRESA,
  CLIENTE,
  ITEMS,
  ITBIS_RATE,
  CONDICIONES,
  NOTAS,
  NUMERO,
  ESTADO,
  calcular,
  fechaEmision,
  fechaVence,
  fechaISO,
  logoBuffer,
  logoDataUri,
};
