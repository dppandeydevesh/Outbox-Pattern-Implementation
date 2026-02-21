/**
 * OutboxEntry Model
 *
 * Persists domain events alongside business data in the same MongoDB session
 * (multi-document transaction). The outbox publisher reads PENDING entries
 * and publishes them, then marks them PUBLISHED (or FAILED on error).
 *
 * Idempotency key = aggregateId + eventType + version
 * The publisher checks this before writing to prevent duplicate processing.
 */
const mongoose = require('mongoose');

const OutboxEntrySchema = new mongoose.Schema(
  {
    // ── Identity ───────────────────────────────────────────────────────────
    /** UUID v4 — globally unique across all services */
    eventId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    // ── Aggregate Info ─────────────────────────────────────────────────────
    aggregateId:   { type: String, required: true, index: true },
    aggregateType: { type: String, required: true },  // e.g. 'Order', 'User'

    // ── Event Info ─────────────────────────────────────────────────────────
    /** e.g. 'order.created', 'order.shipped', 'user.registered' */
    eventType: { type: String, required: true },
    /** Monotonically increasing per aggregate — used in idempotency checks */
    version:   { type: Number, required: true, default: 1 },
    /** Serialised JSON payload of the domain event */
    payload:   { type: mongoose.Schema.Types.Mixed, required: true },

    // ── Routing ────────────────────────────────────────────────────────────
    /** e.g. 'orders', 'users', 'notifications' */
    topic: { type: String, required: true },

    // ── Status Machine ─────────────────────────────────────────────────────
    /**
     * PENDING   → picked up by publisher → PROCESSING
     * PROCESSING→ success                 → PUBLISHED
     * PROCESSING→ failure (retries < max) → PENDING  (with retryCount++)
     * PROCESSING→ failure (retries ≥ max) → FAILED
     */
    status: {
      type: String,
      enum: ['PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED'],
      default: 'PENDING',
      index: true,
    },

    retryCount:    { type: Number, default: 0 },
    maxRetries:    { type: Number, default: 5 },
    lastAttemptAt: { type: Date },
    publishedAt:   { type: Date },
    errorMessage:  { type: String },

    // ── Metadata ───────────────────────────────────────────────────────────
    /** ISO-8601 wall clock time at the moment the event was raised */
    occurredAt: { type: Date, required: true, default: Date.now },
    /** Correlation/trace id for distributed tracing */
    correlationId: { type: String },
  },
  {
    timestamps: true,          // createdAt + updatedAt
    collection: 'outbox_entries',
  }
);

// ── Compound Indexes ──────────────────────────────────────────────────────────

/** Publisher query: grab all PENDING entries oldest-first */
OutboxEntrySchema.index({ status: 1, createdAt: 1 });

/** Idempotency guard: aggregateId + eventType + version must be unique */
OutboxEntrySchema.index(
  { aggregateId: 1, eventType: 1, version: 1 },
  { unique: true, name: 'idempotency_key' }
);

// ── Schema Version Metadata ────────────────────────────────────────────────────
// Git tag: outbox-schema-v1
// Schema changelog is maintained in docs/SCHEMA_CHANGELOG.md
// To migrate: run scripts/migrate_outbox.sh

// ── Static Helpers ────────────────────────────────────────────────────────────

/**
 * Build a new outbox entry document (does NOT save it).
 * Call inside a Mongoose session/transaction alongside your business document.
 */
OutboxEntrySchema.statics.buildEntry = function ({
  eventId,
  aggregateId,
  aggregateType,
  eventType,
  version = 1,
  payload,
  topic,
  correlationId,
}) {
  return new this({
    eventId,
    aggregateId,
    aggregateType,
    eventType,
    version,
    payload,
    topic,
    correlationId,
  });
};

/**
 * Atomically claim a batch of PENDING entries for processing.
 * Uses findOneAndUpdate with { new: true } inside the session
 * to avoid double-picking by concurrent publisher instances.
 */
OutboxEntrySchema.statics.claimBatch = async function (batchSize, session) {
  const now = new Date();
  const entries = [];

  // Simple sequential claim — for production use a single findAndModify
  // with `$in` on _ids pre-selected, or use MongoDB change streams.
  for (let i = 0; i < batchSize; i++) {
    const entry = await this.findOneAndUpdate(
      { status: 'PENDING' },
      { $set: { status: 'PROCESSING', lastAttemptAt: now } },
      { sort: { createdAt: 1 }, new: true, session }
    );
    if (!entry) break;
    entries.push(entry);
  }
  return entries;
};

const OutboxEntry = mongoose.model('OutboxEntry', OutboxEntrySchema);
module.exports = { OutboxEntry };
