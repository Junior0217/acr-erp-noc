# ACR Networks & Solutions — ERP NOC

Sistema de gestión interna para ACR Networks (dueños Carmelo y Cristian Adams): instalación de CCTV, redes estructuradas, reparación de equipos en taller y soporte técnico. Cubre clientes, servicios, inventario (Kardex), órdenes de trabajo de campo, taller (RMA), bóveda de credenciales (PAM), CMDB de activos instalados y préstamos de equipo.

## Language

### Servicios y Planes

**Plan**:
Plantilla reutilizable de un servicio comercial (ej. "WISP 50Mbps", "CCTV 4 cámaras"). Define tipo, precios base y lista de equipos típicos a instalar.
_Avoid_: producto, paquete, oferta

**PlantillaEquipo**:
Lista de productos con cantidades predeterminadas que compone la base de un Plan. Se usa para pre-poblar los equipos de una OrdenInstalacion.
_Avoid_: kit, bundle

**Servicio**:
Instancia de un Plan contratado por un Cliente específico. Permite personalizar precios y equipos respecto a la base del Plan.
_Avoid_: contrato, producto, cuenta

**TipoServicio**:
Clasificación del servicio: `WISP | CCTV | Redes | CercosElectricos | VentaEquipos | Mixto`.
El tipo de un Cliente se deriva de sus Servicios activos — no se almacena directamente en el Cliente.

**VentaEquipos**:
TipoServicio para ventas puntuales de equipos sin mensualidad. Sigue el mismo flujo que servicios recurrentes: `precioMensual = 0`, `precioInstalacion` = precio de venta. La OrdenInstalacion sirve como conduce de entrega.
_Avoid_: venta directa, POS

### Estados del Servicio

**EstadoServicio**:
Ciclo de vida de un Servicio: `Pendiente → EnInstalacion → Activo → Suspendido → Cancelado`.
- `Pendiente`: creado, sin orden asignada
- `EnInstalacion`: OrdenInstalacion creada y asignada al técnico
- `Activo`: OrdenInstalacion tipo Instalacion completada — Kardex descontado
- `Suspendido`: pausado temporalmente (ej. deuda del cliente)
- `Cancelado`: baja definitiva — puede disparar OrdenInstalacion tipo Retiro

### Órdenes de Trabajo

**OrdenInstalacion**:
Registro formal de una visita técnica vinculada a un Servicio. Tiene tipo `Instalacion` o `Retiro`. Al completarse, genera movimientos en el Kardex en transacción atómica.
_Avoid_: ticket, visita, trabajo

**TipoOrden**:
`Instalacion` → genera MovimientosInventario de Salida.
`Retiro` → genera MovimientosInventario de Entrada (equipos regresan al stock).

**DetalleOrden**:
Lista de productos con cantidades reales asignados a una OrdenInstalacion. Pre-poblada desde PlantillaEquipo del Plan; el operador NOC puede ajustar antes de confirmar.
_Avoid_: materiales, lista de equipos

### Taller (RMA)

**TicketTaller**:
Registro de equipo de cliente recibido en oficina para reparación o diagnóstico. Standalone: NO genera OrdenTrabajo ni Servicio. Estados: `Recibido → Diagnostico → EsperandoPieza → Listo → Entregado` (o `Cancelado`).
_Avoid_: orden de taller, ticket de soporte (confunde con OT)

**codigoPin**:
String alfanumérico único de 6 chars (alphabet sin 0/O/1/I para evitar ambigüedad). Funciona como credencial de tracking público en `/track/:pin` (rate-limited a 10 req/min/IP). Se entrega al cliente impreso/SMS al recibir su equipo.

### Bóveda PAM (CredencialCliente)

**CredencialCliente**:
Password de equipo en cliente (NVR, router, switch, NVR, cámara, server). Cifrado AES-256-GCM reversible con `VAULT_KEY` de `.env`. Campo `passwordEnc` (ciphertext base64) + `passwordIv` (IV único). Revelación bajo demanda en `/api/credenciales/:id/reveal`, auditada en `auditLog`.
_Avoid_: vault, contraseña hash (no es hash, es cifrado simétrico)

### CMDB (ActivoCliente)

**ActivoCliente**:
Equipo físico instalado en cliente. FK a `Producto` (catálogo de Kardex) y `Cliente`. Se crea automáticamente al cerrar `OrdenTrabajo` tipo `Instalacion`/`CCTV`/`Reparacion` por cada línea con `productoId`. Permite edición manual desde la pestaña "Activos" del cliente. Lleva `finGarantia` derivada de `OT.garantiaDias`.
_Avoid_: activo, asset, inventario del cliente

### Préstamos (EquipoPrestamo)

