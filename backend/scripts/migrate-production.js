'use strict';
// Migrate data from OLD_DATABASE_URL → DATABASE_URL (Supabase)
// Usage:
//   OLD_DATABASE_URL="postgres://..." DATABASE_URL="postgres://..." node backend/scripts/migrate-production.js
//
// Safe to run multiple times — uses upsert throughout.
// Int auto-increment IDs (Rol, Empleado, Categoria, Producto) differ between DBs.
// ID maps are built per run to rewire foreign keys correctly.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { PrismaClient } = require('@prisma/client');

if (!process.env.OLD_DATABASE_URL) {
  console.error('CRITICAL: OLD_DATABASE_URL is not set');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('CRITICAL: DATABASE_URL is not set');
  process.exit(1);
}

const src = new PrismaClient({ datasources: { db: { url: process.env.OLD_DATABASE_URL } } });
const dst = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

// ─── ID maps (old Int id → new Int id) ───────────────────────────────────────
const rolMap      = new Map(); // old rol id     → new rol id
const empMap      = new Map(); // old empleado id → new empleado id
const catMap      = new Map(); // old categoria id → new categoria id
const prodMap     = new Map(); // old producto id  → new producto id
const itemMap     = new Map(); // old itemCatalogo id (String uuid) — same, no map needed

function log(table, count) {
  console.log(`  [${table.padEnd(22)}] ${count} records processed`);
}

// ─── 1. Roles ─────────────────────────────────────────────────────────────────
async function migrateRoles() {
  const rows = await src.rol.findMany();
  for (const r of rows) {
    const created = await dst.rol.upsert({
      where:  { nombre: r.nombre },
      update: { descripcion: r.descripcion, permisos: r.permisos, activo: r.activo, require2FA: r.require2FA },
      create: { nombre: r.nombre, descripcion: r.descripcion, permisos: r.permisos, activo: r.activo, require2FA: r.require2FA },
    });
    rolMap.set(r.id, created.id);
  }
  log('Rol', rows.length);
}

// ─── 2. Empleados ─────────────────────────────────────────────────────────────
async function migrateEmpleados() {
  const rows = await src.empleado.findMany({ include: { roles: true } });
  for (const e of rows) {
    const newRoleIds = e.roles
      .map(r => rolMap.get(r.id))
      .filter(Boolean)
      .map(id => ({ id }));

    const created = await dst.empleado.upsert({
      where:  { email: e.email },
      update: {
        nombre:          e.nombre,
        cargo:           e.cargo,
        passwordHash:    e.passwordHash,
        bloqueado:       e.bloqueado,
        permisosExtra:   e.permisosExtra,
        twoFactorSecret: e.twoFactorSecret,
        twoFactorEnabled:e.twoFactorEnabled,
        roles:           { set: newRoleIds },
      },
      create: {
        nombre:          e.nombre,
        cargo:           e.cargo,
        email:           e.email,
        passwordHash:    e.passwordHash,
        bloqueado:       e.bloqueado,
        permisosExtra:   e.permisosExtra,
        twoFactorSecret: e.twoFactorSecret,
        twoFactorEnabled:e.twoFactorEnabled,
        roles:           { connect: newRoleIds },
      },
    });
    empMap.set(e.id, created.id);
  }
  log('Empleado', rows.length);
}

// ─── 3. Categorias ────────────────────────────────────────────────────────────
async function migrateCategorias() {
  const rows = await src.categoria.findMany();
  for (const c of rows) {
    const created = await dst.categoria.upsert({
      where:  { nombre: c.nombre },
      update: {},
      create: { nombre: c.nombre },
    });
    catMap.set(c.id, created.id);
  }
  log('Categoria', rows.length);
}

// ─── 4. Productos ─────────────────────────────────────────────────────────────
async function migrateProductos() {
  const rows = await src.producto.findMany();
  for (const p of rows) {
    const newCatId = catMap.get(p.categoriaId);
    if (!newCatId) { console.warn(`  [Producto] SKU ${p.sku} skipped — categoria not found`); continue; }
    const created = await dst.producto.upsert({
      where:  { sku: p.sku },
      update: { nombre: p.nombre, precio: p.precio, stockActual: p.stockActual, categoriaId: newCatId },
      create: { sku: p.sku, nombre: p.nombre, precio: p.precio, stockActual: p.stockActual, categoriaId: newCatId },
    });
    prodMap.set(p.id, created.id);
  }
  log('Producto', rows.length);
}

