# PRD — Automatización Reportes DGII 606 y 607

**Producto:** ACR Networks ERP NOC
**Fase:** 3 — Automatizaciones DGII
**Autor:** Equipo Backend ACR + IA Architect
**Estado:** Draft v1 — pendiente aprobación socios
**Fecha:** 2026-05-17
**Skill base:** `/to-prd` (mattpocock)

---

## 1. Resumen Ejecutivo

Los formularios **606** (Compras y Gastos a Proveedores) y **607** (Ventas de Bienes y Servicios) son reportes mensuales obligatorios que toda persona jurídica RD debe presentar a la **Dirección General de Impuestos Internos (DGII)** mediante archivo de texto delimitado por pipes (`|`) y subirlos al portal **OFV (Oficina Virtual)** antes del día 20 del mes siguiente al periodo declarado.

Hoy ACR Networks construye estos archivos a mano en Excel — proceso de ~6 horas/mes, propenso a errores de RNC, NCF y montos. Una multa por reporte inconsistente o tardío parte en **DOP 39,000** (Norma 06-2018) y escala por reincidencia.

Este PRD especifica un módulo backend que **genera automáticamente** los archivos `606` y `607` cumpliendo la **Norma DGII 06-2018** y el **Catálogo de Comprobantes Fiscales Electrónicos (e-CF)**, validando integridad antes de descargar y dejando trail auditable de cada generación.

---

## 2. Problema y Contexto

### 2.1 Pain points actuales (operación ACR)

| Pain | Costo actual |
|------|--------------|
| Construir 606/607 manual en Excel cada mes | 4-6 horas contador |
| Riesgo de error en RNC/Cédula proveedor → 606 rechazado por DGII | Re-envío + 1 día contador |
| ITBIS retenido a proveedores mal calculado | Multa potencial 6,000-39,000 DOP |
| NCF inválido o duplicado pasa al archivo | 606/607 rechazado en validación previa OFV |
| Cero auditoría: no se sabe quién generó qué reporte | Riesgo cumplimiento sustancial |
| Notas de Crédito (B04) no se restan correctamente del 607 | Sobre-declaración → ITBIS pagado de más |

### 2.2 Obligación legal (resumen)

- **Norma General 06-2018** — Formato obligatorio archivo TXT pipe-delimited.
- **Decreto 254-06 art. 6** — Plazo: día 20 del mes siguiente al periodo.
- **Decreto 254-06 art. 7** — Conservación 10 años del archivo + comprobantes que lo originan.
- **Régimen sancionatorio (Código Tributario art. 257-261)** — Inconsistencias generan multas + intereses.

### 2.3 Out of scope (esta fase)

- **e-CF (factura electrónica DGII)** — Fase 4 (firma XML XAdES + endpoint REST DGII).
- **Formularios 608 (NCF anulados), 609 (pagos al exterior), 623 (retenciones renta), IT-1, IR-17** — Fase 5.
- **Pre-llenado de la 606/607 desde OFV API** — DGII todavía no expone API pública para subida (subida sigue siendo manual al portal).

---

## 3. Goals y Non-Goals

### 3.1 Goals

1. **G1** — Generar archivo `DGII_F_606_<RNC>_<YYYYMM>.TXT` válido en 1 click para el periodo seleccionado.
2. **G2** — Generar archivo `DGII_F_607_<RNC>_<YYYYMM>.TXT` válido en 1 click.
3. **G3** — Validar 100% de los registros antes de exportar (RNC dígito verificador, NCF formato, montos cuadrados).
4. **G4** — Preview JSON antes de descargar para que el contador revise totales agregados.
5. **G5** — Audit-trail inmutable: cada generación queda en `ReporteDGIIGenerado` con SHA-256 del archivo, empleado, IP, timestamp.
6. **G6** — Solo `sistema:owner` + permiso `dgii:reportar` pueden generar; descarga requiere TOTP estricto.

### 3.2 Non-Goals

- **No** automatizamos subida al OFV (DGII no expone API pública para esto).
- **No** firmamos digitalmente el archivo (la DGII no exige firma del TXT — solo del XML e-CF).
- **No** generamos 608/609/IT-1/IR-17 (fuera de scope esta fase).
- **No** soportamos régimen RST/PST (ACR es persona jurídica régimen ordinario).

---

## 4. Usuarios

| Rol | Permiso requerido | Acción |
|---|---|---|
| Propietario absoluto | `sistema:owner` + `dgii:reportar` + TOTP | Genera, descarga, archiva |
| Contador externo | `dgii:reportar` (delegado por owner) | Preview-only, NO descarga |
| Empleado regular | — | Sin acceso al módulo |

---

## 5. Requisitos Funcionales

### 5.1 Formato 606 — Compras y Gastos

**Filename DGII (obligatorio):** `DGII_F_606_<RNC>_<YYYYMM>.TXT` (todo en mayúsculas, sin tilde).

