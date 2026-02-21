#!/usr/bin/env bash
# =============================================================================
# process_outbox.sh
#
# Ensures ALL pending outbox entries are processed.
# Designed to be run as a cron job or one-off recovery tool.
#
# UNIX ATOMIC WRITE PATTERN:
#   - State is written to a temp file first, then atomically renamed
#   - This ensures the process state file is never in a partial/corrupt state
#   - Equivalent to: write(tmp) → fsync(tmp) → rename(tmp, final)
#
# Features:
#   - Lock file (prevents concurrent runs)
#   - Atomic state writes via temp file + rename
#   - Run report written atomically after completion
#   - Exit code: 0 = success, 1 = error, 2 = lock conflict
#
# Usage:
#   ./scripts/process_outbox.sh [--dry-run] [--verbose]
#
# Environment:
#   MONGO_URI          MongoDB connection string (default: localhost)
#   OUTBOX_BATCH_SIZE  How many entries to process per Node invocation
#   OUTBOX_MAX_LOOPS   Safety cap on processing loops (default: 100)
# =============================================================================

set -euo pipefail

# ─── Config ───────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="${PROJECT_DIR}/logs"
RUN_DIR="${PROJECT_DIR}/tmp"
LOCK_FILE="${RUN_DIR}/outbox.lock"
STATE_FILE="${RUN_DIR}/outbox_state.json"
REPORT_FILE="${LOG_DIR}/outbox_report_$(date +%Y%m%d_%H%M%S).json"

MONGO_URI="${MONGO_URI:-mongodb://localhost:27017/outbox_demo}"
OUTBOX_BATCH_SIZE="${OUTBOX_BATCH_SIZE:-20}"
OUTBOX_MAX_LOOPS="${OUTBOX_MAX_LOOPS:-100}"
DRY_RUN=false
VERBOSE=false

# ─── Parse Args ──────────────────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --dry-run)  DRY_RUN=true  ;;
    --verbose)  VERBOSE=true  ;;
  esac
done

# ─── Helpers ──────────────────────────────────────────────────────────────────
log()  { echo "[$(date '+%H:%M:%S')] $*"; }
vlog() { $VERBOSE && echo "[$(date '+%H:%M:%S')] [VERBOSE] $*" || true; }
err()  { echo "[$(date '+%H:%M:%S')] [ERROR] $*" >&2; }

# ─── Setup Dirs ───────────────────────────────────────────────────────────────
mkdir -p "$LOG_DIR" "$RUN_DIR"