// ─── 5. Suplidores ────────────────────────────────────────────────────────────
async function migrateSuplidores() {
  const rows = await src.suplidor.findMany();
  for (const s of rows) {
    await dst.suplidor.upsert({
      where:  { noSuplidor: s.noSuplidor },
      update: { razonSocial: s.razonSocial, nombreComercial: s.nombreComercial, rnc: s.rnc, direccion: s.direccion, sector: s.sector, provincia: s.provincia, latitud: s.latitud, longitud: s.longitud, nombreContacto: s.nombreContacto, cedula: s.cedula, cargo: s.cargo, telefonoPrincipal: s.telefonoPrincipal, telefonoAlt: s.telefonoAlt, email: s.email, contactoAlt: s.contactoAlt, actividad: s.actividad, activo: s.activo },
      create: { noSuplidor: s.noSuplidor, razonSocial: s.razonSocial, nombreComercial: s.nombreComercial, rnc: s.rnc, direccion: s.direccion, sector: s.sector, provincia: s.provincia, latitud: s.latitud, longitud: s.longitud, nombreContacto: s.nombreContacto, cedula: s.cedula, cargo: s.cargo, telefonoPrincipal: s.telefonoPrincipal, telefonoAlt: s.telefonoAlt, email: s.email, contactoAlt: s.contactoAlt, actividad: s.actividad, activo: s.activo },
    });
  }
  log('Suplidor', rows.length);
}

// ─── 6. Planes ────────────────────────────────────────────────────────────────
async function migratePlanes() {
  const rows = await src.plan.findMany({ include: { plantillaEquipos: true } });
  for (const p of rows) {
    await dst.plan.upsert({
      where:  { id: p.id },
      update: { nombre: p.nombre, tipo: p.tipo, precioMensualBase: p.precioMensualBase, precioInstalBase: p.precioInstalBase, activo: p.activo },
      create: { id: p.id, nombre: p.nombre, tipo: p.tipo, precioMensualBase: p.precioMensualBase, precioInstalBase: p.precioInstalBase, activo: p.activo },
    });
    for (const pe of p.plantillaEquipos) {
      const newProdId = prodMap.get(pe.productoId);
      if (!newProdId) continue;
      await dst.plantillaEquipo.upsert({
        where:  { planId_productoId: { planId: p.id, productoId: newProdId } },
        update: { cantidad: pe.cantidad },
        create: { planId: p.id, productoId: newProdId, cantidad: pe.cantidad },
      });
    }
  }
  log('Plan + PlantillaEquipo', rows.length);
}

// ─── 7. Clientes ──────────────────────────────────────────────────────────────
async function migrateClientes() {
  const rows = await src.cliente.findMany();
  for (const c of rows) {
    await dst.cliente.upsert({
      where:  { noCliente: c.noCliente },
      update: { razonSocial: c.razonSocial, nombreComercial: c.nombreComercial, rnc: c.rnc, tipoEmpresa: c.tipoEmpresa, fechaInicio: c.fechaInicio, nombreContacto: c.nombreContacto, apellidoContacto: c.apellidoContacto, cedula: c.cedula, cargo: c.cargo, direccion: c.direccion, sector: c.sector, provincia: c.provincia, latitud: c.latitud, longitud: c.longitud, telefonoPrincipal: c.telefonoPrincipal, telefonoAlternativo: c.telefonoAlternativo, email: c.email, website: c.website, tipoCliente: c.tipoCliente, itbis: c.itbis, activo: c.activo, deletedAt: c.deletedAt, limiteCredito: c.limiteCredito, diasCredito: c.diasCredito, tipoNcf: c.tipoNcf },
      create: { id: c.id, noCliente: c.noCliente, razonSocial: c.razonSocial, nombreComercial: c.nombreComercial, rnc: c.rnc, tipoEmpresa: c.tipoEmpresa, fechaInicio: c.fechaInicio, nombreContacto: c.nombreContacto, apellidoContacto: c.apellidoContacto, cedula: c.cedula, cargo: c.cargo, direccion: c.direccion, sector: c.sector, provincia: c.provincia, latitud: c.latitud, longitud: c.longitud, telefonoPrincipal: c.telefonoPrincipal, telefonoAlternativo: c.telefonoAlternativo, email: c.email, website: c.website, tipoCliente: c.tipoCliente, itbis: c.itbis, activo: c.activo, deletedAt: c.deletedAt, limiteCredito: c.limiteCredito, diasCredito: c.diasCredito, tipoNcf: c.tipoNcf },
    });
  }
  log('Cliente', rows.length);
}

// ─── 8. Prospectos ────────────────────────────────────────────────────────────
async function migrateProspectos() {
  const rows = await src.prospecto.findMany();
  for (const p of rows) {
    await dst.prospecto.upsert({
      where:  { id: p.id },
      update: { nombre: p.nombre, telefono: p.telefono, servicioInteresado: p.servicioInteresado, origen: p.origen, notas: p.notas, latitud: p.latitud, longitud: p.longitud, estado: p.estado },
      create: { id: p.id, nombre: p.nombre, telefono: p.telefono, servicioInteresado: p.servicioInteresado, origen: p.origen, notas: p.notas, latitud: p.latitud, longitud: p.longitud, estado: p.estado },
    });
  }
  log('Prospecto', rows.length);
}