**Línea 1 (header):**
```
606|<RNC_Empresa>|<YYYYMM>|<Cantidad_Registros>
```

Ej: `606|130000123|202604|42`

**Líneas 2..N (registros):** Una factura de proveedor por línea, 30 columnas pipe-delimited.

| # | Campo | Tipo | Formato | Obligatorio | Notas |
|---|-------|------|---------|-------------|-------|
| 1 | RNC/Cédula Proveedor | string | 9 o 11 dígitos, sin guiones | ✅ | Si tipoID=3 (pasaporte): alfanumérico hasta 20 |
| 2 | TipoID | enum | `1`=RNC, `2`=Cédula, `3`=Pasaporte | ✅ | |
| 3 | TipoBienServicio | enum | `01`-`11` | ✅ | Ver §5.1.1 |
| 4 | NCF | string | 11 chars, formato `B##########` o e-CF `E##########` | ✅ | Validar checksum DGII |
| 5 | NCF Modificado | string | mismo formato; vacío si N/A | ⚠️ | Solo si comprobante es ND/NC al proveedor |
| 6 | Fecha Comprobante | date | `YYYYMMDD` | ✅ | Fecha factura proveedor |
| 7 | Fecha Pago | date | `YYYYMMDD` | ⚠️ | Vacío si aún no pagada |
| 8 | Monto Facturado Servicios | decimal | 12,2 | ⚠️ | Suma de líneas de servicio |
| 9 | Monto Facturado Bienes | decimal | 12,2 | ⚠️ | Suma de líneas de bien |
| 10 | Total Monto Facturado | decimal | 12,2 | ✅ | Suma columnas 8+9 |
| 11 | ITBIS Facturado | decimal | 12,2 | ✅ | 18% del subtotal gravado |
| 12 | ITBIS Retenido | decimal | 12,2 | ⚠️ | Solo si retiene (proveedor sin RNC o régimen especial) |
| 13 | ITBIS sujeto a Proporcionalidad | decimal | 12,2 | ⚠️ | Solo régimen mixto |
| 14 | ITBIS Llevado al Costo | decimal | 12,2 | ⚠️ | |
| 15 | ITBIS por Adelantar | decimal | 12,2 | ⚠️ | |
| 16 | ITBIS Percibido en Compras | decimal | 12,2 | ⚠️ | |
| 17 | Tipo Retención ISR | enum | `01`-`07` | ⚠️ | Solo si aplica retención ISR |
| 18 | Monto Retención Renta | decimal | 12,2 | ⚠️ | |
| 19 | ISR Percibido en Compras | decimal | 12,2 | ⚠️ | |
| 20 | Impuesto Selectivo al Consumo | decimal | 12,2 | ⚠️ | |
| 21 | Otros Impuestos/Tasas | decimal | 12,2 | ⚠️ | |
| 22 | Monto Propina Legal | decimal | 12,2 | ⚠️ | |
| 23 | Forma de Pago | enum | `01`-`07` | ✅ | Ver §5.1.2 |

#### 5.1.1 Catálogo TipoBienServicio (DGII)

```
01 — Gastos de Personal
02 — Gastos por Trabajos, Suministros y Servicios
03 — Arrendamientos
04 — Gastos de Activos Fijos
05 — Gastos de Representación
06 — Gastos Financieros
07 — Gastos de Seguros
08 — Gastos por Combustibles
09 — Gastos de Reparación y Mantenimiento
10 — Adquisiciones de Activos
11 — Gastos de Mercadeo, Publicidad e Investigación
```

ACR mapping por defecto:
- Combustibles transporte técnicos → `08`
- Equipos red/CCTV stock → `10`
- Mantenimiento vehículos → `09`
- Pago renta oficina → `03`
- Servicios contables/abogados → `02`

#### 5.1.2 Catálogo Forma de Pago

```
01 — Efectivo
02 — Cheques/Transferencias/Depósito
03 — Tarjeta Crédito/Débito
04 — Compra a Crédito
05 — Permuta
06 — Nota de Crédito (uso interno)
07 — Mixto
```

### 5.2 Formato 607 — Ventas de Bienes y Servicios

**Filename:** `DGII_F_607_<RNC>_<YYYYMM>.TXT`

**Línea 1 (header):**
```
607|<RNC_Empresa>|<YYYYMM>|<Cantidad_Registros>
```

**Líneas 2..N:** Una Factura/ND/NC emitida por línea, 23 columnas.