# ─── Lock File (prevent concurrent runs) ──────────────────────────────────────
acquire_lock() {
  if [ -f "$LOCK_FILE" ]; then
    local pid
    pid=$(cat "$LOCK_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      err "Another outbox processor is running (PID $pid). Exiting."
      exit 2
    else
      log "Stale lock file found (PID $pid no longer running). Removing."
      rm -f "$LOCK_FILE"
    fi
  fi
  echo $$ > "$LOCK_FILE"
  vlog "Lock acquired (PID $$)"
}

release_lock() {
  rm -f "$LOCK_FILE"
  vlog "Lock released"
}

trap release_lock EXIT

# ─── Atomic State Write ────────────────────────────────────────────────────────
# Unix atomic write: write to .tmp → fsync → rename → final file
# This ensures STATE_FILE is never partially written.
write_state_atomic() {
  local tmp_file="${STATE_FILE}.tmp.$$"
  cat > "$tmp_file" << EOF
{
  "pid": $$,
  "startedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "status": "$1",
  "loopCount": ${2:-0},
  "processedCount": ${3:-0}
}
EOF
  # fsync equivalent in bash: use sync on supported systems
  sync "$tmp_file" 2>/dev/null || true
  # Atomic rename — succeeds or fails atomically, never partial
  mv -f "$tmp_file" "$STATE_FILE"
  vlog "State written atomically to $STATE_FILE"
}

# ─── Get Pending Count (via mongosh) ──────────────────────────────────────────
get_pending_count() {
  mongosh --quiet --eval \
    "db.outbox_entries.countDocuments({status:'PENDING'})" \
    "$MONGO_URI" 2>/dev/null || echo "0"
}

# ─── Requeue Stuck PROCESSING Entries ─────────────────────────────────────────
requeue_stuck() {
  local stuck_threshold_mins=10
  log "Requeueing entries stuck in PROCESSING for > ${stuck_threshold_mins} min..."
  mongosh --quiet --eval "
    const cutoff = new Date(Date.now() - ${stuck_threshold_mins} * 60 * 1000);
    const result = db.outbox_entries.updateMany(
      { status: 'PROCESSING', lastAttemptAt: { \$lt: cutoff } },
      { \$set: { status: 'PENDING' } }
    );
    print('Requeued: ' + result.modifiedCount);
  " "$MONGO_URI" 2>/dev/null || log "mongosh not available — skipping requeue"
}

# ─── Run Node Outbox Processor ─────────────────────────────────────────────────
run_node_processor() {
  if $DRY_RUN; then
    log "[DRY RUN] Would process ${OUTBOX_BATCH_SIZE} outbox entries"
    return 0
  fi
  node "$PROJECT_DIR/scripts/processOutboxBatch.js" \
    --batchSize "$OUTBOX_BATCH_SIZE" \
    --mongoUri  "$MONGO_URI"
}

# ─── Write Final Report Atomically ────────────────────────────────────────────
write_report_atomic() {
  local tmp_report="${REPORT_FILE}.tmp.$$"
  cat > "$tmp_report" << EOF
{
  "generatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "dryRun": $DRY_RUN,
  "loopsCompleted": $LOOP_COUNT,
  "totalProcessed": $TOTAL_PROCESSED,
  "durationSeconds": $DURATION,
  "finalPendingCount": $FINAL_PENDING
}
EOF
  sync "$tmp_report" 2>/dev/null || true
  mv -f "$tmp_report" "$REPORT_FILE"
  log "Report written atomically: $REPORT_FILE"
}

# ─── Main ─────────────────────────────────────────────────────────────────────
main() {
  local start_time
  start_time=$(date +%s)

  log "========================================"
  log "Outbox Processor Started"
  log "  DRY_RUN:    $DRY_RUN"
  log "  BATCH_SIZE: $OUTBOX_BATCH_SIZE"
  log "  MAX_LOOPS:  $OUTBOX_MAX_LOOPS"
  log "  MONGO_URI:  $MONGO_URI"
  log "========================================"

  acquire_lock

  # Requeue any entries stuck in PROCESSING
  requeue_stuck

  LOOP_COUNT=0
  TOTAL_PROCESSED=0

  write_state_atomic "running" "$LOOP_COUNT" "$TOTAL_PROCESSED"

  # ── Processing loop: continue until no more PENDING entries ──────────────
  while true; do
    LOOP_COUNT=$((LOOP_COUNT + 1))

    if [ "$LOOP_COUNT" -gt "$OUTBOX_MAX_LOOPS" ]; then
      err "Reached max loops ($OUTBOX_MAX_LOOPS). Stopping as safety measure."
      break
    fi

    local pending_count
    pending_count=$(get_pending_count)
    vlog "Loop $LOOP_COUNT: $pending_count pending entries"

    if [ "$pending_count" -eq 0 ]; then
      log "No more pending entries. Processing complete."
      break
    fi

    log "Loop $LOOP_COUNT: processing up to $OUTBOX_BATCH_SIZE of $pending_count pending entries..."
    run_node_processor || {
      err "Node processor exited with error on loop $LOOP_COUNT"
      write_state_atomic "error" "$LOOP_COUNT" "$TOTAL_PROCESSED"
      exit 1
    }

    TOTAL_PROCESSED=$((TOTAL_PROCESSED + OUTBOX_BATCH_SIZE))
    write_state_atomic "running" "$LOOP_COUNT" "$TOTAL_PROCESSED"

    sleep 0.5  # brief pause between batches
  done

  # ── Final Summary ─────────────────────────────────────────────────────────
  local end_time
  end_time=$(date +%s)
  DURATION=$((end_time - start_time))
  FINAL_PENDING=$(get_pending_count)

  write_state_atomic "completed" "$LOOP_COUNT" "$TOTAL_PROCESSED"
  write_report_atomic

  log "========================================"
  log "Outbox Processing Complete"
  log "  Loops:         $LOOP_COUNT"
  log "  Processed:     ~$TOTAL_PROCESSED entries"
  log "  Final Pending: $FINAL_PENDING"
  log "  Duration:      ${DURATION}s"
  log "========================================"

  if [ "$FINAL_PENDING" -gt 0 ]; then
    err "WARNING: $FINAL_PENDING entries still pending after processing!"
    exit 1
  fi

  exit 0
}

main "$@"
