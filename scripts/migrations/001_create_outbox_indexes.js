// =============================================================================
// migrations/001_create_outbox_indexes.js
// Schema version: outbox-schema-v1
// Description: Create outbox_entries collection with required indexes
// Git tag: outbox-schema-v1
// =============================================================================

print("Migration 001: Creating outbox_entries indexes...");

// ── outbox_entries indexes ────────────────────────────────────────────────────

// Unique event identity
db.outbox_entries.createIndex(
  { eventId: 1 },
  { unique: true, name: "eventId_unique" }
);

// Publisher query: PENDING entries, oldest first
db.outbox_entries.createIndex(
  { status: 1, createdAt: 1 },
  { name: "status_createdAt" }
);

// Idempotency key — prevents duplicate events for same aggregate/version
db.outbox_entries.createIndex(
  { aggregateId: 1, eventType: 1, version: 1 },
  { unique: true, name: "idempotency_key" }
);

// Aggregate lookup
db.outbox_entries.createIndex(
  { aggregateId: 1 },
  { name: "aggregateId" }
);

// ── processed_events indexes ───────────────────────────────────────────────────

db.processed_events.createIndex(
  { eventId: 1 },
  { unique: true, name: "eventId_unique" }
);

// TTL: auto-expire after 7 days
db.processed_events.createIndex(
  { processedAt: 1 },
  { expireAfterSeconds: 604800, name: "processedAt_ttl" }
);

// ── schema_migrations ─────────────────────────────────────────────────────────
db.schema_migrations.createIndex(
  { name: 1 },
  { unique: true, name: "migration_name_unique" }
);

print("Migration 001: Complete ✓");
