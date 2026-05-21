/**
 * frontend/src/features/sales/panels/CotizadorManualPro.jsx
 *
 * Cotizador Manual Libre para proyectos de infraestructura/CCTV. Texto
 * editable plano, sin sincronización con stock físico. Genera PDF servido
 * por POST /api/ventas/cotizador-libre/pdf y persiste borradores via
 * PUT /api/ventas/cotizador-libre/draft (auto-save debounced a 3s).
 *
 * Ciclo 13:
 *   - Único `useReducer` centraliza cliente / items / numeroDocumento /
 *     switches de ITBIS y descuentos. `cond` (hook DRY) se folda en un
 *     `useMemo` consolidado que es la dependencia ÚNICA del auto-save.
 *   - Cada ítem soporta `lugarInstalacion` y `fotos[]` (data URI base64).
 *     Las fotos se comprimen client-side a 1280px de lado + JPEG quality
 *     0.7 antes de codificar — cap 5 fotos por ítem.
 *   - Modo supervisor (`isGlobal`): selector superior para abrir, listar y
 *     sobreescribir borradores de otros empleados (co-edición en vivo de
 *     la cotización Escuela Benito Juárez con Cristian).
 *
 * Estilo Cyber-Industrial: bg-slate-900, text-slate-100, blue-600 acentos.
 * Iconos: lucide-react. Responsive: w-full / max-w-7xl centrado.
 */

import { useEffect, useMemo, useReducer, useRef, useState, useCallback } from 'react'
import {
  Plus, Trash2, FileDown, Loader2, Building2, ShieldCheck, FileText, Save,
  Boxes, Camera, X as XIcon, Users, MapPin, ImageOff, Copy, Share2, Mail,
  Layers, Sparkles, BookOpen, Tag,
} from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '@shared/utils/api'
import EditorCondiciones  from '@features/sales/panels/_shared/EditorCondiciones'
import useCondicionesDoc  from '@features/sales/panels/_shared/useCondicionesDoc'
import VoiceDictationButton from '@shared/components/VoiceDictationButton'

const INPUT = 'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors'
const LABEL = 'block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5'

// ─── Compresión client-side de fotos ─────────────────────────────────────────
// Target: largo máx 1280px, JPEG quality 0.7. Output: data URI base64.
// Implementado con canvas + toBlob → FileReader.readAsDataURL. Soporta HEIC
// solo si el browser ya lo decodifica (iOS Safari sí; Chrome desktop NO —
// en ese caso falla con toast). Para evitar UI bloqueada en celulares lentos,
// la compresión corre fuera del thread principal vía createImageBitmap.
const MAX_FOTO_LADO    = 1280
const FOTO_QUALITY     = 0.7
const MAX_FOTOS_X_ITEM = 5
const MAX_FOTO_BYTES   = 320 * 1024  // alineado con backend MAX_FOTO_BYTES

// ─── Generador de fotos placeholder ──────────────────────────────────────────
// Crea fotos demo a 800x600 JPEG cuando una plantilla las requiere — útil para
// previsualizar el anexo fotográfico del PDF sin tener que adjuntar archivos
// reales. Cada placeholder muestra un glyph (CCTV/NVR/cable) + título +
// subtítulo sobre un gradient slate→accent. Output: dataURI image/jpeg, válido
// para el schema backend (image/(jpeg|png|webp) regex).
async function _generarFotoPlaceholder({ titulo, subtitulo = '', glyph = '◉', accent = '#1e40af' }) {
  const W = 800, H = 600
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')

  // Fondo gradient slate → accent.
  const g = ctx.createLinearGradient(0, 0, W, H)
  g.addColorStop(0,    '#0f172a')
  g.addColorStop(0.55, '#1e293b')
  g.addColorStop(1,    accent)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, H)

  // Vignette sutil radial para profundidad.
  const r = ctx.createRadialGradient(W / 2, H / 2, 100, W / 2, H / 2, W * 0.7)
  r.addColorStop(0, 'rgba(0,0,0,0)')
  r.addColorStop(1, 'rgba(0,0,0,0.45)')
  ctx.fillStyle = r
  ctx.fillRect(0, 0, W, H)

  // Glyph central grande (puede ser emoji o símbolo unicode).
  ctx.fillStyle    = 'rgba(255,255,255,0.92)'
  ctx.textAlign    = 'center'
  ctx.textBaseline = 'middle'
  ctx.font         = 'bold 220px "Helvetica Neue", Arial, "Segoe UI Emoji", sans-serif'
  ctx.fillText(glyph, W / 2, H / 2 - 60)

  // Título.
  ctx.fillStyle = '#ffffff'
  ctx.font      = 'bold 38px "Helvetica Neue", Arial, sans-serif'
  ctx.fillText(titulo || 'Foto referencial', W / 2, H / 2 + 140)

  // Subtítulo.
  if (subtitulo) {
    ctx.fillStyle = 'rgba(255,255,255,0.65)'
    ctx.font      = '20px "Helvetica Neue", Arial, sans-serif'
    ctx.fillText(subtitulo, W / 2, H / 2 + 180)
  }

  // Watermark "DEMO" esquina inferior derecha.
  ctx.fillStyle = 'rgba(255,255,255,0.35)'
  ctx.font      = 'bold 14px "Helvetica Neue", Arial, sans-serif'
  ctx.textAlign = 'right'
  ctx.fillText('FOTO DE REFERENCIA · REEMPLAZAR EN OBRA', W - 24, H - 24)

  // Borde delgado.
  ctx.strokeStyle = 'rgba(255,255,255,0.18)'
  ctx.lineWidth   = 4
  ctx.strokeRect(2, 2, W - 4, H - 4)

  // Encode a JPEG y a dataURI.
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.72))
  if (!blob) return null
  return new Promise((res) => {
    const reader = new FileReader()
    reader.onload  = () => res(reader.result)
    reader.onerror = () => res(null)
    reader.readAsDataURL(blob)
  })
}

async function comprimirImagen(file) {
  if (!file || !file.type?.startsWith('image/')) {
    throw new Error('No es una imagen')
  }
  // createImageBitmap soporta orientation EXIF en navegadores modernos.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  const scale  = Math.min(1, MAX_FOTO_LADO / Math.max(bitmap.width, bitmap.height))
  const w      = Math.max(1, Math.round(bitmap.width  * scale))
  const h      = Math.max(1, Math.round(bitmap.height * scale))

  const canvas = document.createElement('canvas')
  canvas.width  = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close?.()

  // Encode to JPEG. Si el resultado pasa el cap, reintentar con quality
  // menor (escalado lineal entre 0.5 y 0.7).
  let quality = FOTO_QUALITY
  let blob    = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality))
  while (blob && blob.size > MAX_FOTO_BYTES && quality > 0.45) {
    quality -= 0.1
    blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality))
  }
  if (!blob) throw new Error('Falló la codificación de la imagen')
  if (blob.size > MAX_FOTO_BYTES) {
    throw new Error(`Imagen demasiado grande tras compresión (${Math.round(blob.size / 1024)}KB > ${Math.round(MAX_FOTO_BYTES / 1024)}KB)`)
  }
  const dataUri = await new Promise((res, rej) => {
    const r = new FileReader()
    r.onload  = () => res(r.result)
    r.onerror = () => rej(r.error)
    r.readAsDataURL(blob)
  })
  return { dataUri, nombre: file.name, size: blob.size, w, h }
}

// ─── Estado inicial / defaults ───────────────────────────────────────────────
const CLIENTE_DEFAULT = {
  razonSocial: 'Escuela Benito Juárez',
  contacto:    '',
  rnc:         '',
  telefono:    '',
  direccion:   '',
}

const FORMA_PAGO_OPCIONES = [
  'Contado', 'Transferencia bancaria', 'Tarjeta crédito/débito',
  'Cheque', 'Crédito 15 días', 'Crédito 30 días', '50% anticipo + 50% contra entrega',
]

function nuevaLinea(over = {}) {
  return {
    id:                crypto.randomUUID(),
    codigo:            '',
    descripcion:       '',
    cantidad:          1,
    precioUnit:        0,
    aplicaItbis:       true,
    lugarInstalacion:  '',
    fotos:             [],
    categoria:         '',
    gps:               null,
    ...over,
  }
}

// Categorías canónicas (alineadas con backend schema CATEGORIAS_VALIDAS).
const CATEGORIAS = [
  '', 'Equipos', 'Cableado', 'Servicios', 'Capacitación',
  'Software', 'Mantenimiento', 'Garantía Extendida', 'Otros',
]

const ESTADOS = ['Borrador', 'Enviada', 'Aprobada', 'Convertida', 'Perdida']

// Default INICIAL del editor — vacío. El usuario pulsa "↻ Texto sugerido"
// para que se rellene con el texto generado a partir de `EmpresaPerfil` real
// (razón social, eslogan, representante). Esto evita acarrear cualquier
// nombre comercial hardcoded en el cliente — la fuente de verdad es BD.
const PORTADA_DEFAULT = {
  activa: false,
  texto:  '',
}

const SOBRE_EMPRESA_DEFAULT = {
  activa: false,
  texto:  '',
}

const ITEMS_INICIAL = [nuevaLinea()]

