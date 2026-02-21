/**
 * Orders API Routes
 *
 * Every write operation uses OutboxService.executeWithOutbox() so that the
 * domain event is written atomically with the Order document.
 */
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { Order } = require('../models/Order');
const { OutboxService } = require('../services/outboxService');

const router = express.Router();
const outboxService = new OutboxService();

// ─── POST /api/orders  — Create a new order ────────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const { customerId, items, shippingAddress, currency = 'USD' } = req.body;

    if (!customerId || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'customerId and items[] are required' });
    }

    const orderId = uuidv4();
    const totalAmount = items.reduce((sum, i) => sum + (i.price * i.quantity), 0);

    const order = await outboxService.executeWithOutbox({
      // ── Business operation: insert Order document ───────────────────────
      operation: async (session) => {
        const [saved] = await Order.create(
          [{ orderId, customerId, items, totalAmount, currency, shippingAddress, version: 1 }],
          { session }
        );
        return saved;
      },
      // ── Domain event written to outbox in the same transaction ──────────
      event: {
        aggregateId:   orderId,
        aggregateType: 'Order',
        eventType:     'order.created',
        version:       1,
        topic:         'orders',
        correlationId: req.headers['x-correlation-id'],
        payload: {
          orderId,
          customerId,
          items,
          totalAmount,
          currency,
          status: 'PENDING',
        },
      },
    });

    res.status(201).json({ success: true, order });

  } catch (err) {
    if (err.code === 'DUPLICATE_EVENT') {
      return res.status(409).json({ error: 'Duplicate order event — already recorded' });
    }
    next(err);
  }
});

// ─── PATCH /api/orders/:orderId/status  — Update order status ─────────────────
router.patch('/:orderId/status', async (req, res, next) => {
  try {
    const { orderId } = req.params;
    const { status } = req.body;

    const validTransitions = ['CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED'];
    if (!validTransitions.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${validTransitions.join(', ')}` });
    }

    const updated = await outboxService.executeWithOutbox({
      operation: async (session) => {
        const order = await Order.findOneAndUpdate(
          { orderId },
          { $set: { status }, $inc: { version: 1 } },
          { new: true, session }
        );
        if (!order) throw Object.assign(new Error('Order not found'), { statusCode: 404 });
        return order;
      },
      event: {
        aggregateId:   orderId,
        aggregateType: 'Order',
        eventType:     `order.${status.toLowerCase()}`,
        topic:         'orders',
        correlationId: req.headers['x-correlation-id'],
        payload: { orderId, status },
      },
    });

    res.json({ success: true, order: updated });

  } catch (err) {
    next(err);
  }
});

// ─── GET /api/orders  — List orders ───────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { customerId, status, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (customerId) filter.customerId = customerId;
    if (status)     filter.status = status;

    const orders = await Order.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await Order.countDocuments(filter);
    res.json({ orders, total, page: parseInt(page), limit: parseInt(limit) });

  } catch (err) {
    next(err);
  }
});

// ─── GET /api/orders/:orderId ──────────────────────────────────────────────────
router.get('/:orderId', async (req, res, next) => {
  try {
    const order = await Order.findOne({ orderId: req.params.orderId });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
