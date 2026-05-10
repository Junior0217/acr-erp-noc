-- CreateEnum
CREATE TYPE "TipoAsistencia" AS ENUM ('Entrada', 'Salida');

-- CreateEnum
CREATE TYPE "TipoMovimiento" AS ENUM ('Entrada', 'Salida');

-- CreateEnum
CREATE TYPE "TipoServicio" AS ENUM ('WISP', 'CCTV', 'Redes', 'CercosElectricos', 'VentaEquipos', 'Mixto');

-- CreateEnum
CREATE TYPE "EstadoServicio" AS ENUM ('Pendiente', 'EnInstalacion', 'Activo', 'Suspendido', 'Cancelado');

-- CreateEnum
CREATE TYPE "TipoOrden" AS ENUM ('Instalacion', 'Retiro');

-- CreateTable
CREATE TABLE "Empleado" (
    "id" SERIAL NOT NULL,
    "nombre" TEXT NOT NULL,
    "cargo" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Empleado_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asistencia" (
    "id" SERIAL NOT NULL,
    "empleadoId" INTEGER NOT NULL,
    "fechaHora" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tipo" "TipoAsistencia" NOT NULL,

    CONSTRAINT "Asistencia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Categoria" (
    "id" SERIAL NOT NULL,
    "nombre" TEXT NOT NULL,

    CONSTRAINT "Categoria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Producto" (
    "id" SERIAL NOT NULL,
    "sku" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "precio" DECIMAL(12,2) NOT NULL,
    "stockActual" INTEGER NOT NULL DEFAULT 0,
    "categoriaId" INTEGER NOT NULL,

    CONSTRAINT "Producto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MovimientoInventario" (
    "id" SERIAL NOT NULL,
    "productoId" INTEGER NOT NULL,
    "tipo" "TipoMovimiento" NOT NULL,
    "cantidad" INTEGER NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ordenInstalacionId" TEXT,

    CONSTRAINT "MovimientoInventario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "tipo" "TipoServicio" NOT NULL,
    "precioMensualBase" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "precioInstalBase" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlantillaEquipo" (
    "id" SERIAL NOT NULL,
    "planId" TEXT NOT NULL,
    "productoId" INTEGER NOT NULL,
    "cantidad" INTEGER NOT NULL,

    CONSTRAINT "PlantillaEquipo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cliente" (
    "id" TEXT NOT NULL,
    "noCliente" TEXT NOT NULL,
    "razonSocial" TEXT NOT NULL,
    "nombreComercial" TEXT,
    "rnc" TEXT,
    "registroMercantil" TEXT,
    "tipoEmpresa" TEXT NOT NULL,
    "fechaInicio" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nombreContacto" TEXT NOT NULL,
    "apellidoContacto" TEXT,
    "cedula" TEXT,
    "cargo" TEXT,
    "direccion" TEXT NOT NULL,
    "sector" TEXT NOT NULL,
    "provincia" TEXT NOT NULL,
    "latitud" TEXT,
    "longitud" TEXT,
    "telefonoPrincipal" TEXT NOT NULL,
    "telefonoAlternativo" TEXT,
    "email" TEXT NOT NULL,
    "website" TEXT,
    "tipoCliente" TEXT NOT NULL,
    "itbis" BOOLEAN NOT NULL DEFAULT true,
    "promHorasMes" INTEGER,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "fechaInactivo" TIMESTAMP(3),
    "limiteCredito" DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    "diasCredito" INTEGER NOT NULL DEFAULT 0,
    "tipoNcf" TEXT NOT NULL DEFAULT 'Consumidor Final',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cliente_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Servicio" (
    "id" TEXT NOT NULL,
    "clienteId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "estado" "EstadoServicio" NOT NULL DEFAULT 'Pendiente',
    "precioMensual" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "precioInstalacion" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "direccionInstalacion" TEXT,
    "latitud" TEXT,
    "longitud" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Servicio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrdenInstalacion" (
    "id" TEXT NOT NULL,
    "servicioId" TEXT NOT NULL,
    "tipo" "TipoOrden" NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'Pendiente',
    "tecnicoId" INTEGER NOT NULL,
    "notas" TEXT,
    "completadaEn" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrdenInstalacion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DetalleOrden" (
    "id" SERIAL NOT NULL,
    "ordenId" TEXT NOT NULL,
    "productoId" INTEGER NOT NULL,
    "cantidad" INTEGER NOT NULL,

    CONSTRAINT "DetalleOrden_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Suplidor" (
    "id" TEXT NOT NULL,
    "noSuplidor" TEXT NOT NULL,
    "razonSocial" TEXT NOT NULL,
    "nombreComercial" TEXT,
    "rnc" TEXT,
    "direccion" TEXT NOT NULL,
    "sector" TEXT NOT NULL,
    "provincia" TEXT NOT NULL,
    "latitud" TEXT,
    "longitud" TEXT,
    "nombreContacto" TEXT NOT NULL,
    "cedula" TEXT,
    "cargo" TEXT,
    "telefonoPrincipal" TEXT NOT NULL,
    "telefonoAlt" TEXT,
    "email" TEXT,
    "contactoAlt" TEXT,
    "actividad" TEXT NOT NULL,
    "camposUsuario" TEXT,
    "fechaInicio" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "fechaInactivo" TIMESTAMP(3),
    "limiteCredito" DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    "diasCredito" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Suplidor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Prospecto" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "telefono" TEXT NOT NULL,
    "servicioInteresado" TEXT NOT NULL,
    "origen" TEXT NOT NULL DEFAULT 'WhatsApp',
    "notas" TEXT,
    "latitud" TEXT,
    "longitud" TEXT,
    "estado" TEXT NOT NULL DEFAULT 'Nuevo',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Prospecto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Empleado_email_key" ON "Empleado"("email");

-- CreateIndex
CREATE INDEX "Asistencia_empleadoId_idx" ON "Asistencia"("empleadoId");

-- CreateIndex
CREATE UNIQUE INDEX "Categoria_nombre_key" ON "Categoria"("nombre");

-- CreateIndex
CREATE UNIQUE INDEX "Producto_sku_key" ON "Producto"("sku");

-- CreateIndex
CREATE INDEX "Producto_categoriaId_idx" ON "Producto"("categoriaId");

-- CreateIndex
CREATE INDEX "MovimientoInventario_productoId_idx" ON "MovimientoInventario"("productoId");

-- CreateIndex
CREATE INDEX "MovimientoInventario_ordenInstalacionId_idx" ON "MovimientoInventario"("ordenInstalacionId");

-- CreateIndex
CREATE INDEX "Plan_tipo_idx" ON "Plan"("tipo");

-- CreateIndex
CREATE INDEX "Plan_activo_idx" ON "Plan"("activo");

-- CreateIndex
CREATE INDEX "PlantillaEquipo_planId_idx" ON "PlantillaEquipo"("planId");

-- CreateIndex
CREATE UNIQUE INDEX "PlantillaEquipo_planId_productoId_key" ON "PlantillaEquipo"("planId", "productoId");

-- CreateIndex
CREATE UNIQUE INDEX "Cliente_noCliente_key" ON "Cliente"("noCliente");

-- CreateIndex
CREATE UNIQUE INDEX "Cliente_rnc_key" ON "Cliente"("rnc");

-- CreateIndex
CREATE INDEX "Cliente_rnc_idx" ON "Cliente"("rnc");

-- CreateIndex
CREATE INDEX "Cliente_activo_idx" ON "Cliente"("activo");

-- CreateIndex
CREATE INDEX "Servicio_clienteId_idx" ON "Servicio"("clienteId");

-- CreateIndex
CREATE INDEX "Servicio_planId_idx" ON "Servicio"("planId");

-- CreateIndex
CREATE INDEX "Servicio_estado_idx" ON "Servicio"("estado");

-- CreateIndex
CREATE INDEX "OrdenInstalacion_servicioId_idx" ON "OrdenInstalacion"("servicioId");

-- CreateIndex
CREATE INDEX "OrdenInstalacion_tecnicoId_idx" ON "OrdenInstalacion"("tecnicoId");

-- CreateIndex
CREATE INDEX "OrdenInstalacion_estado_idx" ON "OrdenInstalacion"("estado");

-- CreateIndex
CREATE INDEX "DetalleOrden_ordenId_idx" ON "DetalleOrden"("ordenId");

-- CreateIndex
CREATE UNIQUE INDEX "DetalleOrden_ordenId_productoId_key" ON "DetalleOrden"("ordenId", "productoId");

-- CreateIndex
CREATE UNIQUE INDEX "Suplidor_noSuplidor_key" ON "Suplidor"("noSuplidor");

-- CreateIndex
CREATE UNIQUE INDEX "Suplidor_rnc_key" ON "Suplidor"("rnc");

-- CreateIndex
CREATE INDEX "Suplidor_rnc_idx" ON "Suplidor"("rnc");

-- CreateIndex
CREATE INDEX "Suplidor_activo_idx" ON "Suplidor"("activo");

-- CreateIndex
CREATE INDEX "Prospecto_estado_idx" ON "Prospecto"("estado");

-- AddForeignKey
ALTER TABLE "Asistencia" ADD CONSTRAINT "Asistencia_empleadoId_fkey" FOREIGN KEY ("empleadoId") REFERENCES "Empleado"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Producto" ADD CONSTRAINT "Producto_categoriaId_fkey" FOREIGN KEY ("categoriaId") REFERENCES "Categoria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MovimientoInventario" ADD CONSTRAINT "MovimientoInventario_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "Producto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MovimientoInventario" ADD CONSTRAINT "MovimientoInventario_ordenInstalacionId_fkey" FOREIGN KEY ("ordenInstalacionId") REFERENCES "OrdenInstalacion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlantillaEquipo" ADD CONSTRAINT "PlantillaEquipo_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlantillaEquipo" ADD CONSTRAINT "PlantillaEquipo_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "Producto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Servicio" ADD CONSTRAINT "Servicio_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Servicio" ADD CONSTRAINT "Servicio_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrdenInstalacion" ADD CONSTRAINT "OrdenInstalacion_servicioId_fkey" FOREIGN KEY ("servicioId") REFERENCES "Servicio"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrdenInstalacion" ADD CONSTRAINT "OrdenInstalacion_tecnicoId_fkey" FOREIGN KEY ("tecnicoId") REFERENCES "Empleado"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DetalleOrden" ADD CONSTRAINT "DetalleOrden_ordenId_fkey" FOREIGN KEY ("ordenId") REFERENCES "OrdenInstalacion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DetalleOrden" ADD CONSTRAINT "DetalleOrden_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "Producto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
