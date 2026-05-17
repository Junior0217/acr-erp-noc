/**
 * backend/scripts/seeds/portal.js
 *
 * Seed standalone para el flujo Portal B2C de demos: cliente corporativo,
 * 2 servicios activos (Fibra + CCTV), 3 facturas con estados variados,
 * catálogo de 6 items + 2 planes WISP/CCTV.
 *
 * Antes vivía como POST /api/dev/seed-portal — era un endpoint HTTP "dev"
 * protegido por SEED_SECRET en prod. Fase 1.4 lo migra a CLI script:
 *   1. Cero superficie de ataque pública.
 *   2. Audit trail nativo via shell history.
 *   3. Idempotente vía upsert — re-corrida es segura.
 *
 * Ejecutar:
 *   node backend/scripts/seeds/portal.js
 *
 * Variables sensibles via env (DATABASE_URL desde .env).
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function seedPortal() {
  const catalogItems = await prisma.$transaction(async (tx) => {
    return Promise.all([
      tx.itemCatalogo.upsert({ where: { id: 'seed-cam-hd' },    update: {}, create: { id: 'seed-cam-hd',    nombre: 'Cámara IP HD 1080p Exterior', tipo: 'VentaUnica', categoria: 'CCTV',  precio: 8500,  costo: 4800, tipoItem: 'ARTICULO', activo: true } }),
      tx.itemCatalogo.upsert({ where: { id: 'seed-cam-4k' },    update: {}, create: { id: 'seed-cam-4k',    nombre: 'Cámara IP 4K Analíticas IA',   tipo: 'VentaUnica', categoria: 'CCTV',  precio: 18000, costo: 9500, tipoItem: 'ARTICULO', activo: true } }),
      tx.itemCatalogo.upsert({ where: { id: 'seed-router-ent' },update: {}, create: { id: 'seed-router-ent',nombre: 'Router Mikrotik RB4011',       tipo: 'VentaUnica', categoria: 'Redes', precio: 22000, costo: 13000,tipoItem: 'ARTICULO', activo: true } }),
      tx.itemCatalogo.upsert({ where: { id: 'seed-ap-unifi' },  update: {}, create: { id: 'seed-ap-unifi',  nombre: 'AP UniFi U6 Pro WiFi 6',       tipo: 'VentaUnica', categoria: 'Redes', precio: 14500, costo: 8200, tipoItem: 'ARTICULO', activo: true } }),
      tx.itemCatalogo.upsert({ where: { id: 'seed-audit-red' }, update: {}, create: { id: 'seed-audit-red', nombre: 'Auditoría de Red Corporativa', tipo: 'Servicio',   categoria: 'Redes', precio: 35000, costo: 8000, tipoItem: 'SERVICIO', activo: true } }),
      tx.itemCatalogo.upsert({ where: { id: 'seed-mant-mens' }, update: {}, create: { id: 'seed-mant-mens', nombre: 'Mantenimiento Mensual Preventivo', tipo: 'Recurrente', categoria: 'Redes', precio: 5500, costo: 1500, tipoItem: 'SERVICIO', activo: true } }),
    ]);
  });

  const planFibra = await prisma.plan.upsert({
    where:  { id: 'seed-plan-fibra' },
    update: {},
    create: { id: 'seed-plan-fibra', nombre: 'Fibra Empresarial 200 Mbps', tipo: 'WISP', precioMensualBase: 9500, precioInstalBase: 5000, activo: true },
  });
  const planCCTV = await prisma.plan.upsert({
    where:  { id: 'seed-plan-cctv' },
    update: {},
    create: { id: 'seed-plan-cctv',  nombre: 'Videovigilancia Corporativa 8 Cámaras', tipo: 'CCTV', precioMensualBase: 3500, precioInstalBase: 42000, activo: true },
  });

  const count = await prisma.cliente.count();
  const noCliente = `EMP-${String(count + 1).padStart(4, '0')}`;
  const hash = await bcrypt.hash('Demo2026!', 12);
  const cliente = await prisma.cliente.upsert({
    where:  { email: 'demo.empresa@acrtest.do' },
    update: { passwordHash: hash },
    create: {
      noCliente,
      razonSocial:       'Corporación Demo S.R.L.',
      email:             'demo.empresa@acrtest.do',
      passwordHash:      hash,
      tipoEmpresa:       'Sociedad de Responsabilidad Limitada',
      tipoCliente:       'Corporativo',
      nombreContacto:    'Carlos Empresario',
      apellidoContacto:  'Demo',
      cargo:             'Gerente de TI',
      telefono:          '809-555-1234',
      telefonoPrincipal: '809-555-1234',
      direccion:         'Av. Winston Churchill #55, Torre Empresarial, Piso 8',
      sector:            'Piantini',
      provincia:         'Distrito Nacional',
      limiteCredito:     100000,
      diasCredito:       30,
      itbis:             true,
    },
  });

  await Promise.all([
    prisma.servicio.upsert({
      where:  { id: 'seed-svc-fibra' },
      update: {},
      create: { id: 'seed-svc-fibra', clienteId: cliente.id, planId: planFibra.id, estado: 'Activo', precioMensual: 9500, precioInstalacion: 5000, notasTecnicas: 'Fibra óptica FTTH instalada el 2026-01-15', direccionInstalacion: 'Torre Empresarial Piso 8' },
    }),
    prisma.servicio.upsert({
      where:  { id: 'seed-svc-cctv' },
      update: {},
      create: { id: 'seed-svc-cctv',  clienteId: cliente.id, planId: planCCTV.id,  estado: 'Activo', precioMensual: 3500, precioInstalacion: 42000, notasTecnicas: '8 cámaras IP 4K instaladas, NVR configurado con retención 30 días', direccionInstalacion: 'Torre Empresarial — todas las plantas' },
    }),
  ]);

  const factBase = { clienteId: cliente.id, subtotal: 9500, itbis: 1235, total: 10735, tipoNcf: 'Crédito Fiscal', esCotizacion: false };
  const now = new Date();
  const d = (daysAgo) => { const x = new Date(now); x.setDate(x.getDate() - daysAgo); return x; };
  await Promise.all([
    prisma.factura.upsert({ where: { noFactura: 'B01-SEED-001' }, update: {}, create: { ...factBase, noFactura: 'B01-SEED-001', estado: 'Vencida', ncf: 'B0100000001', fechaEmision: d(45), fechaVence: d(15) } }),
    prisma.factura.upsert({ where: { noFactura: 'B01-SEED-002' }, update: {}, create: { ...factBase, noFactura: 'B01-SEED-002', estado: 'Pagada',  ncf: 'B0100000002', fechaEmision: d(75), fechaVence: d(45), fechaPago: d(40) } }),
    prisma.factura.upsert({ where: { noFactura: 'B01-SEED-003' }, update: {}, create: { ...factBase, noFactura: 'B01-SEED-003', estado: 'Emitida', ncf: 'B0100000003', fechaEmision: d(10), fechaVence: d(-20) } }),
  ]);

  return {
    cliente:  { id: cliente.id, email: 'demo.empresa@acrtest.do', password: 'Demo2026!' },
    servicios: 2,
    facturas:  3,
    catalogo:  catalogItems.length,
  };
}

if (require.main === module) {
  seedPortal()
    .then((out) => {
      console.log('[SEED PORTAL] ok', out);
      console.log(`[SEED PORTAL] Login: ${out.cliente.email} / ${out.cliente.password}`);
      return prisma.$disconnect();
    })
    .catch((e) => {
      console.error('[SEED PORTAL] failed:', e.message);
      return prisma.$disconnect().finally(() => process.exit(1));
    });
}

module.exports = seedPortal;
