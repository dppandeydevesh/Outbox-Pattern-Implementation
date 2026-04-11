const express = require('express');
const mongoose = require('mongoose');
const path = require('path');

const orderRoutes = require('./routes/orders');
const userRoutes = require('./routes/users');
const outboxRoutes = require('./routes/outbox');
const { errorHandler } = require('./middleware/errorHandler');
const { requestLogger } = require('./middleware/requestLogger');

const app = express();

app.use(express.json());
app.use(requestLogger);
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/orders', orderRoutes);
app.use('/api/users', userRoutes);
app.use('/api/outbox', outboxRoutes);

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    mongoState: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString()
  });
});

app.use(errorHandler);

module.exports = app;