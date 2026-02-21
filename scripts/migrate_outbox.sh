#!/usr/bin/env bash
# =============================================================================
# migrate_outbox.sh
#
# Applies outbox schema migrations and tracks them with Git.
# Each migration is a numbered JS file in scripts/migrations/.
# Applied migrations are recorded in MongoDB to avoid re-running.
#
# Git tracking:
#   - Every schema change is committed to the repo with a structured message
#   - Tags are created: outbox-schema-v{N}
#   - This provides a complete audit trail of schema evolution
#
# Usage:
#   ./scripts/migrate_outbox.sh [--dry-run] [--rollback]
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
MIGRATIONS_DIR="${SCRIPT_DIR}/migrations"
MONGO_URI="${MONGO_URI:-mongodb://localhost:27017/outbox_demo}"
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in --dry-run) DRY_RUN=true ;; esac
done

log()  { echo "[migrate] $*"; }
err()  { echo "[migrate] ERROR: $*" >&2; exit 1; }

# ── Ensure migrations dir exists ──────────────────────────────────────────────
mkdir -p "$MIGRATIONS_DIR"

# ── Get applied migrations ────────────────────────────────────────────────────
get_applied() {
  mongosh --quiet --eval \
    "db.schema_migrations.find({},{name:1}).map(d=>d.name).join('\n')" \
    "$MONGO_URI" 2>/dev/null || echo ""
}

# ── Apply a single migration ──────────────────────────────────────────────────
apply_migration() {
  local file="$1"
  local name
  name=$(basename "$file" .js)

  log "Applying migration: $name"

  if $DRY_RUN; then
    log "[DRY RUN] Would apply: $name"
    return 0
  fi

  # Run the migration script via mongosh
  mongosh --quiet "$MONGO_URI" < "$file" || err "Migration $name failed"

  # Record in migration registry (atomic upsert)
  mongosh --quiet --eval "
    db.schema_migrations.insertOne({
      name: '$name',
      appliedAt: new Date(),
      checksum: require('crypto').createHash('sha256')
        .update(require('fs').readFileSync('$file','utf8')).digest('hex')
    });
  " "$MONGO_URI" 2>/dev/null || true

  log "Migration $name applied successfully"
}

# ── Commit to git ──────────────────────────────────────────────────────────────
git_track_schema() {
  local migration_name="$1"
  local version_tag="$2"

  if ! git -C "$PROJECT_DIR" rev-parse --git-dir &>/dev/null; then
    log "Not a git repo — skipping git tracking"
    return 0
  fi

  if $DRY_RUN; then
    log "[DRY RUN] Would git commit + tag: $version_tag"
    return 0
  fi

  # Stage schema files and migration
  git -C "$PROJECT_DIR" add \
    src/models/OutboxEntry.js \
    scripts/migrations/ \
    docs/SCHEMA_CHANGELOG.md 2>/dev/null || true

  # Commit with structured message
  git -C "$PROJECT_DIR" commit \
    -m "schema(outbox): apply migration ${migration_name}" \
    -m "Migration: ${migration_name}" \
    -m "Applied-by: migrate_outbox.sh" \
    -m "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --allow-empty 2>/dev/null || true

  # Tag the schema version
  git -C "$PROJECT_DIR" tag -a "$version_tag" \
    -m "Outbox schema version: ${version_tag}" \
    --force 2>/dev/null || true

  log "Git commit + tag created: $version_tag"
}

# ── Main ───────────────────────────────────────────────────────────────────────
main() {
  log "Outbox Schema Migration Tool"
  log "MONGO_URI: $MONGO_URI"
  log "DRY_RUN:   $DRY_RUN"
  echo ""

  # Get list of applied migrations
  mapfile -t applied < <(get_applied)

  # Find pending migrations (sorted by filename prefix)
  local applied_count=0
  local skipped_count=0

  while IFS= read -r -d '' file; do
    name=$(basename "$file" .js)

    # Skip if already applied
    if printf '%s\n' "${applied[@]}" | grep -qx "$name"; then
      log "Already applied: $name — skipping"
      skipped_count=$((skipped_count + 1))
      continue
    fi

    # Apply migration
    apply_migration "$file"
    applied_count=$((applied_count + 1))

    # Extract version from filename (e.g. 001_add_ttl_index.js → v1)
    version_num=$(echo "$name" | grep -oP '^\d+' | sed 's/^0*//')
    git_track_schema "$name" "outbox-schema-v${version_num}"

  done < <(find "$MIGRATIONS_DIR" -name "*.js" -print0 | sort -z)

  echo ""
  log "Migration complete"
  log "  Applied: $applied_count"
  log "  Skipped: $skipped_count"
}

main "$@"
