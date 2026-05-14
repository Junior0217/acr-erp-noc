/**
 * Migration MSP: TicketTaller + CredencialCliente + ActivoCliente + EquipoPrestamo
 * + Producto.esCanibalizado + OT SLA fields
 * Bypasses direct connection (port 5432 blocked) — runs DDL via pooler.
 */
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()

const STEPS = [
  // 1. Enums
  `DO $$ BEGIN
     CREATE TYPE "EstadoTicketTaller" AS ENUM ('Recibido','Diagnostico','EsperandoPieza','Listo','Entregado','Cancelado');
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
     CREATE TYPE "TipoCredencial" AS ENUM ('Router','Switch','AccessPoint','NVR','DVR','Camara','Server','Firewall','ControlAcceso','Otro');
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,

  // 2. Producto.esCanibalizado
  `ALTER TABLE "Producto" ADD COLUMN IF NOT EXISTS "esCanibalizado" BOOLEAN NOT NULL DEFAULT false`,
  `CREATE INDEX IF NOT EXISTS "Producto_esCanibalizado_idx" ON "Producto"("esCanibalizado")`,

  // 3. OrdenTrabajo SLA fields
  `ALTER TABLE "OrdenTrabajo" ADD COLUMN IF NOT EXISTS "fotosRequeridas"      INTEGER  NOT NULL DEFAULT 0`,
  `ALTER TABLE "OrdenTrabajo" ADD COLUMN IF NOT EXISTS "limpiezaRealizada"    BOOLEAN  NOT NULL DEFAULT false`,
  `ALTER TABLE "OrdenTrabajo" ADD COLUMN IF NOT EXISTS "fechaVencimientoSLA"  TIMESTAMPTZ`,
  `CREATE INDEX IF NOT EXISTS "OrdenTrabajo_fechaVencimientoSLA_idx" ON "OrdenTrabajo"("fechaVencimientoSLA")`,

  // 4. TicketTaller
  `CREATE TABLE IF NOT EXISTS "TicketTaller" (
     "id"              TEXT NOT NULL,
     "noTicket"        TEXT NOT NULL,
     "codigoPin"       TEXT NOT NULL,
     "clienteId"       TEXT NOT NULL,
     "tecnicoId"       INTEGER,
     "equipo"          TEXT NOT NULL,
     "marca"           TEXT,
     "modelo"          TEXT,
     "numeroSerie"     TEXT,
     "falla"           TEXT NOT NULL,
     "estado"          "EstadoTicketTaller" NOT NULL DEFAULT 'Recibido',
     "notas"           TEXT,
     "diagnostico"     TEXT,
     "costoEstimado"   DECIMAL(12,2),
     "recibidoEn"      TIMESTAMPTZ NOT NULL DEFAULT now(),
     "diagnosticadoEn" TIMESTAMPTZ,
     "listoEn"         TIMESTAMPTZ,
     "entregadoEn"     TIMESTAMPTZ,
     "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT now(),
     "updatedAt"       TIMESTAMPTZ NOT NULL DEFAULT now(),
     CONSTRAINT "TicketTaller_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "TicketTaller_noTicket_key"  ON "TicketTaller"("noTicket")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "TicketTaller_codigoPin_key" ON "TicketTaller"("codigoPin")`,
  `CREATE INDEX        IF NOT EXISTS "TicketTaller_clienteId_idx" ON "TicketTaller"("clienteId")`,
  `CREATE INDEX        IF NOT EXISTS "TicketTaller_tecnicoId_idx" ON "TicketTaller"("tecnicoId")`,
  `CREATE INDEX        IF NOT EXISTS "TicketTaller_estado_idx"    ON "TicketTaller"("estado")`,
  `DO $$ BEGIN
     ALTER TABLE "TicketTaller" ADD CONSTRAINT "TicketTaller_clienteId_fkey"
       FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
     ALTER TABLE "TicketTaller" ADD CONSTRAINT "TicketTaller_tecnicoId_fkey"
       FOREIGN KEY ("tecnicoId") REFERENCES "Empleado"("id") ON DELETE SET NULL ON UPDATE CASCADE;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,

  // 5. CredencialCliente
  `CREATE TABLE IF NOT EXISTS "CredencialCliente" (
     "id"           TEXT NOT NULL,
     "clienteId"    TEXT NOT NULL,
     "tipo"         "TipoCredencial" NOT NULL,
     "nombre"       TEXT NOT NULL,
     "ip"           TEXT,
     "usuario"      TEXT NOT NULL,
     "passwordEnc"  TEXT NOT NULL,
     "passwordIv"   TEXT NOT NULL,
     "notas"        TEXT,
     "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
     "updatedAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
     CONSTRAINT "CredencialCliente_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE INDEX IF NOT EXISTS "CredencialCliente_clienteId_idx" ON "CredencialCliente"("clienteId")`,
  `CREATE INDEX IF NOT EXISTS "CredencialCliente_tipo_idx"      ON "CredencialCliente"("tipo")`,
  `DO $$ BEGIN
     ALTER TABLE "CredencialCliente" ADD CONSTRAINT "CredencialCliente_clienteId_fkey"
       FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE CASCADE ON UPDATE CASCADE;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,

  // 6. ActivoCliente
  `CREATE TABLE IF NOT EXISTS "ActivoCliente" (
     "id"               TEXT NOT NULL,
     "clienteId"        TEXT NOT NULL,
     "productoId"       INTEGER NOT NULL,
     "ordenTrabajoId"   TEXT,
     "cantidad"         INTEGER NOT NULL DEFAULT 1,
     "fechaInstalacion" TIMESTAMPTZ NOT NULL DEFAULT now(),
     "finGarantia"      TIMESTAMPTZ,
     "numeroSerie"      TEXT,
     "ubicacion"        TEXT,
     "notas"            TEXT,
     "createdAt"        TIMESTAMPTZ NOT NULL DEFAULT now(),
     "updatedAt"        TIMESTAMPTZ NOT NULL DEFAULT now(),
     CONSTRAINT "ActivoCliente_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE INDEX IF NOT EXISTS "ActivoCliente_clienteId_idx"      ON "ActivoCliente"("clienteId")`,
  `CREATE INDEX IF NOT EXISTS "ActivoCliente_productoId_idx"     ON "ActivoCliente"("productoId")`,
  `CREATE INDEX IF NOT EXISTS "ActivoCliente_ordenTrabajoId_idx" ON "ActivoCliente"("ordenTrabajoId")`,
  `CREATE INDEX IF NOT EXISTS "ActivoCliente_finGarantia_idx"    ON "ActivoCliente"("finGarantia")`,
  `DO $$ BEGIN
     ALTER TABLE "ActivoCliente" ADD CONSTRAINT "ActivoCliente_clienteId_fkey"
       FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE CASCADE ON UPDATE CASCADE;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
     ALTER TABLE "ActivoCliente" ADD CONSTRAINT "ActivoCliente_productoId_fkey"
       FOREIGN KEY ("productoId") REFERENCES "Producto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
     ALTER TABLE "ActivoCliente" ADD CONSTRAINT "ActivoCliente_ordenTrabajoId_fkey"
       FOREIGN KEY ("ordenTrabajoId") REFERENCES "OrdenTrabajo"("id") ON DELETE SET NULL ON UPDATE CASCADE;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,

  // 7. EquipoPrestamo
  `CREATE TABLE IF NOT EXISTS "EquipoPrestamo" (
     "id"                  TEXT NOT NULL,
     "clienteId"           TEXT NOT NULL,
     "productoId"          INTEGER NOT NULL,
     "cantidad"            INTEGER NOT NULL DEFAULT 1,
     "fechaPrestamo"       TIMESTAMPTZ NOT NULL DEFAULT now(),
     "fechaLimite"         TIMESTAMPTZ NOT NULL,
     "fechaDevolucion"     TIMESTAMPTZ,
     "movimientoSalidaId"  INTEGER,
     "movimientoEntradaId" INTEGER,
     "notas"               TEXT,
     "createdAt"           TIMESTAMPTZ NOT NULL DEFAULT now(),
     "updatedAt"           TIMESTAMPTZ NOT NULL DEFAULT now(),
     CONSTRAINT "EquipoPrestamo_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "EquipoPrestamo_movimientoSalidaId_key"  ON "EquipoPrestamo"("movimientoSalidaId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "EquipoPrestamo_movimientoEntradaId_key" ON "EquipoPrestamo"("movimientoEntradaId")`,
  `CREATE INDEX        IF NOT EXISTS "EquipoPrestamo_clienteId_idx"        ON "EquipoPrestamo"("clienteId")`,
  `CREATE INDEX        IF NOT EXISTS "EquipoPrestamo_productoId_idx"       ON "EquipoPrestamo"("productoId")`,
  `CREATE INDEX        IF NOT EXISTS "EquipoPrestamo_fechaLimite_idx"      ON "EquipoPrestamo"("fechaLimite")`,
  `CREATE INDEX        IF NOT EXISTS "EquipoPrestamo_fechaDevolucion_idx"  ON "EquipoPrestamo"("fechaDevolucion")`,
  `DO $$ BEGIN
     ALTER TABLE "EquipoPrestamo" ADD CONSTRAINT "EquipoPrestamo_clienteId_fkey"
       FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
     ALTER TABLE "EquipoPrestamo" ADD CONSTRAINT "EquipoPrestamo_productoId_fkey"
       FOREIGN KEY ("productoId") REFERENCES "Producto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
     ALTER TABLE "EquipoPrestamo" ADD CONSTRAINT "EquipoPrestamo_movimientoSalidaId_fkey"
       FOREIGN KEY ("movimientoSalidaId") REFERENCES "MovimientoInventario"("id") ON DELETE SET NULL ON UPDATE CASCADE;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
     ALTER TABLE "EquipoPrestamo" ADD CONSTRAINT "EquipoPrestamo_movimientoEntradaId_fkey"
       FOREIGN KEY ("movimientoEntradaId") REFERENCES "MovimientoInventario"("id") ON DELETE SET NULL ON UPDATE CASCADE;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
]

;(async () => {
  let ok = 0, fail = 0
  for (let i = 0; i < STEPS.length; i++) {
    try {
      await p.$executeRawUnsafe(STEPS[i])
      console.log(`[OK]  step ${i + 1}/${STEPS.length}`)
      ok++
    } catch (e) {
      console.error(`[ERR] step ${i + 1}/${STEPS.length}: ${e.message}`)
      fail++
    }
  }
  console.log(`\nDone. OK=${ok}  FAIL=${fail}`)
  await p.$disconnect()
  process.exit(fail > 0 ? 1 : 0)
})()
