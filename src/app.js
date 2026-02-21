/**
 * Outbox Pattern Implementation - Main Application
 * Express + MongoDB + Reliable Event Publishing
 */
const express = require('express');
const mongoose = require('mongoose');

const orderRoutes = require('./routes/orders');
const userRoutes = require('./routes/users');
const outboxRoutes = require('./routes/outbox');
const { errorHandler } = require('./middleware/errorHandler');
const { requestLogger } = require('./middleware/requestLogger');

const app = express();

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(requestLogger);

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use('/api/orders', orderRoutes);
app.use('/api/users', userRoutes);
app.use('/api/outbox', outboxRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    mongoState: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString()
  });
});

// ─── Error Handler ────────────────────────────────────────────────────────────
app.use(errorHandler);

module.exports = app;
