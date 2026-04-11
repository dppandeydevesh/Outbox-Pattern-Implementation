const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const { OutboxEntry } = require('../models/OutboxEntry');
const { logger } = require('./logger');

class OutboxService {
  async executeWithOutbox({ operation, event }) {
    const session = await mongoose.startSession();
    session.startTransaction({
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    });

    try {
      const result = await operation(session);

      const eventId = uuidv4();
      const outboxEntry = OutboxEntry.buildEntry({
        eventId,
        ...event,
        correlationId: event.correlationId || uuidv4(),
      });

      await outboxEntry.save({ session });
      logger.info('Outbox entry created: ' + eventId + ' [' + event.eventType + ']');

      await session.commitTransaction();
      logger.info('Transaction committed for event: ' + eventId);

      return result;

    } catch (err) {
      await session.abortTransaction();
      logger.error('Transaction aborted: ' + err.message);

      if (err.code === 11000 && err.keyPattern && err.keyPattern.aggregateId) {
        logger.warn('Duplicate event suppressed: ' + err.message);
        const dupErr = new Error('Duplicate event already recorded');
        dupErr.code = 'DUPLICATE_EVENT';
        throw dupErr;
      }
      throw err;

    } finally {
      session.endSession();
    }
  }

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
        logger.info('Outbox entry created: ' + entry.eventId + ' [' + event.eventType + ']');
      }

      await session.commitTransaction();
      return result;

    } catch (err) {
      await session.abortTransaction();
      logger.error('Multi-event transaction aborted: ' + err.message);
      throw err;

    } finally {
      session.endSession();
    }
  }
}

module.exports = { OutboxService };