// Plantilla CCTV híbrida — 36 cámaras Escuela Benito Juárez.
// Cada ítem trae un ejemplo de `lugarInstalacion` para que Cristian solo
// ajuste especificaciones del sitio (altura, dirección de mira, etc.) en
// vez de pensar desde cero.
//
// `_placeholder` define la configuración para auto-generar 1 foto demo al
// cargar la plantilla — útil para previsualizar el anexo fotográfico
// completo del PDF sin tener fotos reales aún.
const PLANTILLA_CCTV_36 = [
  { codigo: 'CCTV-DAH-HFW1839T',     descripcion: 'Cámara IP Dahua 4K 8MP IPC-HFW1839T1-LED tipo bullet ColorVu 2.8mm',                cantidad: 36, precioUnit: 0, aplicaItbis: true, categoria: 'Equipos',       lugarInstalacion: 'Distribuidas en aulas, pasillos, patio principal y perímetro exterior. Altura promedio 3.5m, ángulo de mira 35° hacia abajo.', _placeholder: { titulo: 'Cámara IP Bullet 4K',     subtitulo: 'Dahua HFW1839T · ColorVu 2.8mm',     glyph: '📹', accent: '#1d4ed8' } },
  { codigo: 'CCTV-DAH-NVR5232',      descripcion: 'NVR Dahua 32 Canales NVR5232-EI 4K H.265+ con AI (rostros + cruce de línea)',         cantidad: 2,  precioUnit: 0, aplicaItbis: true, categoria: 'Equipos',       lugarInstalacion: 'Rack principal en cuarto de servidores (Dirección Administrativa, planta baja). Conexión UPS + red privada.',        _placeholder: { titulo: 'NVR 32 Canales 4K',     subtitulo: 'Dahua NVR5232-EI · AI integrada',     glyph: '🖥️', accent: '#0e7490' } },
  { codigo: 'STORAGE-WD-8TB-PURPLE', descripcion: 'Disco duro Western Digital Purple 8TB Surveillance WD84PURZ',                          cantidad: 4,  precioUnit: 0, aplicaItbis: true, categoria: 'Equipos',       lugarInstalacion: '2 discos por NVR en RAID 1 — redundancia para 30 días de grabación continua a 4K H.265+.',                              _placeholder: { titulo: 'Disco 8TB Surveillance', subtitulo: 'WD Purple WD84PURZ',                  glyph: '💾', accent: '#7c3aed' } },
  { codigo: 'NET-UBQ-USW-24-POE',    descripcion: 'Switch UniFi USW-24-POE 24-puerto gigabit con 16 PoE+ (250W total)',                   cantidad: 2,  precioUnit: 0, aplicaItbis: true, categoria: 'Equipos',       lugarInstalacion: 'Rack principal junto al NVR. Alimenta 16 cámaras vía PoE+ (clase 4, 30W por puerto).',                                 _placeholder: { titulo: 'Switch UniFi 24P PoE+',  subtitulo: 'USW-24-POE · 250W total',             glyph: '🔌', accent: '#0369a1' } },
  { codigo: 'NET-UBQ-USW-LITE-8',    descripcion: 'Switch UniFi USW-Lite-8-POE 8-puerto gigabit con 4 PoE+ (52W)',                        cantidad: 2,  precioUnit: 0, aplicaItbis: true, categoria: 'Equipos',       lugarInstalacion: 'Edificio anexo (cancha cubierta + canchas exteriores). Conectado por fibra al rack principal.',                       _placeholder: { titulo: 'Switch UniFi Lite-8',   subtitulo: 'USW-Lite-8-POE · 4 PoE+',             glyph: '🔌', accent: '#0284c7' } },
  { codigo: 'FO-DROP-2H-1000M',      descripcion: 'Bobina Fibra Óptica Drop 2 Hilos SM G657A1 1000m (interplanta entre edificios)',     cantidad: 2,  precioUnit: 0, aplicaItbis: true, categoria: 'Cableado',      lugarInstalacion: 'Tendido subterráneo (canalización existente) desde rack principal hasta edificios B y C. Fusiones en cajas NAP.',     _placeholder: { titulo: 'Fibra Óptica Drop 2H',  subtitulo: 'SM G657A1 · Bobina 1000m',            glyph: '🧵', accent: '#16a34a' } },
  { codigo: 'NET-CAB-UTP6-305M',     descripcion: 'Bobina Cable UTP Cat6 305m exterior (gel-filled) para tendido entre cámaras y rack', cantidad: 6,  precioUnit: 0, aplicaItbis: true, categoria: 'Cableado',      lugarInstalacion: 'Bandejas portacables existentes + tubería conduit nueva en exteriores. Etiquetado por cámara según plano as-built.', _placeholder: { titulo: 'Cable UTP Cat6 305m',   subtitulo: 'Exterior gel-filled · Cat6 PE',       glyph: '🪢', accent: '#65a30d' } },
  { codigo: 'NET-RJ45-CAT6-PACK100', descripcion: 'Conectores RJ45 Cat6 blindados pack×100 con bota anti-tirón',                          cantidad: 2,  precioUnit: 0, aplicaItbis: true, categoria: 'Cableado',      lugarInstalacion: 'Crimpado en ambos extremos de cada cable UTP — patch panel del rack + caja de cámara.',                                 _placeholder: { titulo: 'RJ45 Cat6 Blindados',   subtitulo: 'Pack ×100 con bota anti-tirón',       glyph: '🧷', accent: '#a16207' } },
  { codigo: 'NET-RACK-12U',          descripcion: 'Rack mural 12U 600mm con organizador y bandeja para NVR + switches',                  cantidad: 2,  precioUnit: 0, aplicaItbis: true, categoria: 'Equipos',       lugarInstalacion: 'Cuarto técnico principal + caseta de vigilancia. Montaje sobre pared con cierre con llave.',                            _placeholder: { titulo: 'Rack Mural 12U',        subtitulo: '600mm · Con organizador',             glyph: '🗄️', accent: '#475569' } },
  { codigo: 'POWER-UPS-3KVA',        descripcion: 'UPS APC SmartConnect 3000VA online con respaldo 2h al rack principal',               cantidad: 1,  precioUnit: 0, aplicaItbis: true, categoria: 'Equipos',       lugarInstalacion: 'Pie de rack principal. Conectado a circuito eléctrico dedicado 20A con descarga a tierra dedicada.',                  _placeholder: { titulo: 'UPS Online 3KVA',       subtitulo: 'APC SmartConnect · 2h respaldo',      glyph: '🔋', accent: '#f59e0b' } },
  { codigo: 'SVC-INSTALACION',       descripcion: 'Servicio técnico: instalación, configuración remota DMSS, programación AI y entrega final con planos as-built', cantidad: 1, precioUnit: 0, aplicaItbis: true, categoria: 'Servicios',     lugarInstalacion: 'In situ. Incluye levantamiento del sitio, montaje de cámaras, tendido, pruebas funcionales y documentación.',          _placeholder: { titulo: 'Servicio Instalación',  subtitulo: 'Mano de obra especializada',          glyph: '🛠️', accent: '#dc2626' } },
  { codigo: 'SVC-CAPACITACION',      descripcion: 'Capacitación 2 horas presencial al personal designado (uso de NVR, exportación de video, alertas móvil)',       cantidad: 1, precioUnit: 0, aplicaItbis: true, categoria: 'Capacitación',  lugarInstalacion: 'Sala de reuniones del cliente. Para 3-5 personas designadas (director, subdirector, encargado de seguridad).',          _placeholder: { titulo: 'Capacitación Presencial', subtitulo: '2h al personal del cliente',         glyph: '🎓', accent: '#ea580c' } },
]

// Plantilla Fibra Óptica residencial / pequeño negocio.
const PLANTILLA_FIBRA_RES = [
  { codigo: 'FO-CAJA-NAP-16',        descripcion: 'Caja NAP 16 puertos para distribución de fibra óptica en poste/fachada',             cantidad: 1, precioUnit: 0, aplicaItbis: true, categoria: 'Equipos',   lugarInstalacion: 'Poste de tendido del cliente, altura 4m. Splitter 1:8 instalado dentro de la caja para distribución secundaria.', _placeholder: { titulo: 'Caja NAP 16 Puertos',  subtitulo: 'Distribución FO en poste',         glyph: '📦', accent: '#0d9488' } },
  { codigo: 'FO-DROP-1H-500M',       descripcion: 'Bobina Fibra Drop 1 Hilo SM G657A2 500m para acometidas',                            cantidad: 1, precioUnit: 0, aplicaItbis: true, categoria: 'Cableado',  lugarInstalacion: 'Acometida aérea desde caja NAP hasta fachada del cliente. Sujeción con grapas cada 5m.',                            _placeholder: { titulo: 'Drop FO 1H 500m',      subtitulo: 'SM G657A2 · Acometida',            glyph: '🧵', accent: '#0891b2' } },
  { codigo: 'FO-ONT-WIFI6',          descripcion: 'ONT WiFi6 dual-band 2.4/5GHz GPON para terminación de fibra en hogar',               cantidad: 1, precioUnit: 0, aplicaItbis: true, categoria: 'Equipos',   lugarInstalacion: 'Sala principal del cliente, sobre repisa o pared a altura media. Conexión eléctrica 110V + ventilación pasiva.',   _placeholder: { titulo: 'ONT WiFi6 GPON',       subtitulo: 'Dual-band 2.4/5GHz · Hogar',      glyph: '📶', accent: '#7c3aed' } },
  { codigo: 'FO-CONECTOR-FAST-SC',   descripcion: 'Conector rápido SC/APC pack×10 para terminación en sitio',                            cantidad: 2, precioUnit: 0, aplicaItbis: true, categoria: 'Cableado',  lugarInstalacion: 'Terminación en ambos extremos del drop: poste (lado proveedor) y ONT (lado cliente).',                                _placeholder: { titulo: 'Conector SC/APC ×10',  subtitulo: 'Fast connect · Sin fusión',       glyph: '🧷', accent: '#16a34a' } },
  { codigo: 'SVC-INSTAL-FO',         descripcion: 'Servicio: tendido, fusión, prueba con OTDR y entrega de plano as-built',             cantidad: 1, precioUnit: 0, aplicaItbis: true, categoria: 'Servicios', lugarInstalacion: 'In situ. Incluye empalme, certificación OTDR (atenuación máx 0.3 dB/empalme) y prueba de potencia óptica.',         _placeholder: { titulo: 'Servicio Tendido FO',  subtitulo: 'Fusión + certificación OTDR',     glyph: '🛠️', accent: '#dc2626' } },
]

