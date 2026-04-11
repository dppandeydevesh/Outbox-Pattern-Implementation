const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { User } = require('../models/User');
const { OutboxService } = require('../services/outboxService');

const router = express.Router();
const outboxService = new OutboxService();

router.post('/', async (req, res, next) => {
  try {
    const { email, name, role } = req.body;
    if (!email || !name) {
      return res.status(400).json({ error: 'email and name are required' });
    }

    const userId = uuidv4();

    const user = await outboxService.executeWithOutbox({
      operation: async (session) => {
        const [saved] = await User.create(
          [{ userId, email, name, role: role || 'customer', version: 1 }],
          { session }
        );
        return saved;
      },
      event: {
        aggregateId:   userId,
        aggregateType: 'User',
        eventType:     'user.registered',
        version:       1,
        topic:         'users',
        correlationId: req.headers['x-correlation-id'],
        payload: { userId, email, name, role: role || 'customer' },
      },
    });

    res.status(201).json({ success: true, user });

  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Email already registered' });
    }
    next(err);
  }
});

router.get('/:userId', async (req, res, next) => {
  try {
    const user = await User.findOne({ userId: req.params.userId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const users = await User.find().sort({ createdAt: -1 }).limit(50);
    res.json({ users, total: users.length });
  } catch (err) { next(err); }
});

module.exports = router;