| # | Campo | Tipo | Formato | Obligatorio | Notas |
|---|-------|------|---------|-------------|-------|
| 1 | RNC/Cédula Cliente | string | 9 o 11 dígitos | ⚠️ | Vacío si NCF Consumidor Final |
| 2 | TipoID | enum | `1`=RNC, `2`=Cédula, `3`=Pasaporte | ⚠️ | Vacío si Consumidor Final |
| 3 | NCF | string | 11 chars | ✅ | |
| 4 | NCF Modificado | string | 11 chars; vacío si N/A | ⚠️ | Solo si es ND (B03) o NC (B04) |
| 5 | Tipo Ingreso | enum | `01`-`08` | ✅ | Ver §5.2.1 |
| 6 | Fecha Comprobante | date | `YYYYMMDD` | ✅ | |
| 7 | Fecha Retención | date | `YYYYMMDD` | ⚠️ | Solo si cliente retuvo |
| 8 | Monto Facturado | decimal | 12,2 | ✅ | Subtotal antes ITBIS |
| 9 | ITBIS Facturado | decimal | 12,2 | ✅ | |
| 10 | ITBIS Retenido por Tercero | decimal | 12,2 | ⚠️ | |
| 11 | ITBIS Percibido | decimal | 12,2 | ⚠️ | |
| 12 | Retención Renta por Tercero | decimal | 12,2 | ⚠️ | |
| 13 | ISR Percibido | decimal | 12,2 | ⚠️ | |
| 14 | Impuesto Selectivo Consumo | decimal | 12,2 | ⚠️ | |
| 15 | Otros Impuestos/Tasas | decimal | 12,2 | ⚠️ | |
| 16 | Monto Propina Legal | decimal | 12,2 | ⚠️ | |
| 17 | Efectivo | decimal | 12,2 | ⚠️ | Desglose pago |
| 18 | Cheque/Transferencia/Depósito | decimal | 12,2 | ⚠️ | |
| 19 | Tarjeta Débito/Crédito | decimal | 12,2 | ⚠️ | |
| 20 | Venta a Crédito | decimal | 12,2 | ⚠️ | |
| 21 | Bonos/Certificados/Regalo | decimal | 12,2 | ⚠️ | |
| 22 | Permuta | decimal | 12,2 | ⚠️ | |
| 23 | Otras Formas de Venta | decimal | 12,2 | ⚠️ | |

**Regla suma columnas 17-23 = columna 8 + columna 9 + impuestos adicionales.**

#### 5.2.1 Catálogo TipoIngreso (DGII)

```
01 — Ingresos por Operaciones (No financieros)
02 — Ingresos Financieros
03 — Ingresos Extraordinarios
04 — Ingresos por Arrendamientos
05 — Ingresos por Venta de Activos Depreciables
06 — Otros Ingresos
07 — Ingresos por Servicios Profesionales
08 — Ingresos por Comisiones
```

ACR default por tipo de venta:
- POS/factura B01/B02 servicios internet/CCTV → `01`
- Venta equipo red usado → `05`
- Comisión integrador → `08`

### 5.3 Inclusión/Exclusión de Comprobantes en el 607

| Comprobante | NCF prefijo | ¿Incluir en 607? | Tratamiento |
|---|---|---|---|
| Crédito Fiscal | B01 | ✅ | Una línea, monto positivo |
| Consumidor Final | B02 | ✅ | Una línea, RNC vacío |
| Nota de Débito | B03 | ✅ | Monto positivo + NCF Modificado |
| Nota de Crédito | B04 | ✅ | **Monto negativo** + NCF Modificado |
| Régimen Especial | B14 | ✅ | TipoIngreso=01 |
| Cotización | — | ❌ | NO emitida fiscal, no va al reporte |
| Factura `estado='Anulada'` antes del periodo | — | ❌ | No genera ingreso fiscal |
| Factura `estado='Anulada'` durante el periodo | — | ✅ | Línea negativa con NCF de la original |

### 5.4 Inclusión en el 606

Cada compra registrada a un Suplidor del periodo seleccionado, con NCF formato válido B##/E## (no se incluyen tickets sin NCF — ese gasto es no deducible).

### 5.5 UI/UX

**Ruta frontend:** `frontend/src/features/accounting/ReportesDGII.jsx`

```
┌─────────────────────────────────────────────────────────────┐
│  Reportes DGII                                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Periodo: [ Mayo 2026  ▾ ]   RNC: 130000123                 │
│                                                             │
│  ┌────────────────────────┐    ┌────────────────────────┐  │
│  │   606 — Compras        │    │   607 — Ventas         │  │
│  │   42 registros          │    │   318 registros         │  │
│  │   Total: 1,247,580.00   │    │   Total: 4,892,310.00   │  │
│  │   ITBIS: 224,564.40     │    │   ITBIS: 880,615.80     │  │
│  │                         │    │                         │  │
│  │   [Preview]  [Descargar]│    │   [Preview]  [Descargar]│  │
│  └────────────────────────┘    └────────────────────────┘  │
│                                                             │
│  Historial:                                                 │
│  ├─ 606 2026-04   42 reg   archivado por carmelo  2026-05-08│
│  ├─ 607 2026-04  318 reg   archivado por carmelo  2026-05-08│
│  └─ ...                                                     │
└─────────────────────────────────────────────────────────────┘
```

Preview abre slide-over con tabla paginada (50 filas por página) + totales agregados. Descargar requiere TOTP estricto (modal de código antes de stream).

