/**
 * OutboxService
 *
 * Provides a single write method that wraps business logic and outbox
 * entry creation inside a MongoDB multi-document session (transaction).
 * This guarantees atomic writes: either BOTH the domain document AND the
 * outbox entry are persisted, or NEITHER is — ensuring zero message loss.
 *
 * Unix Atomic Write analogy:
 *   write(tmpFile) → rename(tmpFile, finalFile)
 * Here:
 *   session.startTransaction() → operations → session.commitTransaction()
 */
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const { OutboxEntry } = require('../models/OutboxEntry');
const { logger } = require('./logger');

class OutboxService {
  /**
   * Execute a domain operation and write an outbox event in ONE transaction.
   *
   * @param {Object} opts
   * @param {Function} opts.operation  - async fn(session) that mutates business data
   *                                     Must use the passed session for all DB ops.
   * @param {Object}   opts.event      - domain event descriptor
   * @param {string}   opts.event.aggregateId
   * @param {string}   opts.event.aggregateType
   * @param {string}   opts.event.eventType
   * @param {number}   [opts.event.version]
   * @param {Object}   opts.event.payload
   * @param {string}   opts.event.topic
   * @param {string}   [opts.event.correlationId]
   * @returns {*} result of opts.operation
   */
  async executeWithOutbox({ operation, event }) {
    const session = await mongoose.startSession();
    session.startTransaction({
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    });

    try {
      // ── Step 1: Run the business operation ─────────────────────────────
      const result = await operation(session);

      // ── Step 2: Write outbox entry in the same session ──────────────────
      const eventId = uuidv4();
      const outboxEntry = OutboxEntry.buildEntry({
        eventId,
        ...event,
        correlationId: event.correlationId || uuidv4(),
      });

      await outboxEntry.save({ session });
      logger.info(`Outbox entry created: ${eventId} [${event.eventType}]`);

      // ── Step 3: Atomic commit (Unix rename equivalent) ───────────────────
      await session.commitTransaction();
      logger.info(`Transaction committed for event: ${eventId}`);

      return result;

    } catch (err) {
      // ── Rollback — neither business doc nor outbox entry is saved ────────
      await session.abortTransaction();
      logger.error(`Transaction aborted: ${err.message}`);

      // Handle idempotency key violation gracefully
      if (err.code === 11000 && err.keyPattern?.aggregateId) {
        logger.warn(`Duplicate event suppressed (idempotency guard): ${err.message}`);
        throw Object.assign(new Error('Duplicate event — already recorded'), { code: 'DUPLICATE_EVENT' });
      }
      throw err;

    } finally {
      session.endSession();
    }
  }

  /**
   * Write multiple outbox entries within a single transaction.
   * Useful for domain operations that emit more than one event.
   */
  async executeWithMultipleEvents({ operation, events }) {
    const session = await mongoose.startSession();
    session.startTransaction({
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    });

    try {
      const result = await operation(session);

      const correlationId = uuidv4();
      for (const event of events) {
        const entry = OutboxEntry.buildEntry({
          eventId: uuidv4(),
          correlationId,
          ...event,
        });
        await entry.save({ session });
        logger.info(`Outbox entry created: ${entry.eventId} [${event.eventType}]`);
      }

      await session.commitTransaction();
      return result;

    } catch (err) {
      await session.abortTransaction();
      logger.error(`Multi-event transaction aborted: ${err.message}`);
      throw err;

    } finally {
      session.endSession();
    }
  }
}

module.exports = { OutboxService };
