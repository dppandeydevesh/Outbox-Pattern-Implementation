#!/usr/bin/env node
/**
 * processOutboxBatch.js
 *
 * Standalone Node.js script invoked by process_outbox.sh.
 * Connects to MongoDB, runs one batch of outbox processing, then exits.
 *
 * Usage:
 *   node scripts/processOutboxBatch.js --batchSize 20 --mongoUri mongodb://...
 */
const mongoose = require('mongoose');
const path = require('path');

// Resolve paths relative to project root
const projectRoot = path.resolve(__dirname, '..');
process.chdir(projectRoot);

// ── Parse CLI args ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (name, def) => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : def;
};
const BATCH_SIZE = parseInt(getArg('batchSize', '20'));
const MONGO_URI  = getArg('mongoUri', process.env.MONGO_URI || 'mongodb://localhost:27017/outbox_demo');

// ── Load models ────────────────────────────────────────────────────────────────
const { OutboxEntry }   = require('../src/models/OutboxEntry');
const { ProcessedEvent } = require('../src/models/ProcessedEvent');
const { EventBus }      = require('../src/services/eventBus');
const { logger }        = require('../src/services/logger');

// ── Idempotent publish ─────────────────────────────────────────────────────────
async function publishIdempotent(entry, eventBus) {
  const { eventId, eventType, topic } = entry;

  // Check idempotency registry
  const alreadyDone = await ProcessedEvent.exists({ eventId });
  if (alreadyDone) {
    logger.warn(`[batch] Skipping duplicate: ${eventId}`);
    return 'skipped';
  }

  // Publish
  await eventBus.publish({
    topic,
    eventId,
    eventType,
    aggregateId:   entry.aggregateId,
    aggregateType: entry.aggregateType,
    version:       entry.version,
    payload:       entry.payload,
    occurredAt:    entry.occurredAt,
    correlationId: entry.correlationId,
  });

  // Record in idempotency registry
  await ProcessedEvent.create({ eventId, eventType, topic, processedAt: new Date() });

  return 'published';
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  await mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  logger.info(`[batch] Connected to MongoDB. Batch size: ${BATCH_SIZE}`);

  const eventBus = new EventBus();
  const session  = await mongoose.startSession();

  // Claim batch
  session.startTransaction();
  let entries;
  try {
    entries = await OutboxEntry.claimBatch(BATCH_SIZE, session);
    await session.commitTransaction();
  } catch (e) {
    await session.abortTransaction();
    throw e;
  } finally {
    session.endSession();
  }

  logger.info(`[batch] Claimed ${entries.length} entries for processing`);

  let published = 0, skipped = 0, failed = 0;

  for (const entry of entries) {
    try {
      const outcome = await publishIdempotent(entry, eventBus);

      await OutboxEntry.findByIdAndUpdate(entry._id, {
        status: 'PUBLISHED',
        publishedAt: new Date(),
      });

      if (outcome === 'skipped') skipped++;
      else published++;

    } catch (err) {
      failed++;
      const newRetry = (entry.retryCount || 0) + 1;
      const newStatus = newRetry >= (entry.maxRetries || 5) ? 'FAILED' : 'PENDING';
      await OutboxEntry.findByIdAndUpdate(entry._id, {
        status: newStatus,
        retryCount: newRetry,
        errorMessage: err.message,
        lastAttemptAt: new Date(),
      });
      logger.error(`[batch] ${entry.eventId} → ${newStatus}: ${err.message}`);
    }
  }

  logger.info(`[batch] Done — published:${published} skipped:${skipped} failed:${failed}`);

  await mongoose.connection.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('[batch] Fatal error:', err.message);
  process.exit(1);
});
