// =============================================================================
// migrations/002_add_retry_index.js
// Schema version: outbox-schema-v2
// Description: Add compound index optimising retry queries
// =============================================================================

print("Migration 002: Adding retry optimisation index...");

// Optimises the publisher's retry query:
// { status: 'PENDING', retryCount: { $lt: maxRetries } }
db.outbox_entries.createIndex(
  { status: 1, retryCount: 1, createdAt: 1 },
  { name: "status_retry_query" }
);

// Partial index: only index FAILED entries (keeps index small)
db.outbox_entries.createIndex(
  { aggregateId: 1, createdAt: -1 },
  { partialFilterExpression: { status: "FAILED" }, name: "failed_by_aggregate" }
);

print("Migration 002: Complete ✓");
