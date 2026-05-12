# Bóveda de credenciales con AES-256-GCM reversible (no bcrypt)

`CredencialCliente` almacena passwords de equipos en cliente (routers, NVRs, switches) cifrados con AES-256-GCM y master key (`VAULT_KEY`) en `.env`. Cada registro guarda `passwordEnc` (ciphertext base64) + `passwordIv` (IV único por registro). El endpoint `/api/credenciales/:id/reveal` descifra bajo demanda y dispara `auditReq('vault:reveal', ...)`.

La alternativa de bcrypt fue descartada porque rompe el caso de uso: el técnico DEBE poder ver el password original cuando regresa a casa del cliente. La alternativa zero-knowledge (clave derivada del password del usuario) fue descartada por complejidad operativa — si el técnico pierde su password de login, la bóveda completa queda inaccesible.

El costo: pérdida o filtración de `VAULT_KEY` compromete toda la bóveda. Mitigación: la key está en `.env` (no commiteada), se rota manualmente con un script de re-cifrado, y todo acceso queda en `auditLog` para forense.
