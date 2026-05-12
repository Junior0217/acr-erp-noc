-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "TipoAsistencia" AS ENUM ('Entrada', 'Salida');

-- CreateEnum
CREATE TYPE "TipoMovimiento" AS ENUM ('Entrada', 'Salida');

-- CreateEnum
CREATE TYPE "TipoServicio" AS ENUM ('WISP', 'CCTV', 'Redes', 'CercoElectrico', 'VentaDirecta', 'Mixto', 'SoporteTecnico', 'Reparacion', 'ProyectoCCTV');

-- CreateEnum
CREATE TYPE "EstadoServicio" AS ENUM ('Pendiente', 'EnInstalacion', 'Activo', 'Suspendido', 'Cancelado');

-- CreateEnum
CREATE TYPE "TipoOrden" AS ENUM ('Instalacion', 'Retiro', 'ServicioTecnico', 'Mantenimiento');

-- CreateEnum
CREATE TYPE "TipoFacturacion" AS ENUM ('Recurrente', 'VentaUnica', 'Servicio');

-- CreateEnum
CREATE TYPE "EstadoFactura" AS ENUM ('Borrador', 'Emitida', 'Pagada', 'Vencida', 'Anulada');

-- CreateEnum
CREATE TYPE "TipoItem" AS ENUM ('ARTICULO', 'SERVICIO');

