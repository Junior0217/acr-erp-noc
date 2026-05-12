# Sesión única por usuario con JWT sliding de 30 min

Cada empleado puede tener una sola sesión activa: al hacer login, se eliminan todos los `SessionToken` previos del usuario. JWT TTL = 30 min con sliding refresh — el middleware `verificarJWT` re-firma el token (mismo `jti`, nuevo `exp`) cuando le quedan < 15 min de vida, y actualiza `SessionToken.expiresAt`. Si el usuario está inactivo 30 min, el JWT expira naturalmente y la sesión se cierra del lado del cliente.

Se descartó "N sesiones permitidas + revocación manual": permitía el escenario explícito que Carmelo quiere evitar (técnico con cuenta abierta en campo y otra alguien manipulando facturas en oficina). Se descartó "client-side idle timer puro": no resiste manipulación del frontend ni se aplica si el usuario abre Postman con la cookie copiada.

Trade-off aceptado: si el técnico abre el ERP en su móvil mientras camina al cliente, su PC en oficina queda invalidada inmediatamente. Es agresivo, pero alineado con la postura de "cero ambigüedad" del CISO. La re-autenticación toma ~5 seg con WebAuthn/password.