// ─── 9. ConfiguracionNCF ──────────────────────────────────────────────────────
async function migrateNCF() {
  const rows = await src.configuracionNCF.findMany();
  for (const n of rows) {
    await dst.configuracionNCF.upsert({
      where:  { tipoNcf: n.tipoNcf },
      update: { prefijo: n.prefijo, tipoDescripcion: n.tipoDescripcion, secuenciaActual: n.secuenciaActual, limite: n.limite, vencimiento: n.vencimiento, activo: n.activo },
      create: { prefijo: n.prefijo, tipoNcf: n.tipoNcf, tipoDescripcion: n.tipoDescripcion, secuenciaActual: n.secuenciaActual, limite: n.limite, vencimiento: n.vencimiento, activo: n.activo },
    });
  }
  log('ConfiguracionNCF', rows.length);
}

// ─── 10. ItemCatalogo ─────────────────────────────────────────────────────────
async function migrateItemCatalogos() {
  const rows = await src.itemCatalogo.findMany();
  for (const i of rows) {
    await dst.itemCatalogo.upsert({
      where:  { id: i.id },
      update: { nombre: i.nombre, descripcion: i.descripcion, tipo: i.tipo, categoria: i.categoria, precio: i.precio, costo: i.costo, stock: i.stock, activo: i.activo },
      create: { id: i.id, nombre: i.nombre, descripcion: i.descripcion, tipo: i.tipo, categoria: i.categoria, precio: i.precio, costo: i.costo, stock: i.stock, activo: i.activo },
    });
  }
  log('ItemCatalogo', rows.length);
}

// ─── 11. Servicios ────────────────────────────────────────────────────────────
async function migrateServicios() {
  const rows = await src.servicio.findMany();
  for (const s of rows) {
    await dst.servicio.upsert({
      where:  { id: s.id },
      update: { estado: s.estado, precioMensual: s.precioMensual, precioInstalacion: s.precioInstalacion, notasTecnicas: s.notasTecnicas, direccionInstalacion: s.direccionInstalacion, latitud: s.latitud, longitud: s.longitud },
      create: { id: s.id, clienteId: s.clienteId, planId: s.planId, estado: s.estado, precioMensual: s.precioMensual, precioInstalacion: s.precioInstalacion, notasTecnicas: s.notasTecnicas, direccionInstalacion: s.direccionInstalacion, latitud: s.latitud, longitud: s.longitud },
    });
  }
  log('Servicio', rows.length);
}

// ─── 12. Ordenes de Instalacion ───────────────────────────────────────────────
async function migrateOrdenesInstalacion() {
  const rows = await src.ordenInstalacion.findMany({ include: { detalles: true } });
  for (const o of rows) {
    const newTecnicoId = empMap.get(o.tecnicoId);
    if (!newTecnicoId) { console.warn(`  [OrdenInstalacion] ${o.id} skipped — tecnico id=${o.tecnicoId} not mapped`); continue; }
    await dst.ordenInstalacion.upsert({
      where:  { id: o.id },
      update: { tipo: o.tipo, estado: o.estado, notas: o.notas, diagnostico: o.diagnostico, solucion: o.solucion, garantiaDias: o.garantiaDias, completadaEn: o.completadaEn, tecnicoId: newTecnicoId },
      create: { id: o.id, servicioId: o.servicioId, tipo: o.tipo, estado: o.estado, tecnicoId: newTecnicoId, notas: o.notas, diagnostico: o.diagnostico, solucion: o.solucion, garantiaDias: o.garantiaDias, completadaEn: o.completadaEn },
    });
    for (const d of o.detalles) {
      const newProdId = prodMap.get(d.productoId);
      if (!newProdId) continue;
      await dst.detalleOrden.upsert({
        where:  { ordenId_productoId: { ordenId: o.id, productoId: newProdId } },
        update: { cantidad: d.cantidad },
        create: { ordenId: o.id, productoId: newProdId, cantidad: d.cantidad },
      });
    }
  }
  log('OrdenInstalacion + Detalles', rows.length);
}

