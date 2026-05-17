/**
 * backend/modules/crm/credenciales/repo.js
 *
 * Capa de datos del Vault. CRÍTICO Cyber Neo:
 *   - listCredenciales: SELECT explícito sin passwordEnc/passwordIv.
 *     Si alguien intenta llamar findMany sin select, los campos cifrados
 *     viajarían al cliente — ese es un vector de ataque pasivo (auditor
 *     malintencionado con permiso vault:ver).
 *   - findCredencialForReveal: SELECT con passwordEnc/Iv, solo invocado
 *     desde service.revelarPassword post-TOTP + cooldown.
 */

function createCredencialesRepo(prisma) {
  if (!prisma) throw new Error('createCredencialesRepo: prisma required');

  /**
   * Listado: NUNCA passwordEnc, passwordIv. Solo metadata.
   * Si querés agregar un campo, asegurate que no exponga material cifrado.
   */
  async function listCredenciales(where) {
    return prisma.credencialCliente.findMany({
      where,
      select: {
        id: true, clienteId: true, tipo: true, nombre: true, ip: true,
        usuario: true, notas: true, createdAt: true, updatedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Lookup para reveal: incluye passwordEnc + passwordIv. Solo el service
   * lo llama tras pasar TOTP + cooldown + permiso vault:reveal.
   */
  async function findCredencialForReveal(id) {
    return prisma.credencialCliente.findUnique({ where: { id } });
  }

  async function createCredencial(data) {
    return prisma.credencialCliente.create({
      data,
      select: {
        id: true, clienteId: true, tipo: true, nombre: true, ip: true,
        usuario: true, notas: true, createdAt: true,
      },
    });
  }

  async function deleteCredencial(id) {
    return prisma.credencialCliente.delete({ where: { id } });
  }

  async function crearIncidenciaBulkAlert(data) {
    return prisma.incidenciaReconciliacion.create({ data });
  }

  return {
    listCredenciales,
    findCredencialForReveal,
    createCredencial,
    deleteCredencial,
    crearIncidenciaBulkAlert,
  };
}

module.exports = createCredencialesRepo;
