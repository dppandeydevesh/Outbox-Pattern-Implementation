# Outbox Schema Changelog
<!-- Tracked by Git. Each entry corresponds to a git tag: outbox-schema-vN -->

## v2 — `002_add_retry_index.js`
**Tag:** `outbox-schema-v2`
- Added compound index `{status, retryCount, createdAt}` for optimised retry queries
- Added partial index on FAILED entries by aggregateId

## v1 — `001_create_outbox_indexes.js`
**Tag:** `outbox-schema-v1`
- Initial schema: `outbox_entries` collection
- Indexes: `eventId` (unique), `status+createdAt`, `aggregateId+eventType+version` (idempotency key)
- `processed_events` collection with 7-day TTL index
- `schema_migrations` tracking collection
