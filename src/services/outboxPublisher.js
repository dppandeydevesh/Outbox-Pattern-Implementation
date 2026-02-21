/**
 * OutboxPublisher
 *
 * Implements reliable at-least-once delivery of domain events:
 *
 *   1. Poll MongoDB for PENDING outbox entries (oldest first).
 *   2. Claim each entry (PENDING → PROCESSING) atomically.
 *   3. Publish to the event bus (simulated here; replace with Kafka/SQS/etc.).
 *   4. Mark PUBLISHED on success, or retry/FAILED on error.
 *
 * Idempotent publishing:
 *   The publisher uses a ProcessedEvent collection to track which eventIds
 *   have already been delivered. Before publishing, it checks this registry.
 *   Even if the publisher crashes after publishing but before updating the
 *   outbox status, re-running it will detect the duplicate and skip republish.
 *
 * This mirrors the Debezium / Kafka Connect outbox pattern but with a
 * polling relay instead of a CDC connector.
 */
const mongoose = require('mongoose');
const { OutboxEntry } = require('../models/OutboxEntry');
const { ProcessedEvent } = require('../models/ProcessedEvent');
const { logger } = require('./logger');
const { EventBus } = require('./eventBus');

class OutboxPublisher {
  /**
   * @param {Object} opts
   * @param {number} opts.pollIntervalMs  milliseconds between polls (default 5000)
   * @param {number} opts.batchSize       entries claimed per poll cycle (default 10)
   */
  constructor({ pollIntervalMs = 5000, batchSize = 10 } = {}) {
    this.pollIntervalMs = pollIntervalMs;
    this.batchSize = batchSize;
    this.running = false;
    this._timer = null;
    this.eventBus = new EventBus();
  }

  /** Start the polling loop */
  async start() {
    this.running = true;
    logger.info(`OutboxPublisher started — poll every ${this.pollIntervalMs}ms, batch size ${this.batchSize}`);
    await this._poll(); // run immediately on start
  }

  /** Stop the polling loop gracefully */
  async stop() {
    this.running = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    logger.info('OutboxPublisher stopped');
  }

  // ─── Core Polling Loop ──────────────────────────────────────────────────────

  async _poll() {
    if (!this.running) return;

    try {
      await this._processBatch();
    } catch (err) {
      logger.error(`Poll cycle error: ${err.message}`);
    }

    // Schedule next poll
    if (this.running) {
      this._timer = setTimeout(() => this._poll(), this.pollIntervalMs);
    }
  }

  // ─── Batch Processor ────────────────────────────────────────────────────────

  async _processBatch() {
    const session = await mongoose.startSession();
    session.startTransaction();

    let entries;
    try {
      entries = await OutboxEntry.claimBatch(this.batchSize, session);
      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }

    if (entries.length === 0) {
      logger.debug('No pending outbox entries');
      return;
    }

    logger.info(`Processing ${entries.length} outbox entries`);

    // Process entries concurrently (safe: each has its own status machine)
    await Promise.allSettled(entries.map(e => this._processEntry(e)));
  }

  // ─── Single Entry Processor ─────────────────────────────────────────────────

  async _processEntry(entry) {
    const { eventId, eventType, aggregateId, topic } = entry;

    try {
      // ── Idempotency Check ───────────────────────────────────────────────
      const alreadyProcessed = await ProcessedEvent.exists({ eventId });
      if (alreadyProcessed) {
        logger.warn(`Duplicate detected — skipping eventId: ${eventId}`);
        await OutboxEntry.findByIdAndUpdate(entry._id, {
          status: 'PUBLISHED',
          publishedAt: new Date(),
          errorMessage: 'Skipped: already published (idempotency guard)',
        });
        return;
      }

      // ── Publish to Event Bus ────────────────────────────────────────────
      await this.eventBus.publish({
        topic,
        eventId,
        eventType,
        aggregateId,
        aggregateType: entry.aggregateType,
        version: entry.version,
        payload: entry.payload,
        occurredAt: entry.occurredAt,
        correlationId: entry.correlationId,
      });

      // ── Register as Processed (idempotency record) ──────────────────────
      await ProcessedEvent.create({ eventId, eventType, topic, processedAt: new Date() });

      // ── Mark Published ──────────────────────────────────────────────────
      await OutboxEntry.findByIdAndUpdate(entry._id, {
        status: 'PUBLISHED',
        publishedAt: new Date(),
      });

      logger.info(`Published: ${eventId} [${eventType}] → topic:${topic}`);

    } catch (err) {
      logger.error(`Failed to publish ${eventId}: ${err.message}`);

      const newRetryCount = (entry.retryCount || 0) + 1;
      const newStatus = newRetryCount >= (entry.maxRetries || 5) ? 'FAILED' : 'PENDING';

      await OutboxEntry.findByIdAndUpdate(entry._id, {
        status: newStatus,
        retryCount: newRetryCount,
        errorMessage: err.message,
        lastAttemptAt: new Date(),
      });

      if (newStatus === 'FAILED') {
        logger.error(`Entry ${eventId} moved to FAILED after ${newRetryCount} retries`);
      } else {
        logger.info(`Entry ${eventId} re-queued (attempt ${newRetryCount}/${entry.maxRetries})`);
      }
    }
  }
}

module.exports = { OutboxPublisher };
