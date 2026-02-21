/**
 * Outbox Admin Routes — monitoring and manual re-processing
 */
const express = require('express');
const { OutboxEntry } = require('../models/OutboxEntry');
const { ProcessedEvent } = require('../models/ProcessedEvent');

const router = express.Router();

// GET /api/outbox — list entries with optional status filter
router.get('/', async (req, res, next) => {
  try {
    const { status, limit = 50, page = 1 } = req.query;
    const filter = {};
    if (status) filter.status = status;

    const entries = await OutboxEntry.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await OutboxEntry.countDocuments(filter);
    res.json({ entries, total, page: parseInt(page) });

  } catch (err) {
    next(err);
  }
});

// GET /api/outbox/stats — aggregate counts by status
router.get('/stats', async (req, res, next) => {
  try {
    const stats = await OutboxEntry.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]);
    const processedCount = await ProcessedEvent.countDocuments();
    res.json({
      outboxStats: stats,
      processedEventsCount: processedCount,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/outbox/:eventId/retry — manually reset a FAILED entry to PENDING
router.post('/:eventId/retry', async (req, res, next) => {
  try {
    const entry = await OutboxEntry.findOneAndUpdate(
      { eventId: req.params.eventId, status: 'FAILED' },
      { $set: { status: 'PENDING', retryCount: 0, errorMessage: null } },
      { new: true }
    );
    if (!entry) return res.status(404).json({ error: 'FAILED entry not found' });
    res.json({ success: true, entry });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/outbox/processed — clear idempotency registry (dev only)
router.delete('/processed', async (req, res, next) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Not allowed in production' });
  }
  try {
    const result = await ProcessedEvent.deleteMany({});
    res.json({ deleted: result.deletedCount });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