---

## 6. Requisitos No-Funcionales

| Categoría | Requisito |
|---|---|
| **Performance** | Generación 606/607 ≤ 8s para periodo con 5000 registros |
| **Seguridad** | Endpoints `verificarJWT` + `requerirNivel(NIVEL_PROPIETARIO_ABSOLUTO)` + `requerirTOTPEstricto` para descarga |
| **Audit** | Cada generación = una fila `ReporteDGIIGenerado` (SHA-256 + IP + UA + empleadoId) |
| **Storage** | Archivo TXT se sube a Supabase Storage bucket `dgii/<rnc>/<periodo>/`, retention 10 años |
| **Encoding** | UTF-8 sin BOM (DGII exige ANSI/Latin-1 pero acepta UTF-8 sin BOM) |
| **Line endings** | `\r\n` (DGII oficial es CRLF, no LF) |
| **Concurrencia** | Lock por `(tipo, periodo, rnc)`: dos generaciones simultáneas del mismo reporte → segunda recibe 409 hasta que primera termine |
| **Cyber Neo** | RNC + cédula NUNCA aparecen sin enmascarar en logs (`auditReq` enmascara últimos 4 dígitos) |

---

## 7. Modelo de Datos

### 7.1 Entidades existentes utilizadas

- `Factura` (campo `ncf`, `tipoNcf`, `fechaEmision`, `total`, `itbis`, `subtotal`, `estado`, `esNotaCredito`, `esNotaDebito`, `facturaOrigenId`, `pagos`)
- `LineaFactura` (para separar bienes vs servicios via `itemCatalogo.tipoItem`)
- `Cliente` (`rnc`, `cedula`, `tipoNcf`)
- `Suplidor` (`rnc`, `cedula`)
- `EmpresaPerfil` (`rnc` para header)
- `ConfiguracionNCF` (para validación formato)

### 7.2 Migración Prisma requerida (BLOQUEADOR)

#### 7.2.1 Nueva entidad `Compra` (compras a proveedores — base del 606)

```prisma
model Compra {
  id                          String     @id @default(uuid())
  noCompra                    String     @unique
  suplidorId                  String
  // NCF emitido por el proveedor (siempre B/E + 10 dígitos)
  ncfProveedor                String
  ncfModificado               String?    // si es ND/NC del proveedor
  tipoBienServicio            String     // catálogo DGII 01-11
  fechaComprobante            DateTime
  fechaPago                   DateTime?
  formaPago                   String     // catálogo DGII 01-07
  montoServicios              Decimal    @default(0)  @db.Decimal(12, 2)
  montoBienes                 Decimal    @default(0)  @db.Decimal(12, 2)
  itbisFacturado              Decimal    @default(0)  @db.Decimal(12, 2)
  itbisRetenido               Decimal    @default(0)  @db.Decimal(12, 2)
  itbisProporcionalidad       Decimal    @default(0)  @db.Decimal(12, 2)
  itbisLlevadoCosto           Decimal    @default(0)  @db.Decimal(12, 2)
  itbisPorAdelantar           Decimal    @default(0)  @db.Decimal(12, 2)
  itbisPercibido              Decimal    @default(0)  @db.Decimal(12, 2)
  tipoRetencionIsr            String?
  montoRetencionRenta         Decimal    @default(0)  @db.Decimal(12, 2)
  isrPercibido                Decimal    @default(0)  @db.Decimal(12, 2)
  impuestoSelectivoConsumo    Decimal    @default(0)  @db.Decimal(12, 2)
  otrosImpuestos              Decimal    @default(0)  @db.Decimal(12, 2)
  propinaLegal                Decimal    @default(0)  @db.Decimal(12, 2)
  notas                       String?
  empleadoId                  Int?
  deletedAt                   DateTime?
  createdAt                   DateTime   @default(now())
  updatedAt                   DateTime   @updatedAt
  suplidor                    Suplidor   @relation(fields: [suplidorId], references: [id], onDelete: Restrict)
  empleado                    Empleado?  @relation(fields: [empleadoId], references: [id], onDelete: SetNull)

  @@index([suplidorId])
  @@index([ncfProveedor])
  @@index([fechaComprobante])
  @@index([deletedAt])
}
```

#### 7.2.2 Campos nuevos en `Factura` (para 607 completo)

```prisma
// dentro de model Factura:
tipoIngreso              String     @default("01")     // catálogo DGII 01-08
fechaRetencion           DateTime?
itbisRetenidoTercero     Decimal    @default(0)  @db.Decimal(12, 2)
itbisPercibido           Decimal    @default(0)  @db.Decimal(12, 2)
retencionRentaTercero    Decimal    @default(0)  @db.Decimal(12, 2)
isrPercibido             Decimal    @default(0)  @db.Decimal(12, 2)
impuestoSelectivoConsumo Decimal    @default(0)  @db.Decimal(12, 2)
otrosImpuestos           Decimal    @default(0)  @db.Decimal(12, 2)
propinaLegal             Decimal    @default(0)  @db.Decimal(12, 2)
```

