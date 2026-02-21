/**
 * ProcessedEvent
 *
 * Idempotency registry — stores the eventId of every event that has been
 * successfully published. Before the publisher sends a message, it checks
 * this collection. If the eventId already exists, the event is a duplicate
 * and publishing is skipped.
 *
 * TTL index auto-removes records after 7 days to keep the collection bounded.
 */
const mongoose = require('mongoose');

const ProcessedEventSchema = new mongoose.Schema(
  {
    eventId:     { type: String, required: true, unique: true, index: true },
    eventType:   { type: String, required: true },
    topic:       { type: String, required: true },
    processedAt: { type: Date, required: true, default: Date.now },
  },
  { collection: 'processed_events' }
);

// Auto-expire after 7 days (604800 seconds)
ProcessedEventSchema.index({ processedAt: 1 }, { expireAfterSeconds: 604800 });

const ProcessedEvent = mongoose.model('ProcessedEvent', ProcessedEventSchema);
module.exports = { ProcessedEvent };
