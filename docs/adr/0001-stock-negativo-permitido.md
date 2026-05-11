# Stock negativo permitido en confirmación de OrdenInstalacion

El sistema permite que `Producto.stockActual` quede negativo al confirmar una `OrdenInstalacion`. En la operación diaria de ACR, los técnicos instalan equipos comprados de urgencia antes de que el almacén los registre formalmente. Bloquear la confirmación detendría al operador NOC. Se eligió advertir pero continuar, asumiendo que el inventario se cuadra después via entradas de compra. La alternativa (bloqueo estricto) fue descartada porque rompe el flujo operativo real.