**EquipoPrestamo**:
Equipo de ACR cedido temporalmente a cliente. Por defecto 15 días. Al crear: descuenta del Kardex (`MovimientoInventario` tipo Salida). Al devolver: incrementa Kardex (`Entrada`). Si pasa `fechaLimite` sin devolución → flag visual `vencido` (sin acción automática). No factura solo: la decisión de cobrar pérdida queda en Carmelo.
_Avoid_: loan, comodato (sí jurídicamente, pero el sistema usa Préstamo)

### Seguridad

**SessionToken (sesión única)**:
Una sola sesión activa por `Empleado`. Login elimina todos los `SessionToken` anteriores del usuario. JWT TTL = 30 min con sliding refresh: el middleware re-firma el cookie cuando quedan < 15 min y actualiza `SessionToken.expiresAt`. Inactividad 30 min → expira → logout forzado.
_Avoid_: multi-device login, refresh token (no usamos refresh tokens, es sliding del mismo JWT)

**IpBlock**:
Bloqueo temporal de IP por intentos fallidos en `/api/track/:pin`. Tally en memoria: 5 fallos (404 o regex inválido) en 5 min → INSERT IpBlock con expiración 30 min. Cache de bloqueos activos en memoria, hidratada al startup desde DB. Middleware retorna 429 antes de tocar handler.

**checkout / webhook Azul**:
`/api/portal/checkout` (login requerido) valida items, calcula total + ITBIS, crea `Factura(Borrador)` con `noFactura=PAGO-XXXXXX` y devuelve `paymentRef` al frontend. La pasarela redirige al cliente al gateway Azul. Al confirmar, Azul envía webhook firmado HMAC-SHA256 a `/api/webhooks/azul`. Si firma válida + monto coincide + estadoPago=aprobado: Factura→Pagada, auto-crea OT(Pendiente) si hay items instalables (CCTV/Redes/CercoElectrico). NCF se asigna solo al emitir, no en checkout.
_Avoid_: payment, transacción (en el sistema es Factura+webhook, no una entidad Pago separada)

### Inventario (Kardex)

**Kardex**:
Registro histórico de todos los movimientos de inventario (entradas y salidas) de cada Producto. Permite stock negativo para no bloquear operaciones cuando equipos se instalan antes de ser registrados formalmente.
_Avoid_: inventario (término ambiguo — usar Kardex para el historial, stock para la cantidad actual)

**MovimientoInventario**:
Registro atómico de una entrada o salida de un Producto del Kardex. Referencia opcional a la OrdenInstalacion que lo originó para trazabilidad y auditoría. También usado por `EquipoPrestamo` (Salida al prestar, Entrada al devolver).

**Canibalización (`Producto.esCanibalizado`)**:
Flag booleano en `Producto`. Cuando `true`: la pieza es de deshuese (RAM usada, fuente vieja, etc.), no se muestra en POS/Catálogo público, pero sí en Inventario con filtro "Canibalizados" y es usable en líneas de OT sin afectar el COGS oficial. Costo y precio se manejan a $0.
_Avoid_: parte recuperada, refurbished (estos podrían venderse; canibalizado es solo para uso interno)

## Relationships

- Un **Cliente** tiene cero o más **Servicios** activos de tipos distintos e independientes entre sí
- Un **Servicio** referencia un **Plan** y puede personalizar precios respecto a su base
- Un **Plan** tiene una **PlantillaEquipo** con los productos típicos de su instalación
- Un **Servicio** tiene a lo sumo una **OrdenInstalacion** activa a la vez
- Una **OrdenInstalacion** genera uno o más **MovimientosInventario** al completarse
- Un **MovimientoInventario** referencia opcionalmente la **OrdenInstalacion** que lo originó
- Una **OrdenInstalacion** se asigna a exactamente un **Empleado** (técnico interno)

## Example dialogue

> **Dev:** "Al crear un Servicio de tipo WISP para un cliente, ¿cuándo se descuenta el inventario?"
> **Domain expert:** "No al crearlo — recién cuando el operador completa la OrdenInstalacion. Primero el servicio queda en Pendiente, luego EnInstalacion cuando se despacha la orden, y Activo cuando el técnico termina y el operador confirma."

> **Dev:** "¿Qué pasa si el stock de un equipo está en cero y hay que instalar?"
> **Domain expert:** "Se instala igual y el Kardex queda negativo. Nosotros compramos de urgencia y lo registramos después. El sistema avisa pero no bloquea."

## Flagged ambiguities

- `tipoServicio` existía como campo libre en `Cliente` y en `Servicio` — resuelto: eliminado de `Cliente`, convertido a enum `TipoServicio` en `Plan`, se deriva de los Servicios activos del Cliente.
- `planOEquipo: String` en `Servicio` era texto libre — resuelto: reemplazado por FK a `Plan`.
