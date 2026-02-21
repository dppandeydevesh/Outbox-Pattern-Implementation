/**
 * Server Entry Point
 * Connects to MongoDB, starts HTTP server, and boots the Outbox Publisher
 */
require('dotenv').config();
const mongoose = require('mongoose');
const app = require('./src/app');
const { OutboxPublisher } = require('./src/services/outboxPublisher');
const { logger } = require('./src/services/logger');

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/outbox_demo';

async function bootstrap() {
  try {
    // ── Connect to MongoDB ───────────────────────────────────────────────────
    await mongoose.connect(MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    logger.info(`MongoDB connected: ${MONGO_URI}`);

    // ── Start HTTP Server ────────────────────────────────────────────────────
    const server = app.listen(PORT, () => {
      logger.info(`HTTP server listening on port ${PORT}`);
    });

    // ── Start Outbox Publisher (polling loop) ────────────────────────────────
    const publisher = new OutboxPublisher({
      pollIntervalMs: parseInt(process.env.OUTBOX_POLL_INTERVAL_MS || '5000'),
      batchSize: parseInt(process.env.OUTBOX_BATCH_SIZE || '10'),
    });
    await publisher.start();

    // ── Graceful Shutdown ────────────────────────────────────────────────────
    const shutdown = async (signal) => {
      logger.info(`${signal} received – shutting down gracefully`);
      await publisher.stop();
      server.close(async () => {
        await mongoose.connection.close();
        logger.info('MongoDB disconnected. Exiting.');
        process.exit(0);
      });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));

  } catch (err) {
    logger.error('Bootstrap failed', err);
    process.exit(1);
  }
}

bootstrap();
