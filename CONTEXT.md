# ACR Networks & Solutions — ERP NOC

Sistema de gestión interna para un proveedor WISP, instalador de CCTV, redes y seguridad electrónica. Cubre clientes, servicios contratados, inventario (Kardex) y órdenes de trabajo técnico.

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

### Inventario (Kardex)

**Kardex**:
Registro histórico de todos los movimientos de inventario (entradas y salidas) de cada Producto. Permite stock negativo para no bloquear operaciones cuando equipos se instalan antes de ser registrados formalmente.
_Avoid_: inventario (término ambiguo — usar Kardex para el historial, stock para la cantidad actual)

**MovimientoInventario**:
Registro atómico de una entrada o salida de un Producto del Kardex. Referencia opcional a la OrdenInstalacion que lo originó para trazabilidad y auditoría.

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
