# TicketTaller separado de OrdenTrabajo

El flujo RMA del taller (cliente trae PC/equipo a la oficina, se diagnostica, se repara, se entrega) vive en una tabla `TicketTaller` independiente de `OrdenTrabajo`, con su propio enum de estados (`Recibido → Diagnostico → EsperandoPieza → Listo → Entregado`).

Se evaluó extender `OrdenTrabajo` con un tipo nuevo `TallerRMA` y campos opcionales (`codigoPin`, `equipo`, `falla`). Se descartó porque contamina OT con nullables específicos del taller (`codigoPin` no aplica a instalaciones de campo, `garantiaDias` no aplica a recepción de equipos), y mezcla dos máquinas de estado distintas. El taller no requiere asignación geográfica, no genera Servicio, y se factura distinto (cobro al entregar, no por instalación).

`TicketTaller` queda standalone: opcionalmente puede generar `Factura` al entregar, pero NO crea `OrdenTrabajo` ni `Servicio` ni `ActivoCliente`. El `codigoPin` alfanumérico de 6 chars (alphabet sin 0/O/1/I) sirve como credencial de tracking público en `/track/:pin` (rate-limited).