> El desglose de pagos (efectivo, cheque, tarjeta, crédito, bonos, permuta, otros) ya existe parcialmente en `Factura.pagos` (JSON). Se aprovecha; no requiere migración. El servicio mapea el JSON a las 7 columnas.

#### 7.2.3 Nueva entidad `ReporteDGIIGenerado` (audit trail)

```prisma
model ReporteDGIIGenerado {
  id                String    @id @default(uuid())
  tipo              String    // "606" | "607"
  periodo           String    // "YYYYMM"
  rncEmpresa        String
  cantidadRegistros Int
  totalMonto        Decimal   @db.Decimal(14, 2)
  totalItbis        Decimal   @db.Decimal(14, 2)
  sha256            String    // hash del archivo generado
  archivoUrl        String?   // Supabase Storage path
  empleadoId        Int
  ipGeneracion      String?
  userAgent         String?
  generadoEn        DateTime  @default(now())
  empleado          Empleado  @relation(fields: [empleadoId], references: [id], onDelete: Restrict)

  @@unique([tipo, periodo, rncEmpresa])  // un solo reporte vigente por tipo+periodo
  @@index([tipo])
  @@index([periodo])
  @@index([generadoEn])
}
```

#### 7.2.4 Permiso nuevo `dgii:reportar`

Añadir a `backend/shared/permissions.map.js`:
```js
'dgii:reportar': { label: 'DGII — Generar reportes 606/607', categoria: 'Fiscal', nivel: 80 }
```

---

## 8. Arquitectura (Blueprint 5-archivos)

**Ubicación:** `backend/modules/dgii/` (módulo de primer nivel — NO subdirectorio de `ventas/` ni `admin/`, porque trasciende ambos: 606 toca compras + suplidores, 607 toca facturas + clientes).

```
backend/modules/dgii/
  index.js          // factory padre (monta sub-routers 606 + 607 + historial)
  schema.js         // Zod DTOs: periodoSchema, generarReporteSchema
  repo.js           // queries Prisma:
                    //   - listFacturasParaReporte607(periodoStart, periodoEnd)
                    //   - listComprasParaReporte606(periodoStart, periodoEnd)
                    //   - findReporteHistorial(tipo, periodo)
                    //   - createReporteRegistro(data)
  service.js        // núcleo:
                    //   - generarReporte606(periodo) -> { txt, header, rows, totales, sha256 }
                    //   - generarReporte607(periodo) -> idem
                    //   - validarRegistro606(row) / validarRegistro607(row)
                    //   - mapFacturaA607Row(factura) / mapCompraA606Row(compra)
                    //   - mapDesglosePagos607(factura.pagos)
                    //   - persistirArchivoStorage(txt, tipo, periodo)
                    //   - locking lockGeneracion(tipo, periodo)
  controller.js     // handlers HTTP:
                    //   - previewReporte (devuelve JSON con rows + totales, no archivo)
                    //   - downloadReporte (stream TXT, requiere TOTP estricto)
                    //   - historial (lista ReporteDGIIGenerado)
  router.js         // rutas:
                    //   GET  /dgii/606/preview?periodo=YYYYMM
                    //   GET  /dgii/606/download?periodo=YYYYMM     (TOTP)
                    //   GET  /dgii/607/preview?periodo=YYYYMM
                    //   GET  /dgii/607/download?periodo=YYYYMM     (TOTP)
                    //   GET  /dgii/historial
                    //   POST /dgii/compras            (CRUD compras — feed del 606)
                    //   GET  /dgii/compras
                    //   PUT  /dgii/compras/:id
                    //   DELETE /dgii/compras/:id      (TOTP + propietario)
```

### 8.1 Reglas Blueprint aplicadas

- **router.js**: solo HTTP + middlewares (`verificarJWT`, `requerirPermiso('dgii:reportar')`, `requerirNivel(NIVEL_PROPIETARIO_ABSOLUTO)` para descarga, `requerirTOTPEstricto` para descarga + delete).
- **controller.js**: extrae periodo de `req.query`, valida con `periodoSchema`, llama a service, mapea descriptor → res. NO toca Prisma. Para download, setea headers Content-Type/Content-Disposition y `res.end(txt)`.
- **service.js**: pura lógica DGII. NO sabe qué es req/res. Llama a `repo` para queries y a `auditReq` (vía `_fakeReqForAudit`) para registros. Lanza `DgiiError(status, code, message)` capturada por `_wrap`.
- **repo.js**: único punto que toca Prisma. Cada query nombrada y mockeable.
- **schema.js**: Zod DTOs locales. `periodoSchema` valida `YYYYMM`, `compraSchema` valida CRUD compras.

### 8.2 Integración con el bootstrap