// Plantilla Red Empresarial (oficina 30-60 puntos).
const PLANTILLA_RED_EMP = [
  { codigo: 'NET-UBQ-USG-PRO-4',     descripcion: 'Gateway UniFi USG Pro 4 con 4 puertos gigabit + IDS/IPS habilitado',                   cantidad: 1, precioUnit: 0, aplicaItbis: true, categoria: 'Equipos',      lugarInstalacion: 'Rack principal en cuarto de comunicaciones. Conexión WAN al ISP + LAN al switch de distribución.',                _placeholder: { titulo: 'Gateway UniFi USG',     subtitulo: 'USG Pro 4 · IDS/IPS',              glyph: '🛡️', accent: '#1d4ed8' } },
  { codigo: 'NET-UBQ-USW-48-POE',    descripcion: 'Switch UniFi USW-48-POE 48 puertos gigabit con 32 PoE+ (500W total)',                  cantidad: 1, precioUnit: 0, aplicaItbis: true, categoria: 'Equipos',      lugarInstalacion: 'Rack principal. Alimenta APs UniFi + cámaras IP + teléfonos IP vía PoE+.',                                          _placeholder: { titulo: 'Switch UniFi 48P',      subtitulo: 'USW-48-POE · 500W',                glyph: '🔌', accent: '#0369a1' } },
  { codigo: 'NET-UBQ-U6-LR',         descripcion: 'AP UniFi U6-LR WiFi6 dual-band con MU-MIMO y 4x4 MIMO',                                cantidad: 4, precioUnit: 0, aplicaItbis: true, categoria: 'Equipos',      lugarInstalacion: 'Montaje techo en zonas de alta densidad (recepción, sala de reuniones, área operativa, comedor).',                _placeholder: { titulo: 'AP UniFi U6-LR',        subtitulo: 'WiFi6 · 4x4 MIMO',                 glyph: '📡', accent: '#0e7490' } },
  { codigo: 'NET-CAB-UTP6-305M',     descripcion: 'Bobina Cable UTP Cat6 305m interior',                                                  cantidad: 4, precioUnit: 0, aplicaItbis: true, categoria: 'Cableado',     lugarInstalacion: 'Tendido por bandejas portacables sobre cielo raso, evitando cruces con luminarias y aire acondicionado.',         _placeholder: { titulo: 'Cable UTP Cat6 305m',   subtitulo: 'Interior · CMR',                   glyph: '🪢', accent: '#65a30d' } },
  { codigo: 'NET-FACEPLATE-2P',      descripcion: 'Cara plate 2 puertos blanca con keystone Cat6 hembra',                                  cantidad: 40, precioUnit: 0, aplicaItbis: true, categoria: 'Cableado',     lugarInstalacion: 'Una toma doble por estación de trabajo a 30 cm del piso. Etiquetadas según plano de cableado.',                    _placeholder: { titulo: 'Faceplate 2P + Keystone', subtitulo: 'Cat6 hembra · Pared',           glyph: '🔲', accent: '#a16207' } },
  { codigo: 'NET-RACK-22U',          descripcion: 'Rack abierto 22U con bandeja, organizador horizontal y multitoma',                    cantidad: 1, precioUnit: 0, aplicaItbis: true, categoria: 'Equipos',      lugarInstalacion: 'Cuarto de comunicaciones, montaje al piso con anclaje sísmico + tomas eléctricas dedicadas 20A.',                  _placeholder: { titulo: 'Rack Abierto 22U',      subtitulo: 'Piso · Anclaje sísmico',           glyph: '🗄️', accent: '#475569' } },
  { codigo: 'SVC-INSTAL-RED',        descripcion: 'Servicio: tendido estructurado certificación Cat6 + config UniFi Controller + WiFi PMK', cantidad: 1, precioUnit: 0, aplicaItbis: true, categoria: 'Servicios',    lugarInstalacion: 'In situ. Incluye certificación con tester Cat6, etiquetado, documentación, configuración VLAN y políticas WiFi.', _placeholder: { titulo: 'Servicio Red Estructurada', subtitulo: 'Cat6 + UniFi Controller',     glyph: '🛠️', accent: '#dc2626' } },
  { codigo: 'SVC-CAPACITACION',      descripcion: 'Capacitación 1.5h al administrador IT del cliente sobre UniFi + monitoreo remoto',     cantidad: 1, precioUnit: 0, aplicaItbis: true, categoria: 'Capacitación', lugarInstalacion: 'Sala de reuniones del cliente. Para 1-2 administradores IT designados.',                                            _placeholder: { titulo: 'Capacitación IT',       subtitulo: 'UniFi + monitoreo remoto',         glyph: '🎓', accent: '#ea580c' } },
]

// Plantilla Cerco eléctrico residencial.
const PLANTILLA_CERCO_RES = [
  { codigo: 'CER-ENERG-12KV',        descripcion: 'Energizador para cerco eléctrico 12kV con baterías de respaldo 12V 7Ah',              cantidad: 1, precioUnit: 0, aplicaItbis: true, categoria: 'Equipos',   lugarInstalacion: 'Interior del cuarto técnico o pared del garaje, protegido de la intemperie. Conexión 110V con tierra dedicada.',  _placeholder: { titulo: 'Energizador 12kV',      subtitulo: 'Respaldo 12V 7Ah',                 glyph: '⚡', accent: '#f59e0b' } },
  { codigo: 'CER-ALAMBRE-GALV-500',  descripcion: 'Alambre galvanizado calibre 14 para cerco eléctrico — bobina 500m',                   cantidad: 2, precioUnit: 0, aplicaItbis: true, categoria: 'Cableado',  lugarInstalacion: 'Perímetro completo del lote — 7 hilos paralelos a alturas escalonadas (1.8m / 2.0m / 2.2m / 2.4m / 2.6m / 2.8m / 3.0m).', _placeholder: { titulo: 'Alambre Galv. Cal. 14', subtitulo: 'Bobina 500m · Galvanizado',     glyph: '🧵', accent: '#64748b' } },
  { codigo: 'CER-AISLA-VARILLA',     descripcion: 'Aislador para varilla cerco eléctrico — pack×100',                                     cantidad: 2, precioUnit: 0, aplicaItbis: true, categoria: 'Cableado',  lugarInstalacion: 'Sujeción del alambre a cada varilla, uno por hilo. Espaciamiento entre varillas: 3m promedio.',                  _placeholder: { titulo: 'Aislador Cerco ×100',   subtitulo: 'PVC reforzado · Pack',             glyph: '⭕', accent: '#a16207' } },
  { codigo: 'CER-VARILLA-180',       descripcion: 'Varilla galvanizada 1.80m para postes de cerco',                                       cantidad: 25, precioUnit: 0, aplicaItbis: true, categoria: 'Cableado', lugarInstalacion: 'Empotradas sobre la pared perimetral existente, cada 3m. Total ~75m de perímetro.',                              _placeholder: { titulo: 'Varilla Galv. 1.80m',   subtitulo: 'Postes de cerco',                  glyph: '🪵', accent: '#475569' } },
  { codigo: 'SVC-INSTAL-CERCO',      descripcion: 'Servicio: instalación, tensado, pruebas de descarga y entrega con sirena audible',    cantidad: 1, precioUnit: 0, aplicaItbis: true, categoria: 'Servicios', lugarInstalacion: 'In situ. Tensado mecánico del alambre + prueba de continuidad + medición de salida >9kV + entrega con manual.',  _placeholder: { titulo: 'Servicio Instalación',  subtitulo: 'Tensado + prueba descarga',        glyph: '🛠️', accent: '#dc2626' } },
]

const PLANTILLAS = {
  CCTV_36:    { label: '36 Cámaras CCTV (Escuela)', items: PLANTILLA_CCTV_36 },
  FIBRA_RES:  { label: 'Fibra Óptica Residencial', items: PLANTILLA_FIBRA_RES },
  RED_EMP:    { label: 'Red Empresarial 30-60 puntos', items: PLANTILLA_RED_EMP },
  CERCO_RES:  { label: 'Cerco Eléctrico Residencial', items: PLANTILLA_CERCO_RES },
}

const CONDICIONES_DEFAULT = {
  validez:  { incluir: true,  texto: 'Esta cotización es válida por 15 días calendarios.' },
  pago:     { incluir: true,  texto: '50% anticipo + 50% contra entrega.' },
  entrega:  { incluir: true,  texto: 'Entrega e instalación en 5-7 días laborables tras confirmación.' },
  garantia: { incluir: true,  texto: '12 meses contra defectos de fábrica para equipos. Mano de obra: 90 días.' },
  notas:    { incluir: false, texto: '' },
}

const LS_KEY_ULTIMO_DOC = 'acr.cotizadorLibre.ultimoDoc'

