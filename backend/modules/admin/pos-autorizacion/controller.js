/**
 * backend/modules/admin/pos-autorizacion/controller.js
 */

function createPosAutorizacionController({ service, schemas }) {
  if (!service) throw new Error('createPosAutorizacionController: service required');
  if (!schemas) throw new Error('createPosAutorizacionController: schemas required');

  function _reqMeta(req) {
    return {
      ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null,
      ua: req.headers['user-agent'] || null,
    };
  }

  function _enviarError(res, err) {
    if (err?.name === 'ZodError') {
      return res.status(400).json({ error: 'VALIDATION_ERROR', detalles: err.errors });
    }
    if (err?.status && err?.code) {
      return res.status(err.status).json({ error: err.code, mensaje: err.message });
    }
    return res.status(500).json({ error: 'INTERNAL', mensaje: 'Error interno del servidor.' });
  }

  async function postTotp(req, res) {
    try {
      const dto = schemas.totpSchema.parse(req.body || {});
      const out = await service.verifyTotp(dto, req.user, _reqMeta(req));
      res.status(200).json(out);
    } catch (err) { _enviarError(res, err); }
  }

  async function postWebhookRequest(req, res) {
    try {
      const dto = schemas.webhookRequestSchema.parse(req.body || {});
      const out = await service.requestWebhook(dto, req.user, _reqMeta(req));
      res.status(202).json(out);
    } catch (err) { _enviarError(res, err); }
  }

  async function postWebhookApprove(req, res) {
    try {
      // El endpoint NO exige JWT — la autenticación va por HMAC del body.
      const dto = schemas.webhookApproveSchema.parse({
        challengeId: req.params.id,
        signature:   req.body?.signature,
        decision:    req.body?.decision,
      });
      const out = await service.approveWebhook(dto, _reqMeta(req));
      res.status(200).json(out);
    } catch (err) { _enviarError(res, err); }
  }

  async function getWebhookStatus(req, res) {
    try {
      const { id } = schemas.webhookStatusParamsSchema.parse(req.params);
      const out = await service.statusWebhook({ challengeId: id }, req.user);
      res.status(200).json(out);
    } catch (err) { _enviarError(res, err); }
  }

  return { postTotp, postWebhookRequest, postWebhookApprove, getWebhookStatus };
}

module.exports = createPosAutorizacionController;