En `backend/server.js`:
```js
const createDgiiRouter = require('./modules/dgii');
app.use('/api', createDgiiRouter(_routerDeps));
```

### 8.3 Cyber Neo (aplicado)

- **A01 Access Control**: descarga requiere TOTP + `NIVEL_PROPIETARIO_ABSOLUTO`.
- **A03 Injection**: queries 100% Prisma parametrizado; periodo validado por Zod regex `^\d{6}$`.
- **A04 Insecure Design**: lock `(tipo, periodo)` previene reentrada concurrente; SHA-256 atado al archivo en `ReporteDGIIGenerado` permite probar inmutabilidad post-facto.
- **A08 Integrity**: el archivo guardado en Storage es **read-only** (bucket policy); cualquier "regeneración" crea fila nueva con SHA distinto, no sobreescribe.
- **A09 Logging**: cada generación + descarga + visualización dispara `auditReq('dgii:606_generado'/'dgii:607_descargado')`. Cero PII en logs (RNC se enmascara).
- **Path Traversal**: filename derivado de constantes server-side + RNC empresa propio. CERO `req.params` en el path.

---

## 9. Algoritmos Clave

### 9.1 generarReporte606(periodo)

```
1. Parsear periodo "YYYYMM" → periodoStart = primer día 00:00, periodoEnd = primer día mes siguiente 00:00
2. SELECT compras WHERE fechaComprobante >= periodoStart AND < periodoEnd AND deletedAt IS NULL
3. Para cada compra:
   a. Validar suplidor.rnc o suplidor.cedula presente (sino → error registro)
   b. Determinar TipoID: si rnc 9 dígitos → 1; si cédula 11 dígitos → 2; else → 3 (pasaporte)
   c. Validar formato NCF: regex /^[BE]\d{10}$/
   d. Mapear a row606 (23 campos pipe-delimited, decimales con 2 dec)
   e. Acumular totales
4. Construir header: `606|<empresaRnc>|<periodo>|<rows.length>`
5. Concatenar header + "\r\n" + rows.join("\r\n") + "\r\n" → archivo TXT
6. Calcular SHA-256
7. Insertar ReporteDGIIGenerado
8. Subir a Supabase Storage `dgii/<rnc>/<periodo>/606.txt`
9. auditReq('dgii:606_generado', ...)
10. Retornar { txt, sha256, rows.length, totales }
```

### 9.2 generarReporte607(periodo)

```
1. periodoStart, periodoEnd (idem 606)
2. SELECT facturas WHERE
     fechaEmision >= periodoStart AND < periodoEnd
     AND esCotizacion = false
     AND deletedAt IS NULL
     AND ncf IS NOT NULL
3. Para cada factura:
   a. Si es Nota de Crédito (esNotaCredito=true): monto y ITBIS van NEGATIVOS en el archivo
   b. Si cliente.rnc presente y tipoNcf="Crédito Fiscal" (B01): TipoID=1
      Si solo cliente.cedula: TipoID=2
      Si Consumidor Final B02 sin id: vacíos
   c. Validar NCF format
   d. Mapear desglose `factura.pagos` JSON → 7 columnas formas de pago
      - "Efectivo" → col 17
      - "Cheque"/"Transferencia"/"Depósito" → col 18
      - "Tarjeta" → col 19
      - "Crédito" → col 20
      - "Bono"/"Certificado"/"Regalo" → col 21
      - "Permuta" → col 22
      - "Otro" → col 23
   e. Sumar a totales
4. Header `607|<rnc>|<periodo>|<rows.length>`
5. Mismo flujo de archivo + sha256 + ReporteDGIIGenerado + storage + audit
```

### 9.3 Validación RNC/Cédula (digit-check DGII)

Ya existe `helpers.validarCedulaRD` para cédula. RNC tiene su propio dígito verificador:

```
RNC 9 dígitos: c1..c8 + dv
Multiplicadores: [7, 9, 8, 6, 5, 4, 3, 2]
suma = Σ ci * mi
mod  = suma mod 11
dv = mod == 0 || mod == 1 ? mod : 11 - mod
```

Añadir `helpers.validarRncRD(rnc)` en `backend/shared/helpers.js` antes de implementar el módulo.

### 9.4 Locking concurrencia

`service.lockGeneracion(tipo, periodo)` usa un `Map<string, Promise>` en closure del service (singleton via factory):

```
key = `${tipo}:${periodo}:${rnc}`
if (locks.has(key)) throw DgiiError(409, 'GENERACION_EN_PROGRESO')
const p = realGenerar(...).finally(() => locks.delete(key))
locks.set(key, p)
return p
```

---

## 10. Edge Cases