function fmtRD(n) {
  return Number(n ?? 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// ─── Reducer: estado consolidado del editor ──────────────────────────────────
// Una sola fuente de verdad para los campos que el auto-save persiste. `cond`
// vive en su hook (DRY con otros paneles) y se folda en el payload via useMemo.
const initialState = {
  cliente:           CLIENTE_DEFAULT,
  numeroDocumento:   '',
  items:             ITEMS_INICIAL,
  aplicaItbisGlobal: true,
  porcentajeItbis:   18,
  descuentoPct:      0,
  descuentoMonto:    0,
  // `editingEmpleadoId` ≠ null indica que el caller (Owner/Socio) está
  // co-editando el borrador de otro empleado. El auto-save manda
  // `targetEmpleadoId` para que el backend escriba en el row correcto.
  editingEmpleadoId: null,
  // Bloques opcionales del PDF (ciclo 16).
  portada:           PORTADA_DEFAULT,
  sobreEmpresa:      SOBRE_EMPRESA_DEFAULT,
  mostrarResumen:    false,
  estado:            'Borrador',
}

function reducer(state, action) {
  switch (action.type) {
    case 'INIT_FROM_DRAFT': {
      const d = action.draft ?? {}
      return {
        ...state,
        cliente:           { ...CLIENTE_DEFAULT, ...(d.cliente ?? {}) },
        items:             Array.isArray(d.items) && d.items.length > 0
                              ? d.items.map((it) => nuevaLinea(it))
                              : ITEMS_INICIAL,
        aplicaItbisGlobal: typeof d.meta?.aplicaItbisGlobal === 'boolean' ? d.meta.aplicaItbisGlobal : state.aplicaItbisGlobal,
        porcentajeItbis:   typeof d.meta?.porcentajeItbis   === 'number'  ? d.meta.porcentajeItbis   : state.porcentajeItbis,
        descuentoPct:      typeof d.meta?.descuentoGlobalPct   === 'number' ? d.meta.descuentoGlobalPct   : state.descuentoPct,
        descuentoMonto:    typeof d.meta?.descuentoGlobalMonto === 'number' ? d.meta.descuentoGlobalMonto : state.descuentoMonto,
        numeroDocumento:   d.numeroDocumento ?? state.numeroDocumento,
        editingEmpleadoId: action.editingEmpleadoId ?? null,
        portada:           (d.meta?.portada && typeof d.meta.portada === 'object') ? { ...PORTADA_DEFAULT, ...d.meta.portada } : PORTADA_DEFAULT,
        sobreEmpresa:      (d.meta?.sobreEmpresa && typeof d.meta.sobreEmpresa === 'object') ? { ...SOBRE_EMPRESA_DEFAULT, ...d.meta.sobreEmpresa } : SOBRE_EMPRESA_DEFAULT,
        mostrarResumen:    typeof d.meta?.mostrarResumen === 'boolean' ? d.meta.mostrarResumen : false,
        estado:            ESTADOS.includes(d.meta?.estado) ? d.meta.estado : 'Borrador',
      }
    }
    case 'SET_NUMERO_DOC':
      return { ...state, numeroDocumento: action.value }
    case 'SET_CLIENTE':
      return { ...state, cliente: { ...state.cliente, ...action.patch } }
    case 'ADD_ITEM':
      return { ...state, items: [...state.items, nuevaLinea()] }
    case 'DEL_ITEM':
      // Garantiza siempre al menos 1 ítem en la lista.
      return state.items.length <= 1
        ? state
        : { ...state, items: state.items.filter((l) => l.id !== action.id) }
    case 'UPD_ITEM':
      return {
        ...state,
        items: state.items.map((l) => l.id === action.id ? { ...l, ...action.patch } : l),
      }
    case 'ADD_FOTO': {
      return {
        ...state,
        items: state.items.map((l) => {
          if (l.id !== action.id) return l
          const next = [...(l.fotos ?? [])]
          if (next.length >= MAX_FOTOS_X_ITEM) return l
          next.push(action.foto)
          return { ...l, fotos: next }
        }),
      }
    }
    case 'DEL_FOTO': {
      return {
        ...state,
        items: state.items.map((l) => l.id === action.id
          ? { ...l, fotos: (l.fotos ?? []).filter((_, i) => i !== action.index) }
          : l,
        ),
      }
    }
    case 'LOAD_PLANTILLA':
      return { ...state, items: (action.items ?? PLANTILLA_CCTV_36).map((p) => nuevaLinea(p)) }
    case 'SET_APLICA_ITBIS_GLOBAL':
      return { ...state, aplicaItbisGlobal: !!action.value }
    case 'SET_PCT_ITBIS':
      return { ...state, porcentajeItbis: action.value }
    case 'SET_DSC_PCT':
      return { ...state, descuentoPct: action.value }
    case 'SET_DSC_MONTO':
      return { ...state, descuentoMonto: action.value }
    case 'SET_EDITING_EMPLEADO':
      return { ...state, editingEmpleadoId: action.id ?? null }
    case 'SET_PORTADA':
      return { ...state, portada: { ...state.portada, ...action.patch } }
    case 'SET_SOBRE_EMPRESA':
      return { ...state, sobreEmpresa: { ...state.sobreEmpresa, ...action.patch } }
    case 'SET_MOSTRAR_RESUMEN':
      return { ...state, mostrarResumen: !!action.value }
    case 'SET_ESTADO':
      return { ...state, estado: ESTADOS.includes(action.value) ? action.value : 'Borrador' }
    case 'DUPLICATE_AS_NEW': {
      // Misma data, pero numeroDocumento nuevo y editingEmpleadoId reseteado.
      const nuevoNum = `COT-${Date.now().toString().slice(-6)}`
      return {
        ...state,
        numeroDocumento:   nuevoNum,
        editingEmpleadoId: null,
        estado:            'Borrador',
        // Limpiamos fotos del duplicado — no tiene sentido cargar las del original.
        items: state.items.map((l) => ({ ...l, id: crypto.randomUUID(), fotos: [], gps: null })),
      }
    }
    case 'RESET_TO_NEW': {
      // Crear cotización en blanco para el caller actual.
      const nuevoNum = `COT-${Date.now().toString().slice(-6)}`
      return { ...initialState, numeroDocumento: nuevoNum, editingEmpleadoId: null }
    }
    default:
      return state
  }
}

// ─── Badge de estado de auto-save ────────────────────────────────────────────
function SaveStatusBadge({ status, lastSavedAt }) {
  const rel = lastSavedAt ? Math.max(0, Math.floor((Date.now() - lastSavedAt.getTime()) / 1000)) : null
  const relTxt = rel == null ? '' : rel < 60 ? `hace ${rel}s` : rel < 3600 ? `hace ${Math.floor(rel / 60)}m` : `hace ${Math.floor(rel / 3600)}h`
  if (status === 'saving') {
    return <span className="flex items-center gap-1.5 text-[10px] font-semibold text-blue-300 px-2 py-1 rounded bg-blue-500/10 border border-blue-500/30"><Loader2 size={11} className="animate-spin" /> Guardando…</span>
  }
  if (status === 'error') {
    return <span className="text-[10px] font-semibold text-red-300 px-2 py-1 rounded bg-red-500/10 border border-red-500/30">Error al guardar</span>
  }
  if (status === 'saved' || lastSavedAt) {
    return <span className="flex items-center gap-1.5 text-[10px] font-semibold text-emerald-300 px-2 py-1 rounded bg-emerald-500/10 border border-emerald-500/30"><Save size={11} /> Guardado {relTxt}</span>
  }
  return <span className="text-[10px] font-semibold text-slate-500 px-2 py-1 rounded bg-slate-800 border border-slate-700">Sin cambios</span>
}

// ─── Componente principal ───────────────────────────────────────────────────
export default function CotizadorManualPro() {
  const [state, dispatch] = useReducer(reducer, initialState, (init) => ({
    ...init,
    numeroDocumento: (() => {
      try {
        const prev = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_KEY_ULTIMO_DOC) : null
        if (prev && prev.trim()) return prev
      } catch {}
      return `COT-${Date.now().toString().slice(-6)}`
    })(),
  }))

  // Hook DRY de condiciones — sigue siendo su propio state, lo foldeamos en
  // el payload memoizado para que el auto-save tenga UNA dependencia única.
  const {
    cond, reset: resetCond,
    values: condValues, mostrar: condMostrar,
    onChange: condOnChange, onMostrar: condOnMostrar,
  } = useCondicionesDoc(CONDICIONES_DEFAULT)

  // ─── Whoami: detecta scope global (Owner/Socio) y lista filas-resumen ───
  const [whoami, setWhoami] = useState({ requesterId: null, isGlobal: false })
  const [borradoresGlobales, setBorradoresGlobales] = useState([])     // solo si isGlobal
  const [cargandoBorradores, setCargandoBorradores] = useState(false)
  // EmpresaPerfil real (singleton id=1) — datos para auto-rellenar portada
  // + sobre empresa con razón social, eslogan, dirección, representante.
  // Si la API no responde, queda null y usamos defaults hardcoded ACR.
  const [empresaPerfil, setEmpresaPerfil] = useState(null)

  useEffect(() => {
    let cancel = false
    ;(async () => {
      try {
        const [rWho, rEmp] = await Promise.all([
          apiFetch('/api/ventas/cotizador-libre/whoami'),
          apiFetch('/api/configuracion/empresa/publico'),
        ])
        if (cancel) return
        if (rWho?.ok) {
          const w = await rWho.json()
          setWhoami(w)
        }
        if (rEmp?.ok) {
          const e = await rEmp.json()
          setEmpresaPerfil(e ?? null)
        }
      } catch { /* fail-soft — defaults */ }
    })()
    return () => { cancel = true }
  }, [])

  // ─── Defaults dinámicos basados en EmpresaPerfil real ───────────────────
  // Si la BD tiene la razón social actual, usamos esa (evita "RA" hardcoded
  // en drafts viejos que aún tengan el texto antiguo). Si no, fallback ACR.
  const empresaDefaults = useMemo(() => {
    const razon  = empresaPerfil?.razonSocial?.trim() || 'ACR Networks & Solutions'
    const eslog  = empresaPerfil?.eslogan?.trim()     || 'Infraestructura de Redes · Seguridad Electrónica · Fibra Óptica'
    const repFull = [empresaPerfil?.representanteNombre, empresaPerfil?.representanteApellido].filter(Boolean).join(' ').trim()
    return { razon, eslog, representante: repFull }
  }, [empresaPerfil])

  const portadaTextoDefault = useCallback(() => {
    const cliRazon = state.cliente?.razonSocial?.trim() || 'estimado cliente'
    const firma    = empresaDefaults.representante ? `Cordialmente,\n${empresaDefaults.representante}` : 'Cordialmente,'
    return [
      `Estimados de ${cliRazon},`,
      `Reciban un cordial saludo de parte del equipo de ${empresaDefaults.razon}.`,
      `Nos complace presentarles la siguiente propuesta técnico-comercial para el levantamiento e instalación del sistema descrito a continuación. Esta propuesta incluye equipamiento de marca reconocida, mano de obra calificada, certificación de pruebas funcionales y garantía sobre los servicios prestados.`,
      `Quedamos a su entera disposición para ampliar cualquier punto de la propuesta y avanzar con la firma del acuerdo cuando lo consideren oportuno.`,
      firma,
    ].join('\n\n')
  }, [empresaDefaults, state.cliente?.razonSocial])

  const sobreEmpresaTextoDefault = useCallback(() => {
    return [
      `${empresaDefaults.razon} es una empresa especializada en infraestructura de redes, seguridad electrónica y fibra óptica. Diseñamos, instalamos y damos mantenimiento a soluciones para escuelas, oficinas, industrias y residenciales en todo el territorio nacional.`,
      `Nuestro equipo combina experiencia de campo y certificaciones de fabricantes reconocidos (Dahua, Ubiquiti, Cambium, MikroTik) para garantizar despliegues que duran años con bajo costo operativo.`,
    ].join('\n\n')
  }, [empresaDefaults])

  const restaurarPortadaDefault = useCallback(() => {
    dispatch({ type: 'SET_PORTADA', patch: { texto: portadaTextoDefault() } })
    toast.success('Texto de portada restaurado con datos actuales de la empresa.')
  }, [portadaTextoDefault])

  const restaurarSobreEmpresaDefault = useCallback(() => {
    dispatch({ type: 'SET_SOBRE_EMPRESA', patch: { texto: sobreEmpresaTextoDefault() } })
    toast.success('Texto "Sobre nosotros" restaurado con datos actuales de la empresa.')
  }, [sobreEmpresaTextoDefault])

  // ─── Carga inicial: hidrata desde un draft existente ────────────────────
  const isReadyRef  = useRef(false)
  const debounceRef = useRef(null)
  const [saveStatus,  setSaveStatus]  = useState('idle')
  const [lastSavedAt, setLastSavedAt] = useState(null)

  useEffect(() => {
    let cancel = false
    ;(async () => {
      try {
        const r = await apiFetch(`/api/ventas/cotizador-libre/draft/${encodeURIComponent(state.numeroDocumento)}`)
        if (cancel) return
        if (r.ok) {
          const draft = await r.json()
          dispatch({ type: 'INIT_FROM_DRAFT', draft, editingEmpleadoId: null })
          if (draft?.condiciones) resetCond(draft.condiciones)
          setLastSavedAt(new Date(draft.updatedAt))
        }
      } catch { /* sin draft o sin red → defaults */ }
      finally {
        if (!cancel) setTimeout(() => { isReadyRef.current = true }, 0)
      }
    })()
    return () => { cancel = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])  // intencionalmente solo al montar

  // Persiste el numeroDocumento en LS para hidratar tras recarga.
  useEffect(() => {
    try {
      if (state.numeroDocumento) localStorage.setItem(LS_KEY_ULTIMO_DOC, state.numeroDocumento)
    } catch {}
  }, [state.numeroDocumento])

  // ─── Cálculo totales (espejo del backend _calcularTotales) ──────────────
  const totales = useMemo(() => {
    const pct = Number(state.porcentajeItbis) / 100
    const lineas = state.items.map((it) => {
      const qty = Math.max(0, Math.floor(Number(it.cantidad ?? 0)))
      const pu  = Math.max(0, Number(it.precioUnit ?? 0))
      const sub = Math.round(qty * pu * 100) / 100
      const itl = state.aplicaItbisGlobal && it.aplicaItbis ? Math.round(sub * pct * 100) / 100 : 0
      return { ...it, qty, pu, subtotal: sub, itbisLinea: itl }
    })
    const subtotal      = lineas.reduce((s, l) => s + l.subtotal, 0)
    const dscPct        = Math.max(0, Math.min(100, Number(state.descuentoPct ?? 0))) / 100
    const dscFijo       = Math.max(0, Number(state.descuentoMonto ?? 0))
    const descuentoCalc = Math.round((subtotal * dscPct + dscFijo) * 100) / 100
    const descuento     = Math.min(descuentoCalc, subtotal)
    const baseImponible = Math.max(0, subtotal - descuento)
    const itbis         = state.aplicaItbisGlobal ? Math.round(baseImponible * pct * 100) / 100 : 0
    const total         = Math.round((baseImponible + itbis) * 100) / 100
    return { lineas, subtotal, descuento, baseImponible, itbis, total }
  }, [state.items, state.aplicaItbisGlobal, state.porcentajeItbis, state.descuentoPct, state.descuentoMonto])

  // ─── Payload consolidado para auto-save (única dependencia del effect) ──
  const persistPayload = useMemo(() => ({
    numeroDocumento: state.numeroDocumento,
    cliente: state.cliente,
    items: state.items.map((l) => ({
      codigo:           l.codigo?.trim() || null,
      descripcion:      l.descripcion ?? '',
      cantidad:         Number(l.cantidad ?? 0),
      precioUnit:       Number(l.precioUnit ?? 0),
      aplicaItbis:      !!l.aplicaItbis,
      lugarInstalacion: (l.lugarInstalacion ?? '').toString().slice(0, 300),
      fotos:            Array.isArray(l.fotos) ? l.fotos.slice(0, MAX_FOTOS_X_ITEM) : [],
      categoria:        l.categoria ?? null,
      gps:              l.gps && typeof l.gps === 'object' ? l.gps : null,
    })),
    condiciones: cond,
    meta: {
      aplicaItbisGlobal:    state.aplicaItbisGlobal,
      porcentajeItbis:      Number(state.porcentajeItbis),
      descuentoGlobalPct:   Number(state.descuentoPct),
      descuentoGlobalMonto: Number(state.descuentoMonto),
      portada:              state.portada,
      sobreEmpresa:         state.sobreEmpresa,
      mostrarResumen:       state.mostrarResumen,
      estado:               state.estado,
    },
    // Solo se honra server-side si el caller es global; lo enviamos siempre
    // que estemos en modo co-edición (UI solo lo permite si isGlobal=true).
    targetEmpleadoId: state.editingEmpleadoId,
  }), [state, cond])

  // ─── Auto-save debounced 3s (única dependencia: persistPayload) ─────────
  useEffect(() => {
    if (!isReadyRef.current) return
    if (!persistPayload.numeroDocumento?.trim()) return
    setSaveStatus('idle')
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      try {
        setSaveStatus('saving')
        const res = await apiFetch('/api/ventas/cotizador-libre/draft', {
          method:  'PUT',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(persistPayload),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const j = await res.json().catch(() => ({}))
        setSaveStatus('saved')
        setLastSavedAt(j?.updatedAt ? new Date(j.updatedAt) : new Date())
      } catch {
        setSaveStatus('error')
      }
    }, 3000)
    return () => clearTimeout(debounceRef.current)
  }, [persistPayload])

  // ─── Fetch lista de borradores ──────────────────────────────────────────
  // Cuando isGlobal=true → backend devuelve TODOS los drafts (cross-user).
  // Cuando isGlobal=false → backend filtra por requesterId y devuelve solo
  // los propios. La misma función sirve para ambos modos — el backend hace
  // el filtro server-side. El UI solo cambia el label.
  const refrescarBorradoresGlobales = useCallback(async () => {
    setCargandoBorradores(true)
    try {
      const r = await apiFetch('/api/ventas/cotizador-libre/drafts?limit=50')
      if (r.ok) {
        const j = await r.json()
        setBorradoresGlobales(Array.isArray(j?.drafts) ? j.drafts : [])
      }
    } catch { /* sin red */ }
    finally { setCargandoBorradores(false) }
  }, [])

  useEffect(() => {
    // El whoami.requesterId no estará disponible en el primer render — se
    // hidrata en el otro useEffect. Fetcheamos cuando ya hay requesterId.
    if (whoami.requesterId) refrescarBorradoresGlobales()
  }, [whoami.requesterId, whoami.isGlobal, refrescarBorradoresGlobales])

  // Cargar un borrador específico (modo supervisor → cross-user).
  const cargarBorrador = useCallback(async ({ numeroDocumento, empleadoId }) => {
    try {
      isReadyRef.current = false   // evita un PUT entre el GET y el dispatch
      const url = empleadoId
        ? `/api/ventas/cotizador-libre/draft/${encodeURIComponent(numeroDocumento)}?empleadoId=${empleadoId}`
        : `/api/ventas/cotizador-libre/draft/${encodeURIComponent(numeroDocumento)}`
      const r = await apiFetch(url)
      if (!r.ok) {
        toast.error('No se pudo cargar el borrador.')
        return
      }
      const draft = await r.json()
      const cross = empleadoId && empleadoId !== whoami.requesterId
      dispatch({
        type: 'INIT_FROM_DRAFT',
        draft,
        editingEmpleadoId: cross ? empleadoId : null,
      })
      if (draft?.condiciones) resetCond(draft.condiciones)
      setLastSavedAt(new Date(draft.updatedAt))
      toast.success(cross
        ? `Cargado borrador de ${draft.empleado?.nombre ?? `empleado #${empleadoId}`} — ${draft.numeroDocumento}`
        : `Cargado borrador ${draft.numeroDocumento}`,
      )
    } catch {
      toast.error('Error al cargar el borrador.')
    } finally {
      setTimeout(() => { isReadyRef.current = true }, 50)
    }
  }, [whoami.requesterId, resetCond])

  // ─── GPS auto-tag (al primer adjunto sin gps previo) ─────────────────────
  // Solicita `navigator.geolocation` con timeout corto. Si el browser/cliente
  // niega permisos, la falla es silenciosa — la foto se adjunta sin GPS.
  async function _capturarGps() {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return null
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => resolve(null), 5000)
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          clearTimeout(timeoutId)
          resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude })
        },
        () => { clearTimeout(timeoutId); resolve(null) },
        { enableHighAccuracy: true, timeout: 5000, maximumAge: 60_000 },
      )
    })
  }

  // ─── Carga de fotos por ítem (compresión + GPS auto-tag + dispatch) ─────
  const handleAttachPhotos = useCallback(async (itemId, fileList) => {
    if (!fileList || fileList.length === 0) return
    const currentLinea = state.items.find((l) => l.id === itemId)
    const slotsLibres  = Math.max(0, MAX_FOTOS_X_ITEM - (currentLinea?.fotos?.length ?? 0))
    if (slotsLibres === 0) {
      toast.error(`Cap ${MAX_FOTOS_X_ITEM} fotos por ítem.`)
      return
    }
    // GPS solo si el ítem todavía no tiene coords (no re-trigger por cada foto).
    if (!currentLinea?.gps) {
      const gps = await _capturarGps()
      if (gps) dispatch({ type: 'UPD_ITEM', id: itemId, patch: { gps } })
    }
    const files = Array.from(fileList).slice(0, slotsLibres)
    let okCount = 0
    for (const f of files) {
      try {
        const foto = await comprimirImagen(f)
        dispatch({ type: 'ADD_FOTO', id: itemId, foto })
        okCount++
      } catch (e) {
        toast.error(`Foto ${f.name}: ${e.message}`)
      }
    }
    if (okCount > 0) toast.success(`${okCount} foto${okCount === 1 ? '' : 's'} adjunta${okCount === 1 ? '' : 's'} y comprimida${okCount === 1 ? '' : 's'}.`)
  }, [state.items])

  // ─── Plantillas (CCTV / Fibra / Red / Cerco) ────────────────────────────
  // Async: cada ítem con `_placeholder` config recibe 1 foto demo generada
  // en canvas al momento de cargar. Permite previsualizar el anexo
  // fotográfico del PDF sin tener que adjuntar fotos reales aún.
  const cargarPlantilla = useCallback(async (key) => {
    const plant = PLANTILLAS[key]
    if (!plant) return
    if (state.items.length > 1 || (state.items[0]?.descripcion?.trim())) {
      const ok = window.confirm(`¿Reemplazar las líneas actuales con la plantilla "${plant.label}"? El cliente y condiciones se mantienen.`)
      if (!ok) return
    }
    toast.info(`Generando fotos de demostración para ${plant.items.length} ítems…`)
    const itemsConFotos = await Promise.all(plant.items.map(async (it) => {
      const fotos = []
      if (it._placeholder) {
        try {
          const dataUri = await _generarFotoPlaceholder(it._placeholder)
          if (dataUri) fotos.push({ dataUri, nombre: `placeholder-${(it.codigo || 'item').toLowerCase()}.jpg`, modelo: it.codigo ?? null })
        } catch { /* sin foto, sigue */ }
      }
      // Limpiar `_placeholder` antes de pasar al reducer (no es parte del shape).
      const { _placeholder, ...rest } = it
      return { ...rest, fotos }
    }))
    dispatch({ type: 'LOAD_PLANTILLA', items: itemsConFotos })
    toast.success(`Plantilla cargada · ${plant.label} · ${plant.items.length} líneas con fotos demo`)
  }, [state.items])

  // ─── Compartir cotización por WhatsApp ──────────────────────────────────
  const compartirWhatsApp = useCallback(() => {
    const tel = (state.cliente?.telefono ?? '').toString().replace(/\D/g, '')
    if (!tel || tel.length < 10) {
      toast.error('Falta teléfono válido del cliente para compartir por WhatsApp.')
      return
    }
    const numCompleto = tel.length === 10 && /^(809|829|849)/.test(tel) ? `1${tel}` : tel
    const total = totales.total
    const msg = [
      `Hola${state.cliente?.contacto ? ` ${state.cliente.contacto}` : ''}, adjunto cotización ${state.numeroDocumento} de ACR Networks & Solutions.`,
      `${state.items.length} ítems · Total RD$ ${fmtRD(total)}`,
      `Quedo atento a sus comentarios.`,
    ].join('\n\n')
    const url = `https://wa.me/${numCompleto}?text=${encodeURIComponent(msg)}`
    window.open(url, '_blank', 'noopener,noreferrer')
  }, [state.cliente, state.numeroDocumento, state.items, totales])

  // ─── Duplicar cotización ────────────────────────────────────────────────
  const duplicarCotizacion = useCallback(() => {
    const ok = window.confirm('¿Crear una nueva cotización duplicando los ítems y condiciones actuales? El número se generará nuevo y las fotos se descartarán.')
    if (!ok) return
    dispatch({ type: 'DUPLICATE_AS_NEW' })
    toast.success('Cotización duplicada · ajusta cliente y precios para el nuevo proyecto.')
  }, [])

  // ─── Generar PDF ────────────────────────────────────────────────────────
  const [generando, setGenerando] = useState(false)
  async function generarPdf() {
    if (!state.cliente.razonSocial?.trim()) { toast.error('Falta el nombre del cliente.'); return }
    if (state.items.some((l) => !l.descripcion?.trim())) { toast.error('Todas las líneas requieren descripción.'); return }
    setGenerando(true)
    try {
      const payload = {
        numeroDocumento: state.numeroDocumento,
        titulo: 'COTIZACIÓN',
        cliente: state.cliente,
        aplicaItbisGlobal: state.aplicaItbisGlobal,
        porcentajeItbis:  Number(state.porcentajeItbis),
        descuentoGlobalPct:   Number(state.descuentoPct),
        descuentoGlobalMonto: Number(state.descuentoMonto),
        condiciones: cond,
        items: state.items.map((l) => ({
          codigo:           l.codigo?.trim() || null,
          descripcion:      l.descripcion.trim(),
          cantidad:         Number(l.cantidad ?? 0),
          precioUnit:       Number(l.precioUnit ?? 0),
          aplicaItbis:      !!l.aplicaItbis,
          lugarInstalacion: (l.lugarInstalacion ?? '').toString().slice(0, 300),
          fotos:            Array.isArray(l.fotos) ? l.fotos.slice(0, MAX_FOTOS_X_ITEM) : [],
          categoria:        l.categoria ?? null,
          gps:              l.gps && typeof l.gps === 'object' ? l.gps : null,
        })),
        portada:        state.portada,
        sobreEmpresa:   state.sobreEmpresa,
        mostrarResumen: state.mostrarResumen,
        estado:         state.estado,
      }
      const res = await apiFetch('/api/ventas/cotizador-libre/pdf', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error ?? `HTTP ${res.status}`)
      }
      const blob = await res.blob()
      if (!blob || blob.size === 0) throw new Error('El servidor devolvió un PDF vacío.')
      const url  = URL.createObjectURL(blob)
      // window.open tras await es bloqueado por popup blocker (no es gesto
      // de usuario). Usamos un anchor <a download target="_blank"> que el
      // browser trata como descarga/navegación legítima. Si el navegador es
      // restrictivo y nada pasa, ofrecemos descarga manual como fallback.
      const a = document.createElement('a')
      a.href     = url
      a.download = `cotizacion-${state.numeroDocumento || 'libre'}.pdf`
      a.target   = '_blank'
      a.rel      = 'noopener noreferrer'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      // Liberar después de 60s para no fugar memoria (tab nueva ya cargó).
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
      toast.success('PDF generado · revisa Descargas o nueva pestaña.', {
        action: {
          label: 'Abrir',
          onClick: () => window.open(url, '_blank', 'noopener,noreferrer'),
        },
      })
    } catch (e) {
      toast.error(`Error generando PDF: ${e.message}`)
    } finally { setGenerando(false) }
  }

  // ─── Render ─────────────────────────────────────────────────────────────
  const totalFotos = state.items.reduce((n, l) => n + (l.fotos?.length ?? 0), 0)
  const esCrossUser = !!(state.editingEmpleadoId && state.editingEmpleadoId !== whoami.requesterId)

  return (
    <div className="min-h-screen bg-slate-950 py-6 px-4 sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-7xl space-y-6">

        {/* ─── Header ────────────────────────────────────────────────────── */}
        <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 border-b border-slate-800 pb-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-100 tracking-tight flex items-center gap-2">
              <FileText size={24} className="text-blue-500" />
              Cotizador Manual Pro
              {totalFotos > 0 && (
                <span className="ml-2 text-[10px] font-semibold text-blue-300 bg-blue-500/10 border border-blue-500/30 rounded px-2 py-0.5 uppercase tracking-wider">
                  {totalFotos} foto{totalFotos === 1 ? '' : 's'}
                </span>
              )}
            </h1>
            <p className="text-xs text-slate-500 mt-1 tracking-wide">
              Editor libre · Sin stock rígido · PDF on-demand · Auto-guardado · Anexo fotográfico
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              onChange={(e) => { const v = e.target.value; if (v) { cargarPlantilla(v); e.target.value = '' } }}
              defaultValue=""
              title="Inyectar listado de ítems pre-armado por industria"
              className="text-xs font-bold px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 border border-emerald-500 text-white cursor-pointer shadow-md shadow-emerald-900/20 transition-colors">
              <option value="" disabled>📦 Cargar plantilla…</option>
              {Object.entries(PLANTILLAS).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
            <button
              onClick={duplicarCotizacion}
              title="Crear nueva cotización duplicando los ítems y condiciones actuales (sin fotos)"
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 border border-violet-500 text-white text-xs font-bold shadow-md shadow-violet-900/20 transition-colors">
              <Copy size={13} /> Duplicar
            </button>
            <button
              onClick={compartirWhatsApp}
              title="Abre WhatsApp con un mensaje pre-llenado al teléfono del cliente"
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-green-600 hover:bg-green-500 border border-green-500 text-white text-xs font-bold shadow-md shadow-green-900/20 transition-colors">
              <Share2 size={13} /> WhatsApp
            </button>
            <div className="flex items-center gap-2">
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">N° doc:</label>
              <input
                value={state.numeroDocumento}
                onChange={(e) => dispatch({ type: 'SET_NUMERO_DOC', value: e.target.value })}
                className={INPUT + ' w-44'}
                placeholder="COT-XXXXXX"
              />
            </div>
            <select
              value={state.estado}
              onChange={(e) => dispatch({ type: 'SET_ESTADO', value: e.target.value })}
              title="Estado de la cotización — Borrador muestra badge amarillo en PDF"
              className="text-[10px] font-bold uppercase tracking-wider px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-slate-100 cursor-pointer">
              {ESTADOS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <SaveStatusBadge status={saveStatus} lastSavedAt={lastSavedAt} />
          </div>
        </header>

        {/* ─── Lista de cotizaciones libres (propias o cross-user) ─────── */}
        {/* Visible para todos los usuarios: backend filtra por permisos.   */}
        {/* isGlobal=false → ve solo sus drafts. isGlobal=true → todos.     */}
        <section className={`bg-slate-900 rounded-xl p-4 shadow-lg border ${whoami.isGlobal ? 'border-amber-600/30' : 'border-blue-600/30'}`}>
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className={`flex items-center gap-2 ${whoami.isGlobal ? 'text-amber-300' : 'text-blue-300'}`}>
                <Users size={16} />
                <span className="text-xs font-bold uppercase tracking-wider">
                  {whoami.isGlobal ? 'Modo supervisor — cotizaciones de todos' : 'Mis cotizaciones libres'}
                </span>
                {esCrossUser && (
                  <span className="ml-2 text-[10px] text-amber-200 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-0.5">
                    Editando borrador del empleado #{state.editingEmpleadoId}
                  </span>
                )}
                <span className="ml-2 text-[10px] text-slate-500">
                  {borradoresGlobales.length} borrador{borradoresGlobales.length === 1 ? '' : 'es'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={refrescarBorradoresGlobales}
                  disabled={cargandoBorradores}
                  className={`text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded border disabled:opacity-50 ${whoami.isGlobal ? 'text-amber-300 hover:text-amber-200 border-amber-500/30' : 'text-blue-300 hover:text-blue-200 border-blue-500/30'}`}>
                  {cargandoBorradores ? 'Cargando…' : 'Refrescar'}
                </button>
                <button
                  onClick={() => dispatch({ type: 'RESET_TO_NEW' })}
                  className="text-[10px] font-bold text-slate-300 hover:text-slate-100 uppercase tracking-wider px-2 py-1 rounded border border-slate-600 bg-slate-800 hover:bg-slate-700">
                  + Nueva cotización
                </button>
              </div>
            </div>
            <div className="mt-3">
              <label className={LABEL}>
                {whoami.isGlobal ? 'Cargar / interceptar borrador del técnico' : 'Abrir un borrador existente'}
              </label>
              <select
                onChange={(e) => {
                  const v = e.target.value
                  if (!v) return
                  const [empId, num] = v.split('::')
                  cargarBorrador({ empleadoId: Number(empId), numeroDocumento: num })
                  e.target.value = ''
                }}
                className={INPUT}
                defaultValue=""
              >
                <option value="" disabled>— Seleccionar borrador —</option>
                {borradoresGlobales.length === 0 && (
                  <option disabled>Sin borradores activos</option>
                )}
                {borradoresGlobales.map((d) => {
                  const cli   = (d.cliente && typeof d.cliente === 'object' && d.cliente.razonSocial) || 'Sin cliente'
                  const fecha = d.updatedAt ? new Date(d.updatedAt).toLocaleString('es-DO', { dateStyle: 'short', timeStyle: 'short' }) : ''
                  const emp   = d.empleado?.nombre ?? `Empl. #${d.empleadoId}`
                  const esMio = d.empleadoId === whoami.requesterId
                  return (
                    <option key={d.id} value={`${d.empleadoId}::${d.numeroDocumento}`}>
                      {whoami.isGlobal && !esMio ? `${emp} · ` : ''}{d.numeroDocumento} · {cli} · {fecha}
                    </option>
                  )
                })}
              </select>
              {whoami.isGlobal && (
                <p className="text-[10px] text-slate-500 mt-2 leading-relaxed">
                  Cualquier edición que hagas aquí <strong>sobreescribe el borrador del técnico original</strong> en tiempo real (auto-save a 3s). Útil para co-diseñar la propuesta — sin último-escritor-pierde garantizado.
                </p>
              )}
            </div>
          </section>

        {/* ─── Cliente ─────────────────────────────────────────────────── */}
        <section className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg">
          <h2 className="flex items-center gap-2 text-sm font-bold text-slate-100 uppercase tracking-wider mb-4">
            <Building2 size={16} className="text-blue-500" />
            Cliente
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2">
              <label className={LABEL}>Razón social *</label>
              <input
                value={state.cliente.razonSocial}
                onChange={(e) => dispatch({ type: 'SET_CLIENTE', patch: { razonSocial: e.target.value } })}
                className={INPUT}
                placeholder="Escuela Benito Juárez"
              />
            </div>
            <div>
              <label className={LABEL}>RNC / Cédula</label>
              <input
                value={state.cliente.rnc ?? ''}
                onChange={(e) => dispatch({ type: 'SET_CLIENTE', patch: { rnc: e.target.value } })}
                className={INPUT}
                placeholder="Opcional"
              />
            </div>
            <div>
              <label className={LABEL}>Persona de contacto</label>
              <input
                value={state.cliente.contacto ?? ''}
                onChange={(e) => dispatch({ type: 'SET_CLIENTE', patch: { contacto: e.target.value } })}
                className={INPUT}
                placeholder="Nombre del contacto"
              />
            </div>
            <div>
              <label className={LABEL}>Teléfono (opcional)</label>
              <input
                value={state.cliente.telefono ?? ''}
                onChange={(e) => dispatch({ type: 'SET_CLIENTE', patch: { telefono: e.target.value } })}
                className={INPUT}
                placeholder="809-000-0000"
              />
            </div>
            <div className="sm:col-span-2 lg:col-span-3">
              <label className={LABEL}>Dirección de la instalación</label>
              <input
                value={state.cliente.direccion ?? ''}
                onChange={(e) => dispatch({ type: 'SET_CLIENTE', patch: { direccion: e.target.value } })}
                className={INPUT}
                placeholder="C/ Ejemplo #123, Sector, Provincia"
              />
            </div>
          </div>
        </section>

        {/* ─── Portada (carta de presentación) ─────────────────────────── */}
        <section className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg">
          <div className="flex items-center justify-between mb-3">
            <h2 className="flex items-center gap-2 text-sm font-bold text-slate-100 uppercase tracking-wider">
              <BookOpen size={16} className="text-amber-400" />
              Carta de Presentación
              <span className="text-[10px] font-normal text-slate-500 normal-case tracking-normal">
                · Página 1 dedicada antes de la cotización
              </span>
            </h2>
            <label className="flex items-center gap-2 cursor-pointer">
              <span className={`text-[10px] font-bold uppercase tracking-wider ${state.portada.activa ? 'text-amber-300' : 'text-slate-500'}`}>
                {state.portada.activa ? 'En PDF' : 'Oculto'}
              </span>
              <input
                type="checkbox"
                checked={state.portada.activa}
                onChange={(e) => dispatch({ type: 'SET_PORTADA', patch: { activa: e.target.checked } })}
                className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-amber-500 focus:ring-amber-500/30"
              />
            </label>
          </div>
          <div className="relative">
            <textarea
              value={state.portada.texto}
              onChange={(e) => dispatch({ type: 'SET_PORTADA', patch: { texto: e.target.value } })}
              rows={6}
              maxLength={8000}
              placeholder="Estimados, reciban un cordial saludo..."
              className={INPUT + ' font-normal'}
              style={{ resize: 'vertical', minHeight: '120px' }}
            />
            <div className="absolute top-1 right-1">
              <VoiceDictationButton
                value={state.portada.texto}
                onChange={(v) => dispatch({ type: 'SET_PORTADA', patch: { texto: v } })}
              />
            </div>
          </div>
          <div className="flex justify-between items-center mt-1 gap-2">
            <span className="text-[10px] text-slate-500 italic">
              {state.portada.activa ? 'Aparece como página 1 del PDF con membrete + firma del Owner' : 'Activa el toggle para que esta página salga en el PDF'}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={restaurarPortadaDefault}
                title={empresaPerfil ? `Usar texto sugerido con datos actuales de ${empresaDefaults.razon}` : 'Reescribir con texto sugerido por defecto'}
                className="text-[10px] font-semibold text-amber-300 hover:text-amber-200 uppercase tracking-wider px-2 py-1 rounded border border-amber-500/30 hover:bg-amber-500/10 transition-colors">
                ↻ Texto sugerido
              </button>
              <span className="text-[9px] text-slate-600">{state.portada.texto.length}/8000</span>
            </div>
          </div>
        </section>

        {/* ─── Sobre la empresa (bloque opcional pre-tabla items) ─────── */}
        <section className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg">
          <div className="flex items-center justify-between mb-3">
            <h2 className="flex items-center gap-2 text-sm font-bold text-slate-100 uppercase tracking-wider">
              <Sparkles size={16} className="text-cyan-400" />
              Sobre Nosotros / Pitch Empresarial
              <span className="text-[10px] font-normal text-slate-500 normal-case tracking-normal">
                · Bloque pre-tabla de ítems
              </span>
            </h2>
            <label className="flex items-center gap-2 cursor-pointer">
              <span className={`text-[10px] font-bold uppercase tracking-wider ${state.sobreEmpresa.activa ? 'text-cyan-300' : 'text-slate-500'}`}>
                {state.sobreEmpresa.activa ? 'En PDF' : 'Oculto'}
              </span>
              <input
                type="checkbox"
                checked={state.sobreEmpresa.activa}
                onChange={(e) => dispatch({ type: 'SET_SOBRE_EMPRESA', patch: { activa: e.target.checked } })}
                className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-cyan-500 focus:ring-cyan-500/30"
              />
            </label>
          </div>
          <div className="relative">
            <textarea
              value={state.sobreEmpresa.texto}
              onChange={(e) => dispatch({ type: 'SET_SOBRE_EMPRESA', patch: { texto: e.target.value } })}
              rows={4}
              maxLength={8000}
              placeholder="ACR Networks & Solutions es una empresa especializada en..."
              className={INPUT + ' font-normal'}
              style={{ resize: 'vertical', minHeight: '90px' }}
            />
            <div className="absolute top-1 right-1">
              <VoiceDictationButton
                value={state.sobreEmpresa.texto}
                onChange={(v) => dispatch({ type: 'SET_SOBRE_EMPRESA', patch: { texto: v } })}
              />
            </div>
          </div>
          <div className="flex justify-end items-center mt-1 gap-2">
            <button
              onClick={restaurarSobreEmpresaDefault}
              title={empresaPerfil ? `Usar texto sugerido con datos actuales de ${empresaDefaults.razon}` : 'Reescribir con texto sugerido por defecto'}
              className="text-[10px] font-semibold text-cyan-300 hover:text-cyan-200 uppercase tracking-wider px-2 py-1 rounded border border-cyan-500/30 hover:bg-cyan-500/10 transition-colors">
              ↻ Texto sugerido
            </button>
            <span className="text-[9px] text-slate-600">{state.sobreEmpresa.texto.length}/8000</span>
          </div>
        </section>

        {/* ─── Resumen ejecutivo toggle ─────────────────────────────────── */}
        <section className="bg-slate-900 border border-slate-800 rounded-xl p-3 shadow-lg">
          <label className="flex items-center justify-between cursor-pointer gap-3">
            <div className="flex items-center gap-2">
              <Layers size={16} className="text-blue-400" />
              <div>
                <div className="text-sm font-bold text-slate-100">Resumen ejecutivo por categoría</div>
                <div className="text-[10px] text-slate-500">Tabla compacta pre-detalle: total por Equipos / Cableado / Servicios / Capacitación</div>
              </div>
            </div>
            <input
              type="checkbox"
              checked={state.mostrarResumen}
              onChange={(e) => dispatch({ type: 'SET_MOSTRAR_RESUMEN', value: e.target.checked })}
              className="w-5 h-5 rounded border-slate-600 bg-slate-800 text-blue-500 focus:ring-blue-500/30"
            />
          </label>
        </section>

        {/* ─── Tabla de ítems ─────────────────────────────────────────── */}
        <section className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg">
          <div className="flex items-center justify-between mb-4">
            <h2 className="flex items-center gap-2 text-sm font-bold text-slate-100 uppercase tracking-wider">
              Ítems del proyecto
              <span className="text-[10px] font-normal text-slate-500 normal-case tracking-normal">
                · {state.items.length} línea{state.items.length !== 1 ? 's' : ''}
              </span>
            </h2>
            <button
              onClick={() => dispatch({ type: 'ADD_ITEM' })}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold transition-colors">
              <Plus size={13} /> Añadir Fila
            </button>
          </div>
          <div className="space-y-3">
            {totales.lineas.map((l, idx) => (
              <ItemRow
                key={l.id}
                idx={idx}
                linea={l}
                aplicaItbisGlobal={state.aplicaItbisGlobal}
                onUpdate={(patch) => dispatch({ type: 'UPD_ITEM', id: l.id, patch })}
                onDelete={() => dispatch({ type: 'DEL_ITEM', id: l.id })}
                onAttachPhotos={(fl) => handleAttachPhotos(l.id, fl)}
                onDeletePhoto={(i) => dispatch({ type: 'DEL_FOTO', id: l.id, index: i })}
                disabled={state.items.length === 1}
              />
            ))}
          </div>
        </section>

        {/* ─── Impuestos / descuentos / totales ─────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <section className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg">
            <h2 className="flex items-center gap-2 text-sm font-bold text-slate-100 uppercase tracking-wider mb-4">
              <ShieldCheck size={16} className="text-blue-500" />
              Impuestos y Descuentos
            </h2>
            <div className="space-y-4">
              <label className="flex items-center justify-between gap-4 p-3 rounded-lg bg-slate-800/50 border border-slate-700 cursor-pointer">
                <div>
                  <div className="text-sm font-medium text-slate-100">Aplicar ITBIS global</div>
                  <div className="text-[10px] text-slate-500 mt-0.5">Switch general — desactivar omite ITBIS en todas las líneas</div>
                </div>
                <input
                  type="checkbox"
                  checked={state.aplicaItbisGlobal}
                  onChange={(e) => dispatch({ type: 'SET_APLICA_ITBIS_GLOBAL', value: e.target.checked })}
                  className="w-5 h-5 rounded border-slate-600 bg-slate-800 text-blue-500 focus:ring-blue-500/30"
                />
              </label>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className={LABEL}>% ITBIS</label>
                  <input
                    type="number" min="0" max="40" step="0.01"
                    value={state.porcentajeItbis}
                    onChange={(e) => dispatch({ type: 'SET_PCT_ITBIS', value: e.target.value })}
                    disabled={!state.aplicaItbisGlobal}
                    className={INPUT + ' text-right disabled:opacity-50'}
                  />
                </div>
                <div>
                  <label className={LABEL}>Descuento %</label>
                  <input
                    type="number" min="0" max="100" step="0.01"
                    value={state.descuentoPct}
                    onChange={(e) => dispatch({ type: 'SET_DSC_PCT', value: e.target.value })}
                    className={INPUT + ' text-right'}
                  />
                </div>
                <div>
                  <label className={LABEL}>Descuento RD$</label>
                  <input
                    type="number" min="0" step="0.01"
                    value={state.descuentoMonto}
                    onChange={(e) => dispatch({ type: 'SET_DSC_MONTO', value: e.target.value })}
                    className={INPUT + ' text-right'}
                  />
                </div>
              </div>
            </div>
          </section>

          <section className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg">
            <h2 className="text-sm font-bold text-slate-100 uppercase tracking-wider mb-4">Totales</h2>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between text-slate-300">
                <span>Subtotal</span>
                <span className="tabular-nums">RD$ {fmtRD(totales.subtotal)}</span>
              </div>
              {totales.descuento > 0 && (
                <div className="flex justify-between text-amber-400">
                  <span>Descuento</span>
                  <span className="tabular-nums">− RD$ {fmtRD(totales.descuento)}</span>
                </div>
              )}
              {state.aplicaItbisGlobal && (
                <div className="flex justify-between text-slate-300 border-t border-slate-800 pt-2">
                  <span>ITBIS {Number(state.porcentajeItbis).toFixed(0)}%</span>
                  <span className="tabular-nums">RD$ {fmtRD(totales.itbis)}</span>
                </div>
              )}
              <div className="flex justify-between bg-blue-600/20 border border-blue-600/40 rounded-lg px-3 py-3 mt-2">
                <span className="text-blue-300 font-bold text-base">Total Neto RD$</span>
                <span className="text-blue-300 font-bold text-base tabular-nums">RD$ {fmtRD(totales.total)}</span>
              </div>
            </div>
          </section>
        </div>

        {/* ─── Editor de condiciones ──────────────────────────────────── */}
        <section className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg">
          <h2 className="text-sm font-bold text-slate-100 uppercase tracking-wider mb-4">
            Condiciones del documento
            <span className="text-[10px] font-normal text-slate-500 normal-case tracking-normal ml-2">
              · Switches para incluir/omitir cada bloque en el PDF
            </span>
          </h2>
          <EditorCondiciones
            keys={['validez','pago','entrega','garantia','notas']}
            values={condValues}
            mostrar={condMostrar}
            onChange={condOnChange}
            onMostrar={condOnMostrar}
            editAlwaysOn
            formaPagoChildren={
              <select
                value={condValues.pago ?? ''}
                onChange={(e) => condOnChange('pago', e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-100 focus:outline-none focus:border-blue-500"
              >
                <option value="">(Personalizado)</option>
                {FORMA_PAGO_OPCIONES.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            }
          />
          <div className="flex justify-end mt-3">
            <button
              onClick={() => resetCond(CONDICIONES_DEFAULT)}
              className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors uppercase tracking-wider">
              Restaurar defaults
            </button>
          </div>
        </section>

        {/* ─── Botón generar PDF ─────────────────────────────────────── */}
        <div className="sticky bottom-4 z-10 flex justify-end">
          <button
            onClick={generarPdf}
            disabled={generando}
            className="flex items-center gap-2 px-6 py-3 rounded-xl bg-gradient-to-br from-blue-600 to-blue-700 hover:from-blue-500 hover:to-blue-600 text-white font-bold text-sm shadow-2xl shadow-blue-900/40 transition-all disabled:opacity-50 disabled:cursor-not-allowed">
            {generando ? <Loader2 size={16} className="animate-spin" /> : <FileDown size={16} />}
            {generando ? 'Generando PDF…' : 'Generar Cotización PDF'}
          </button>
        </div>

      </div>
    </div>
  )
}

// ─── Sub-componente ItemRow: línea Excel-style con panel multimedia visible ──
// Ciclo 14: TODOS los campos editables son visibles sin clics secundarios.
// Layout responsive:
//   md+: una fila spreadsheet con índice + codigo + descripción + qty + precio
//        + ITBIS + importe + 🗑, ancho fijo por columna para alineación tabla.
//   <md: mismos inputs apilados en grid 2-col compacto, sin truncar nada.
// El panel multimedia (lugar de instalación + fotos) siempre se renderiza
// debajo como bloque secundario — no hay expand/collapse.
function ItemRow({
  idx, linea, aplicaItbisGlobal,
  onUpdate, onDelete, onAttachPhotos, onDeletePhoto,
  disabled,
}) {
  const fileInputRef = useRef(null)

  const onPickFiles = () => fileInputRef.current?.click()
  const onFileChange = (e) => {
    onAttachPhotos(e.target.files)
    e.target.value = ''  // permitir re-seleccionar mismo archivo
  }
  const onDrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer?.files?.length) onAttachPhotos(e.dataTransfer.files)
  }

  const fotosCount = linea.fotos?.length ?? 0

  return (
    <div className="bg-slate-800/30 border border-slate-800 rounded-lg overflow-hidden">
      {/* ─── Fila Excel-style: todos los inputs siempre visibles ──────────── */}
      {/* En md+ usa CSS Grid con anchos explícitos para verse como tabla; en */}
      {/* mobile colapsa a 2 columnas apiladas sin perder ningún campo.       */}
      <div className="p-3 grid gap-2 items-center md:gap-3
                      grid-cols-[36px_1fr_1fr]
                      md:grid-cols-[36px_140px_1fr_80px_120px_80px_120px_40px]">
        {/* # */}
        <div className="text-slate-500 text-xs font-bold text-center md:text-left">
          {idx + 1}
        </div>

        {/* Código (mobile span 2; md una sola celda) */}
        <div className="col-span-2 md:col-span-1">
          <label className="md:hidden text-[9px] font-bold text-slate-500 uppercase tracking-wider mb-1 block">Código / Modelo</label>
          <input
            value={linea.codigo ?? ''}
            onChange={(e) => onUpdate({ codigo: e.target.value })}
            placeholder="Código / modelo"
            className={INPUT + ' py-1.5 text-xs'}
          />
        </div>

        {/* Descripción (con voice dictation) */}
        <div className="col-span-3 md:col-span-1">
          <label className="md:hidden text-[9px] font-bold text-slate-500 uppercase tracking-wider mb-1 block">Descripción Técnica</label>
          <div className="relative">
            <input
              value={linea.descripcion ?? ''}
              onChange={(e) => onUpdate({ descripcion: e.target.value })}
              placeholder="Descripción del ítem (Cámara IP 4MP Dahua HFW1239T1...)"
              className={INPUT + ' py-1.5 text-xs pr-9'}
            />
            <div className="absolute top-0 right-0 h-full flex items-center pr-1">
              <VoiceDictationButton
                value={linea.descripcion ?? ''}
                onChange={(v) => onUpdate({ descripcion: v })}
              />
            </div>
          </div>
        </div>

        {/* Cantidad */}
        <div className="col-span-1 md:col-span-1">
          <label className="md:hidden text-[9px] font-bold text-slate-500 uppercase tracking-wider mb-1 block">Cant.</label>
          <input
            type="number" min="0" step="1"
            value={linea.cantidad ?? 0}
            onChange={(e) => onUpdate({ cantidad: e.target.value })}
            placeholder="0"
            className={INPUT + ' py-1.5 text-xs text-center'}
          />
        </div>

        {/* Precio Unitario */}
        <div className="col-span-2 md:col-span-1">
          <label className="md:hidden text-[9px] font-bold text-slate-500 uppercase tracking-wider mb-1 block">Precio Unit. RD$</label>
          <input
            type="number" min="0" step="0.01"
            value={linea.precioUnit ?? 0}
            onChange={(e) => onUpdate({ precioUnit: e.target.value })}
            placeholder="0.00"
            className={INPUT + ' py-1.5 text-xs text-right'}
          />
        </div>

        {/* ITBIS checkbox */}
        <div className="col-span-1 md:col-span-1 flex items-center justify-center">
          <label
            className="cursor-pointer flex items-center gap-1 text-slate-300 hover:text-blue-400 transition-colors"
            title={aplicaItbisGlobal ? 'Aplicar ITBIS a esta línea' : 'ITBIS global desactivado'}>
            <input
              type="checkbox"
              checked={!!linea.aplicaItbis}
              onChange={(e) => onUpdate({ aplicaItbis: e.target.checked })}
              disabled={!aplicaItbisGlobal}
              className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-blue-500 focus:ring-blue-500/30 disabled:opacity-40"
            />
            <span className="text-[10px] uppercase tracking-wider font-bold">ITBIS</span>
          </label>
        </div>

        {/* Importe calculado */}
        <div className="col-span-2 md:col-span-1 text-right">
          <div className="md:hidden text-[9px] font-bold text-slate-500 uppercase tracking-wider mb-1">Importe</div>
          <div className="text-slate-100 text-sm font-bold tabular-nums">
            RD$ {fmtRD(linea.subtotal)}
          </div>
        </div>

        {/* Botón eliminar */}
        <div className="col-span-1 flex justify-end">
          <button
            onClick={onDelete}
            disabled={disabled}
            title="Eliminar línea"
            className="p-1.5 rounded text-slate-500 hover:text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {/* ─── Panel multimedia SIEMPRE visible (Cristian: lugar + fotos) ───── */}
      <div
        className="border-t border-slate-800 bg-slate-900/50 p-3 rounded-b-lg space-y-3"
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
        onDrop={onDrop}
      >
        {/* Categoría + Lugar de instalación + GPS coords */}
        <div className="grid grid-cols-1 md:grid-cols-[140px_1fr] gap-2 items-end">
          <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
              <Tag size={11} className="text-cyan-400" />
              Categoría
            </label>
            <select
              value={linea.categoria ?? ''}
              onChange={(e) => onUpdate({ categoria: e.target.value || null })}
              className={INPUT + ' py-1.5 text-xs'}>
              <option value="">(auto)</option>
              {CATEGORIAS.filter(Boolean).map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5 flex items-center justify-between gap-1.5">
              <span className="flex items-center gap-1.5">
                <MapPin size={11} className="text-amber-400" />
                Lugar de Instalación / Nota Técnica
              </span>
              {linea.gps?.lat != null && (
                <span className="text-[9px] font-normal normal-case tracking-normal text-emerald-400/80" title="Coordenadas auto-capturadas al adjuntar foto">
                  GPS {Number(linea.gps.lat).toFixed(5)}, {Number(linea.gps.lng).toFixed(5)}
                </span>
              )}
            </label>
            <div className="relative">
              <input
                value={linea.lugarInstalacion ?? ''}
                onChange={(e) => onUpdate({ lugarInstalacion: e.target.value })}
                placeholder="Instalada en pasillo central, altura 4m, dirección hacia entrada principal..."
                className={INPUT + ' py-1.5 text-xs pr-10'}
                maxLength={300}
              />
              <div className="absolute top-0 right-0 h-full flex items-center pr-1">
                <VoiceDictationButton
                  value={linea.lugarInstalacion ?? ''}
                  onChange={(v) => onUpdate({ lugarInstalacion: v })}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Fotos de campo (input file + miniaturas) */}
        <div>
          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5 flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5">
              <Camera size={11} className="text-blue-400" />
              Fotos de Campo (Máx {MAX_FOTOS_X_ITEM})
            </span>
            <span className="normal-case text-slate-500 tracking-normal text-[10px] font-normal">
              {fotosCount} / {MAX_FOTOS_X_ITEM} · Comprimidas 1280px · JPEG 70%
            </span>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            {linea.fotos?.map((f, i) => (
              <div key={i} className="relative group">
                <img
                  src={f.dataUri}
                  alt={f.nombre ?? `Foto ${i + 1}`}
                  className="w-20 h-20 object-cover rounded border border-slate-700"
                />
                <button
                  onClick={() => onDeletePhoto(i)}
                  title="Eliminar foto"
                  className="absolute -top-1 -right-1 bg-red-600 hover:bg-red-500 text-white rounded-full w-5 h-5 flex items-center justify-center opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity shadow-lg">
                  <XIcon size={11} />
                </button>
              </div>
            ))}
            {fotosCount < MAX_FOTOS_X_ITEM && (
              <button
                onClick={onPickFiles}
                className="w-20 h-20 rounded border-2 border-dashed border-slate-700 hover:border-blue-500 hover:bg-blue-500/5 text-slate-500 hover:text-blue-400 flex flex-col items-center justify-center gap-1 transition-colors">
                <Camera size={16} />
                <span className="text-[9px] font-bold uppercase tracking-wider">Adjuntar</span>
              </button>
            )}
            {fotosCount === 0 && (
              <div className="flex items-center gap-1 text-[10px] text-slate-500 italic ml-2">
                <ImageOff size={11} /> Sin fotos · Tap "Adjuntar" o arrastra imagen aquí
              </div>
            )}
          </div>
          {/* Input file siempre montado (oculto), accept image/* + capture environment para celular */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            capture="environment"
            className="hidden"
            onChange={onFileChange}
          />
        </div>
      </div>
    </div>
  )
}
