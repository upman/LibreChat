const express = require('express');
const { logger, runAsTenant } = require('@librechat/data-schemas');
const optionalJwtAuth = require('~/server/middleware/optionalJwtAuth');
const { getBanner } = require('~/models');

const router = express.Router();

router.get('/', optionalJwtAuth, async (req, res) => {
  try {
    const tenantId = req.user?.tenantId;
    if (tenantId) {
      return res.status(200).send(await runAsTenant(tenantId, () => getBanner(req.user)));
    }
    res.status(200).send(await getBanner(req.user));
  } catch (error) {
    logger.error('[getBanner] Error getting banner', error);
    res.status(500).json({ message: 'Error getting banner' });
  }
});

module.exports = router;