| Caso | Tratamiento |
|------|-------------|
| Periodo sin compras | 606 genera archivo válido con header + 0 registros (cantidad=0) |
| Periodo sin ventas | 607 idem |
| Suplidor sin RNC ni cédula | Error registro, no se incluye. Bloquea generación. UI lista los offensores |
| Factura B02 (Consumidor Final) sin cliente identificado | RNC/Cédula y TipoID quedan vacíos (válido DGII) |
| Nota de Crédito que cruza periodos (emitida después del periodo de la factura origen) | Va al 607 del periodo de la NC, NO del periodo origen. Monto negativo |
| Factura anulada **dentro del periodo** | Se incluye con monto negativo y NCF de la original (regla DGII consolidación) |
| Periodo futuro | Schema rechaza: `periodo <= mesActual` |
| Periodo > 10 años atrás | Schema rechaza (DGII solo retiene 10 años) |
| Compras a proveedor sin NCF (tickets) | NO van al 606 (gasto no deducible) |
| Re-generación del mismo periodo | Permitido; cada vez crea fila nueva en `ReporteDGIIGenerado` (versioning natural por SHA) |
| Empresa sin RNC configurado en `EmpresaPerfil` | Bloquea generación con error accionable: "Configura RNC en Mi Empresa" |

---

## 11. Plan de Acción Técnico (Step-by-Step)

> **Reglas a seguir**: `/tdd` para servicios críticos · `/cyber-neo` antes de merge · REGLA DE ENTREGA en cada step.

### Step 1 — Migración Prisma (Bloqueador)
- Crear `Compra` model
- Añadir campos DGII a `Factura`
- Crear `ReporteDGIIGenerado` model
- Añadir `dgii:reportar` a `permissions.map.js`
- Migration: `npx prisma migrate dev --name dgii_fase3_setup`
- Seed de catálogos DGII (TipoBienServicio, TipoIngreso, etc.) como constantes JS (no van a BD).

### Step 2 — Helpers Shared
- `validarRncRD(rnc)` en `backend/shared/helpers.js`
- `formatNcfDgii(ncf)` (padding + uppercase) en `backend/shared/helpers.js`
- `enmascararRnc(rnc)` para logs (deja últimos 4 dígitos)

### Step 3 — Módulo `dgii/` Blueprint
3.1 `schema.js`: `periodoSchema`, `compraSchema`, `compraUpdateSchema`, `generarReporteParamsSchema`
3.2 `repo.js`: queries de compras + facturas + reporteHistorial
3.3 `service.js`:
    - constantes catálogos
    - `mapCompraA606Row` + `mapFacturaA607Row`
    - `validarRegistro606` + `validarRegistro607`
    - `generarReporte606` + `generarReporte607` (TDD `tdd`)
    - `lockGeneracion`
    - `persistirArchivoStorage`
    - CRUD compras (crear / listar / editar / borrar)
3.4 `controller.js`: handlers thin + `_wrap` + `_fakeReqForAudit`
3.5 `router.js`: routes + middlewares (TOTP en download + DELETE compras)
3.6 `index.js`: factory parent
3.7 Wiring en `backend/server.js`: `app.use('/api', createDgiiRouter(_routerDeps))`

### Step 4 — Tests Unitarios (TDD)
- `service.test.js`:
  - generarReporte606 con 0 / 1 / N compras
  - generarReporte607 con factura + NC + ND
  - validar header `606|RNC|YYYYMM|N`
  - SHA-256 estable para mismas inputs
  - lock concurrencia (dos llamadas paralelas → segunda 409)
- Mock prisma + storage. Cero hits a DB real.

### Step 5 — UI Frontend
- Página `features/accounting/ReportesDGII.jsx`:
  - month picker
  - 2 cards (606 / 607) con totales en vivo del preview
  - botones Preview (drawer slide-over con tabla) + Descargar (modal TOTP)
  - sección Historial con descargas anteriores
- Página `features/accounting/Compras.jsx`:
  - CRUD compras vinculadas a Suplidor (autocomplete del CRM)
  - Form con todos los campos DGII (tipoBienServicio, formaPago, ITBIS retenido, etc.)
- Permisos: solo visible si `permisos.includes('dgii:reportar')`

### Step 6 — Auditoría Cyber-Neo (skill `/cyber-neo`)
- Verificar OWASP Top 10 sobre el módulo:
  - A01: middleware chain correcto
  - A03: queries Prisma 100% parametrizadas
  - A04: lock concurrencia funciona
  - A05: filename sin user-controlled paths
  - A07: TOTP estricto enforced en download
  - A09: audit cada generación, RNC enmascarado en logs
- Storage policy review: bucket `dgii/` lectura solo por owner, escritura solo backend.

### Step 7 — Seed datos de prueba
- 50 compras fake (mes anterior)
- 200 facturas fake con desglose pagos
- 10 NC + 5 ND
- Verificar manual: generación 606 + 607 → archivo abre en Excel sin warnings → suma columnas cuadra.

### Step 8 — Acceptance test con contador
- Generar 606/607 de mes real con datos productivos.
- Cargar archivo en el simulador OFV (DGII pre-validación) → 0 errores.
- Si OK: declarar Fase 3 completada y avanzar a Fase 4 (e-CF XML).

---