-- CreateTable
CREATE TABLE "Rol" (
    "id" SERIAL NOT NULL,
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT,
    "permisos" JSONB NOT NULL DEFAULT '[]',
    "nivel" INTEGER NOT NULL DEFAULT 0,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "require2FA" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Rol_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Empleado" (
    "id" SERIAL NOT NULL,
    "nombre" TEXT NOT NULL,
    "cargo" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL DEFAULT '',
    "bloqueado" BOOLEAN NOT NULL DEFAULT false,
    "permisosExtra" JSONB NOT NULL DEFAULT '[]',
    "twoFactorSecret" TEXT,
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Empleado_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionToken" (
    "id" TEXT NOT NULL,
    "jti" TEXT NOT NULL,
    "empleadoId" INTEGER NOT NULL,
    "userAgent" TEXT NOT NULL DEFAULT '',
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SessionToken_pkey" PRIMARY KEY ("id")
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
    "tipoItem" "TipoItem" NOT NULL DEFAULT 'ARTICULO',

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
    "deletedAt" TIMESTAMP(3),
    "limiteCredito" DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    "diasCredito" INTEGER NOT NULL DEFAULT 0,
    "tipoNcf" TEXT NOT NULL DEFAULT 'Consumidor Final',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "passwordHash" TEXT DEFAULT '',

    CONSTRAINT "Cliente_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortalSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "mostrarEquipos" BOOLEAN NOT NULL DEFAULT false,
    "permitirPagos" BOOLEAN NOT NULL DEFAULT false,
    "mostrarMapa" BOOLEAN NOT NULL DEFAULT true,
    "mostrarCotizador" BOOLEAN NOT NULL DEFAULT true,
    "mostrarServicios" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PortalSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Servicio" (
    "id" TEXT NOT NULL,
    "clienteId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "estado" "EstadoServicio" NOT NULL DEFAULT 'Pendiente',
    "precioMensual" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "precioInstalacion" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "notasTecnicas" TEXT,
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
    "diagnostico" TEXT,
    "solucion" TEXT,
    "garantiaDias" INTEGER,
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
CREATE TABLE "AuditLog" (
    "id" SERIAL NOT NULL,
    "evento" TEXT NOT NULL,
    "usuarioId" INTEGER,
    "userName" TEXT,
    "ip" TEXT,
    "ua" TEXT,
    "meta" JSONB,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
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

-- CreateTable
CREATE TABLE "ItemCatalogo" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT,
    "tipo" "TipoFacturacion" NOT NULL,
    "categoria" "TipoServicio" NOT NULL,
    "precio" DECIMAL(12,2) NOT NULL,
    "costo" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "stock" INTEGER,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "tipoItem" "TipoItem" NOT NULL DEFAULT 'SERVICIO',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ItemCatalogo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrdenTrabajo" (
    "id" TEXT NOT NULL,
    "clienteId" TEXT NOT NULL,
    "tecnicoId" INTEGER,
    "tipoOT" TEXT NOT NULL DEFAULT 'General',
    "estado" TEXT NOT NULL DEFAULT 'Pendiente',
    "notasTecnicas" TEXT,
    "metadatos" JSONB NOT NULL DEFAULT '{}',
    "latitud" TEXT,
    "longitud" TEXT,
    "macAddress" TEXT,
    "ipAsignada" TEXT,
    "diaCorte" INTEGER,
    "garantiaDias" INTEGER,
    "completadaEn" TIMESTAMP(3),
    "estaFacturada" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrdenTrabajo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LineaOrdenTrabajo" (
    "id" SERIAL NOT NULL,
    "ordenId" TEXT NOT NULL,
    "itemCatalogoId" TEXT,
    "productoId" INTEGER,
    "descripcion" TEXT NOT NULL,
    "cantidad" INTEGER NOT NULL DEFAULT 1,
    "precioUnitario" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "LineaOrdenTrabajo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Factura" (
    "id" TEXT NOT NULL,
    "noFactura" TEXT NOT NULL,
    "clienteId" TEXT NOT NULL,
    "ordenId" TEXT,
    "estado" "EstadoFactura" NOT NULL DEFAULT 'Borrador',
    "subtotal" DECIMAL(12,2) NOT NULL,
    "itbis" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL,
    "ncf" TEXT,
    "tipoNcf" TEXT NOT NULL DEFAULT 'Consumidor Final',
    "fechaEmision" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fechaVence" TIMESTAMP(3),
    "fechaPago" TIMESTAMP(3),
    "notas" TEXT,
    "esCotizacion" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Factura_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LineaFactura" (
    "id" SERIAL NOT NULL,
    "facturaId" TEXT NOT NULL,
    "productoId" INTEGER,
    "descripcion" TEXT NOT NULL,
    "cantidad" INTEGER NOT NULL,
    "precioUnitario" DECIMAL(12,2) NOT NULL,
    "descuentoPorcentaje" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "descuentoMonto" DECIMAL(12,2) NOT NULL DEFAULT 0,

    CONSTRAINT "LineaFactura_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConfiguracionNCF" (
    "id" SERIAL NOT NULL,
    "prefijo" TEXT NOT NULL,
    "tipoNcf" TEXT NOT NULL,
    "tipoDescripcion" TEXT NOT NULL,
    "secuenciaActual" INTEGER NOT NULL DEFAULT 0,
    "limite" INTEGER NOT NULL DEFAULT 9999999,
    "vencimiento" TIMESTAMP(3),
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConfiguracionNCF_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CarritoTemp" (
    "id" TEXT NOT NULL,
    "empleadoId" INTEGER NOT NULL,
    "clienteId" TEXT,
    "applyItbis" BOOLEAN NOT NULL DEFAULT false,
    "diasVence" INTEGER NOT NULL DEFAULT 30,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CarritoTemp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LineaCarrito" (
    "id" SERIAL NOT NULL,
    "carritoId" TEXT NOT NULL,
    "productoId" INTEGER NOT NULL,
    "cantidad" INTEGER NOT NULL DEFAULT 1,
    "precioUnitario" DECIMAL(12,2) NOT NULL,
    "descuentoPorcentaje" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "descuentoMonto" DECIMAL(12,2) NOT NULL DEFAULT 0,

    CONSTRAINT "LineaCarrito_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_EmpleadoToRol" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_EmpleadoToRol_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "Rol_nombre_key" ON "Rol"("nombre");
CREATE INDEX "Rol_activo_idx" ON "Rol"("activo");
CREATE INDEX "Rol_nombre_idx" ON "Rol"("nombre");
CREATE INDEX "Rol_nivel_idx" ON "Rol"("nivel");

-- CreateIndex
CREATE UNIQUE INDEX "Empleado_email_key" ON "Empleado"("email");
CREATE INDEX "Empleado_nombre_idx" ON "Empleado"("nombre");
CREATE INDEX "Empleado_deletedAt_idx" ON "Empleado"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SessionToken_jti_key" ON "SessionToken"("jti");
CREATE INDEX "SessionToken_empleadoId_idx" ON "SessionToken"("empleadoId");
CREATE INDEX "SessionToken_jti_idx" ON "SessionToken"("jti");

-- CreateIndex
CREATE INDEX "Asistencia_empleadoId_idx" ON "Asistencia"("empleadoId");

-- CreateIndex
CREATE UNIQUE INDEX "Categoria_nombre_key" ON "Categoria"("nombre");

-- CreateIndex
CREATE UNIQUE INDEX "Producto_sku_key" ON "Producto"("sku");
CREATE INDEX "Producto_sku_idx" ON "Producto"("sku");
CREATE INDEX "Producto_categoriaId_idx" ON "Producto"("categoriaId");
CREATE INDEX "Producto_nombre_idx" ON "Producto"("nombre");
CREATE INDEX "Producto_stockActual_idx" ON "Producto"("stockActual");
CREATE INDEX "Producto_tipoItem_idx" ON "Producto"("tipoItem");

-- CreateIndex
CREATE INDEX "MovimientoInventario_productoId_idx" ON "MovimientoInventario"("productoId");
CREATE INDEX "MovimientoInventario_ordenInstalacionId_idx" ON "MovimientoInventario"("ordenInstalacionId");
CREATE INDEX "MovimientoInventario_fecha_idx" ON "MovimientoInventario"("fecha");
CREATE INDEX "MovimientoInventario_productoId_fecha_idx" ON "MovimientoInventario"("productoId", "fecha");

-- CreateIndex
CREATE INDEX "Plan_tipo_idx" ON "Plan"("tipo");
CREATE INDEX "Plan_activo_idx" ON "Plan"("activo");
CREATE INDEX "Plan_nombre_idx" ON "Plan"("nombre");
CREATE INDEX "Plan_createdAt_idx" ON "Plan"("createdAt");

-- CreateIndex
CREATE INDEX "PlantillaEquipo_planId_idx" ON "PlantillaEquipo"("planId");
CREATE INDEX "PlantillaEquipo_productoId_idx" ON "PlantillaEquipo"("productoId");
CREATE UNIQUE INDEX "PlantillaEquipo_planId_productoId_key" ON "PlantillaEquipo"("planId", "productoId");

-- CreateIndex
CREATE UNIQUE INDEX "Cliente_noCliente_key" ON "Cliente"("noCliente");
CREATE UNIQUE INDEX "Cliente_rnc_key" ON "Cliente"("rnc");
CREATE INDEX "Cliente_noCliente_idx" ON "Cliente"("noCliente");
CREATE INDEX "Cliente_rnc_idx" ON "Cliente"("rnc");
CREATE INDEX "Cliente_activo_idx" ON "Cliente"("activo");
CREATE INDEX "Cliente_razonSocial_idx" ON "Cliente"("razonSocial");
CREATE INDEX "Cliente_createdAt_idx" ON "Cliente"("createdAt");
CREATE INDEX "Cliente_email_idx" ON "Cliente"("email");

-- CreateIndex
CREATE INDEX "Servicio_clienteId_idx" ON "Servicio"("clienteId");
CREATE INDEX "Servicio_planId_idx" ON "Servicio"("planId");
CREATE INDEX "Servicio_estado_idx" ON "Servicio"("estado");
CREATE INDEX "Servicio_createdAt_idx" ON "Servicio"("createdAt");

-- CreateIndex
CREATE INDEX "OrdenInstalacion_servicioId_idx" ON "OrdenInstalacion"("servicioId");
CREATE INDEX "OrdenInstalacion_tecnicoId_idx" ON "OrdenInstalacion"("tecnicoId");
CREATE INDEX "OrdenInstalacion_estado_idx" ON "OrdenInstalacion"("estado");
CREATE INDEX "OrdenInstalacion_createdAt_idx" ON "OrdenInstalacion"("createdAt");

-- CreateIndex
CREATE INDEX "DetalleOrden_ordenId_idx" ON "DetalleOrden"("ordenId");
CREATE INDEX "DetalleOrden_productoId_idx" ON "DetalleOrden"("productoId");
CREATE UNIQUE INDEX "DetalleOrden_ordenId_productoId_key" ON "DetalleOrden"("ordenId", "productoId");

-- CreateIndex
CREATE UNIQUE INDEX "Suplidor_noSuplidor_key" ON "Suplidor"("noSuplidor");
CREATE UNIQUE INDEX "Suplidor_rnc_key" ON "Suplidor"("rnc");
CREATE INDEX "Suplidor_rnc_idx" ON "Suplidor"("rnc");
CREATE INDEX "Suplidor_activo_idx" ON "Suplidor"("activo");

-- CreateIndex
CREATE INDEX "AuditLog_usuarioId_idx" ON "AuditLog"("usuarioId");
CREATE INDEX "AuditLog_evento_idx" ON "AuditLog"("evento");
CREATE INDEX "AuditLog_creadoEn_idx" ON "AuditLog"("creadoEn");
CREATE INDEX "AuditLog_usuarioId_creadoEn_idx" ON "AuditLog"("usuarioId", "creadoEn");

-- CreateIndex
CREATE INDEX "Prospecto_estado_idx" ON "Prospecto"("estado");

-- CreateIndex
CREATE INDEX "ItemCatalogo_tipo_idx" ON "ItemCatalogo"("tipo");
CREATE INDEX "ItemCatalogo_categoria_idx" ON "ItemCatalogo"("categoria");
CREATE INDEX "ItemCatalogo_activo_idx" ON "ItemCatalogo"("activo");
CREATE INDEX "ItemCatalogo_tipoItem_idx" ON "ItemCatalogo"("tipoItem");

-- CreateIndex
CREATE INDEX "OrdenTrabajo_clienteId_idx" ON "OrdenTrabajo"("clienteId");
CREATE INDEX "OrdenTrabajo_tecnicoId_idx" ON "OrdenTrabajo"("tecnicoId");
CREATE INDEX "OrdenTrabajo_tipoOT_idx" ON "OrdenTrabajo"("tipoOT");
CREATE INDEX "OrdenTrabajo_estado_idx" ON "OrdenTrabajo"("estado");
CREATE INDEX "OrdenTrabajo_createdAt_idx" ON "OrdenTrabajo"("createdAt");

-- CreateIndex
CREATE INDEX "LineaOrdenTrabajo_ordenId_idx" ON "LineaOrdenTrabajo"("ordenId");
CREATE INDEX "LineaOrdenTrabajo_itemCatalogoId_idx" ON "LineaOrdenTrabajo"("itemCatalogoId");
CREATE INDEX "LineaOrdenTrabajo_productoId_idx" ON "LineaOrdenTrabajo"("productoId");

-- CreateIndex
CREATE UNIQUE INDEX "Factura_noFactura_key" ON "Factura"("noFactura");
CREATE INDEX "Factura_clienteId_idx" ON "Factura"("clienteId");
CREATE INDEX "Factura_ordenId_idx" ON "Factura"("ordenId");
CREATE INDEX "Factura_estado_idx" ON "Factura"("estado");
CREATE INDEX "Factura_fechaEmision_idx" ON "Factura"("fechaEmision");
CREATE INDEX "Factura_ncf_idx" ON "Factura"("ncf");
CREATE INDEX "Factura_esCotizacion_idx" ON "Factura"("esCotizacion");
CREATE INDEX "Factura_noFactura_idx" ON "Factura"("noFactura");
CREATE INDEX "Factura_deletedAt_idx" ON "Factura"("deletedAt");
CREATE INDEX "Factura_clienteId_estado_idx" ON "Factura"("clienteId", "estado");
CREATE INDEX "Factura_clienteId_fechaEmision_idx" ON "Factura"("clienteId", "fechaEmision");
CREATE INDEX "Factura_estado_fechaEmision_idx" ON "Factura"("estado", "fechaEmision");

-- CreateIndex
CREATE INDEX "LineaFactura_facturaId_idx" ON "LineaFactura"("facturaId");
CREATE INDEX "LineaFactura_productoId_idx" ON "LineaFactura"("productoId");

-- CreateIndex
CREATE UNIQUE INDEX "ConfiguracionNCF_tipoNcf_key" ON "ConfiguracionNCF"("tipoNcf");

-- CreateIndex
CREATE UNIQUE INDEX "CarritoTemp_empleadoId_key" ON "CarritoTemp"("empleadoId");
CREATE INDEX "CarritoTemp_empleadoId_idx" ON "CarritoTemp"("empleadoId");
CREATE INDEX "CarritoTemp_clienteId_idx" ON "CarritoTemp"("clienteId");

-- CreateIndex
CREATE INDEX "LineaCarrito_carritoId_idx" ON "LineaCarrito"("carritoId");
CREATE INDEX "LineaCarrito_productoId_idx" ON "LineaCarrito"("productoId");

-- CreateIndex
CREATE INDEX "_EmpleadoToRol_B_index" ON "_EmpleadoToRol"("B");

-- AddForeignKey
ALTER TABLE "SessionToken" ADD CONSTRAINT "SessionToken_empleadoId_fkey" FOREIGN KEY ("empleadoId") REFERENCES "Empleado"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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

-- AddForeignKey
ALTER TABLE "OrdenTrabajo" ADD CONSTRAINT "OrdenTrabajo_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrdenTrabajo" ADD CONSTRAINT "OrdenTrabajo_tecnicoId_fkey" FOREIGN KEY ("tecnicoId") REFERENCES "Empleado"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineaOrdenTrabajo" ADD CONSTRAINT "LineaOrdenTrabajo_ordenId_fkey" FOREIGN KEY ("ordenId") REFERENCES "OrdenTrabajo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineaOrdenTrabajo" ADD CONSTRAINT "LineaOrdenTrabajo_itemCatalogoId_fkey" FOREIGN KEY ("itemCatalogoId") REFERENCES "ItemCatalogo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineaOrdenTrabajo" ADD CONSTRAINT "LineaOrdenTrabajo_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "Producto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Factura" ADD CONSTRAINT "Factura_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Factura" ADD CONSTRAINT "Factura_ordenId_fkey" FOREIGN KEY ("ordenId") REFERENCES "OrdenTrabajo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineaFactura" ADD CONSTRAINT "LineaFactura_facturaId_fkey" FOREIGN KEY ("facturaId") REFERENCES "Factura"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineaFactura" ADD CONSTRAINT "LineaFactura_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "Producto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CarritoTemp" ADD CONSTRAINT "CarritoTemp_empleadoId_fkey" FOREIGN KEY ("empleadoId") REFERENCES "Empleado"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CarritoTemp" ADD CONSTRAINT "CarritoTemp_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineaCarrito" ADD CONSTRAINT "LineaCarrito_carritoId_fkey" FOREIGN KEY ("carritoId") REFERENCES "CarritoTemp"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineaCarrito" ADD CONSTRAINT "LineaCarrito_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "Producto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_EmpleadoToRol" ADD CONSTRAINT "_EmpleadoToRol_A_fkey" FOREIGN KEY ("A") REFERENCES "Empleado"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_EmpleadoToRol" ADD CONSTRAINT "_EmpleadoToRol_B_fkey" FOREIGN KEY ("B") REFERENCES "Rol"("id") ON DELETE CASCADE ON UPDATE CASCADE;