// ─── 13. Ordenes de Trabajo ───────────────────────────────────────────────────
async function migrateOrdenesTrabajo() {
  const rows = await src.ordenTrabajo.findMany({ include: { lineas: true } });
  for (const o of rows) {
    const newTecnicoId = o.tecnicoId ? empMap.get(o.tecnicoId) ?? null : null;
    await dst.ordenTrabajo.upsert({
      where:  { id: o.id },
      update: { tipoOT: o.tipoOT, estado: o.estado, notasTecnicas: o.notasTecnicas, metadatos: o.metadatos, latitud: o.latitud, longitud: o.longitud, macAddress: o.macAddress, ipAsignada: o.ipAsignada, diaCorte: o.diaCorte, garantiaDias: o.garantiaDias, completadaEn: o.completadaEn, estaFacturada: o.estaFacturada, tecnicoId: newTecnicoId },
      create: { id: o.id, clienteId: o.clienteId, tecnicoId: newTecnicoId, tipoOT: o.tipoOT, estado: o.estado, notasTecnicas: o.notasTecnicas, metadatos: o.metadatos, latitud: o.latitud, longitud: o.longitud, macAddress: o.macAddress, ipAsignada: o.ipAsignada, diaCorte: o.diaCorte, garantiaDias: o.garantiaDias, completadaEn: o.completadaEn, estaFacturada: o.estaFacturada },
    });
    for (const l of o.lineas) {
      const newProdId = l.productoId ? prodMap.get(l.productoId) ?? null : null;
      await dst.lineaOrdenTrabajo.upsert({
        where:  { id: l.id },
        update: { itemCatalogoId: l.itemCatalogoId, productoId: newProdId, descripcion: l.descripcion, cantidad: l.cantidad, precioUnitario: l.precioUnitario },
        create: { id: l.id, ordenId: o.id, itemCatalogoId: l.itemCatalogoId, productoId: newProdId, descripcion: l.descripcion, cantidad: l.cantidad, precioUnitario: l.precioUnitario },
      });
    }
  }
  log('OrdenTrabajo + Lineas', rows.length);
}

// ─── 14. Facturas ─────────────────────────────────────────────────────────────
async function migrateFacturas() {
  const rows = await src.factura.findMany();
  for (const f of rows) {
    await dst.factura.upsert({
      where:  { noFactura: f.noFactura },
      update: { estado: f.estado, subtotal: f.subtotal, itbis: f.itbis, total: f.total, ncf: f.ncf, tipoNcf: f.tipoNcf, fechaEmision: f.fechaEmision, fechaVence: f.fechaVence, fechaPago: f.fechaPago, notas: f.notas },
      create: { id: f.id, noFactura: f.noFactura, clienteId: f.clienteId, ordenId: f.ordenId, estado: f.estado, subtotal: f.subtotal, itbis: f.itbis, total: f.total, ncf: f.ncf, tipoNcf: f.tipoNcf, fechaEmision: f.fechaEmision, fechaVence: f.fechaVence, fechaPago: f.fechaPago, notas: f.notas },
    });
  }
  log('Factura', rows.length);
}

// ─── 15. Asistencias ──────────────────────────────────────────────────────────
async function migrateAsistencias() {
  const rows = await src.asistencia.findMany();
  let migrated = 0;
  for (const a of rows) {
    const newEmpId = empMap.get(a.empleadoId);
    if (!newEmpId) continue;
    // No unique key other than id — use create with id preserved to avoid duplicates
    const exists = await dst.asistencia.findUnique({ where: { id: a.id } });
    if (!exists) {
      await dst.asistencia.create({ data: { id: a.id, empleadoId: newEmpId, fechaHora: a.fechaHora, tipo: a.tipo } });
    }
    migrated++;
  }
  log('Asistencia', migrated);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n[MIGRATE] Connecting to both databases...');
  await src.$connect();
  await dst.$connect();
  console.log('[MIGRATE] Both databases connected.\n');

  console.log('[MIGRATE] Starting migration in dependency order:\n');

  await migrateRoles();
  await migrateEmpleados();
  await migrateCategorias();
  await migrateProductos();
  await migrateSuplidores();
  await migratePlanes();
  await migrateClientes();
  await migrateProspectos();
  await migrateNCF();
  await migrateItemCatalogos();
  await migrateServicios();
  await migrateOrdenesInstalacion();
  await migrateOrdenesTrabajo();
  await migrateFacturas();
  await migrateAsistencias();

  console.log('\n[MIGRATE] Done. All records migrated successfully.');
  console.log('[MIGRATE] ID maps built:');
  console.log(`  Roles:     ${rolMap.size}`);
  console.log(`  Empleados: ${empMap.size}`);
  console.log(`  Categorias:${catMap.size}`);
  console.log(`  Productos: ${prodMap.size}`);
}

main()
  .catch(err => {
    console.error('\n[MIGRATE] FATAL:', err.message);
    console.error(err.stack);
    process.exit(1);
  })
  .finally(async () => {
    await src.$disconnect();
    await dst.$disconnect();
  });