## 12. Métricas de Éxito

| Métrica | Target |
|---|---|
| Tiempo generación 606/607 por mes | ≤ 8s (vs 4-6h manual) |
| % registros rechazados por OFV en pre-validación | 0% |
| Multas DGII por inconsistencia post-launch | 0 (vs riesgo actual 39k+ DOP/mes) |
| % cumplimiento entrega antes día 20 | 100% |
| Adopción del módulo (mes 1) | ≥ 1 generación de 606 + 1 de 607 |

---

## 13. Open Questions

1. **OFV API**: ¿La DGII tiene API REST para validar el TXT antes de subirlo? Investigar `https://dgii.gov.do/ofv` — si existe, integrar pre-flight check.
2. **Régimen mixto ACR**: ¿ACR factura servicios exentos (algunos servicios ISP rurales tienen exoneración)? Si sí, ITBISsujetoProporcionalidad es relevante en el 606.
3. **Retención ISR a proveedores**: ¿ACR retiene 2% renta a profesionales liberales (abogado, contador)? Si sí, columna 18 del 606 aplica.
4. **e-CF**: ¿En cuánto tiempo migra ACR a factura electrónica? Si plan es Q4 2026, el 607 actual sigue siendo TXT pipe; si plan es Q3, conviene saltar a Fase 4 ya.
5. **Bucket Storage**: ¿Crear bucket separado `dgii-reports` o reutilizar el actual? Recomendado: separado con retención 10 años.
6. **Cliente walk-in / no-RNC en B01**: hoy POS exige `clienteId` obligatorio; mantener regla — sin cliente real no se puede emitir B01 (que requiere RNC del comprador).

---

## 14. Rollout Plan

| Fase | Duración | Qué | Riesgo |
|------|----------|-----|--------|
| F0 — Schema | 0.5d | Migración Prisma + seed catálogos | Bajo |
| F1 — Backend CRUD Compras | 1.5d | repo+service+controller+router para Compras | Bajo |
| F2 — Reporte 607 | 2d | algoritmo + validación + tests + download | Medio (mapping pagos) |
| F3 — Reporte 606 | 1.5d | algoritmo + tests | Bajo (depende F1) |
| F4 — UI ReportesDGII | 2d | React drawer + month picker + TOTP modal | Bajo |
| F5 — Audit Cyber-Neo | 0.5d | OWASP check + storage policy | Bajo |
| F6 — Acceptance test | 1d | Generar + cargar en OFV staging | Medio (depende de OFV) |
| **Total** | **9 días-laborales** | | |

---

## 15. Apéndices

### 15.1 Referencias DGII

- **Norma General 06-2018** — Formato 606/607 obligatorio.
- **Norma General 07-2018** — Modificaciones al Reglamento DGII.
- **Decreto 254-06** — Reglamento de Comprobantes Fiscales.
- **Resolución 30-2018** — Sanciones por incumplimiento.
- **Catálogo NCF y e-CF** — `https://dgii.gov.do/comprobantes-fiscales`

### 15.2 Glosario

- **NCF** — Número de Comprobante Fiscal (11 chars: 1 letra + 10 dígitos).
- **e-CF** — Comprobante Fiscal Electrónico (XML XAdES). Reemplaza NCF en migración 2024-2027.
- **OFV** — Oficina Virtual DGII (`https://dgii.gov.do/ofv`).
- **TipoID 1/2/3** — RNC / Cédula / Pasaporte.
- **B01..B04** — Tipos de NCF físicos vigentes.
- **B14** — Régimen Especial (exenciones).

### 15.3 Anexo: ejemplo línea 607 real

```
607|130000123|202604|3
130044451|1|B0100000001|||01|20260415|20260420|10000.00|1800.00|0.00|0.00|0.00|0.00|0.00|0.00|0.00|0.00|11800.00|0.00|0.00|0.00|0.00|0.00
|||B0200000002||01|20260416||5000.00|900.00|0.00|0.00|0.00|0.00|0.00|0.00|5900.00|0.00|0.00|0.00|0.00|0.00|0.00
130045123|1|B0400000001|B0100000001|01|20260420||-3000.00|-540.00|0.00|0.00|0.00|0.00|0.00|0.00|0.00|-3540.00|0.00|0.00|0.00|0.00|0.00|0.00
```

Línea 1: header (3 registros).
Línea 2: factura B01 a cliente con RNC, ITBIS 18%, pago en efectivo.
Línea 3: factura B02 Consumidor Final (sin RNC/TipoID), pago efectivo.
Línea 4: nota de crédito B04 modifica B01, montos negativos, pago en cheque.

---

**Fin del PRD v1.**

Aprobación pendiente:
- [ ] Socio fundador / Propietario absoluto
- [ ] Contador externo (vía revisión técnica de §5.1 y §5.2)
- [ ] Cyber-Neo audit firmado

Una vez aprobado, ejecutar **Step 1** del plan de acción técnico (§11).
