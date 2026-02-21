#!/usr/bin/env bash
# =============================================================================
# health_check.sh
# Checks outbox health: pending count, failed entries, publisher heartbeat.
# Returns exit code 0 if healthy, 1 if degraded.
# =============================================================================

set -euo pipefail

MONGO_URI="${MONGO_URI:-mongodb://localhost:27017/outbox_demo}"
MAX_PENDING="${MAX_PENDING_ALERT:-100}"
MAX_FAILED="${MAX_FAILED_ALERT:-10}"
API_URL="${API_URL:-http://localhost:3000}"
HEALTHY=true

check() {
  local name="$1"
  local result="$2"
  local ok="$3"
  if [ "$ok" = "true" ]; then
    echo "  ✅ $name: $result"
  else
    echo "  ❌ $name: $result"
    HEALTHY=false
  fi
}

echo ""
echo "═══════════════════════════════════════"
echo "   Outbox Pattern — Health Check"
echo "   $(date '+%Y-%m-%d %H:%M:%S')"
echo "═══════════════════════════════════════"
echo ""

# ── MongoDB Connectivity ──────────────────────────────────────────────────────
echo "[ MongoDB ]"
if mongosh --quiet --eval "db.adminCommand('ping')" "$MONGO_URI" &>/dev/null; then
  check "connectivity" "connected" "true"
else
  check "connectivity" "UNREACHABLE" "false"
fi

# ── Outbox Stats ──────────────────────────────────────────────────────────────
echo ""
echo "[ Outbox Entries ]"

PENDING=$(mongosh --quiet --eval \
  "db.outbox_entries.countDocuments({status:'PENDING'})" "$MONGO_URI" 2>/dev/null || echo "N/A")

PROCESSING=$(mongosh --quiet --eval \
  "db.outbox_entries.countDocuments({status:'PROCESSING'})" "$MONGO_URI" 2>/dev/null || echo "N/A")

FAILED=$(mongosh --quiet --eval \
  "db.outbox_entries.countDocuments({status:'FAILED'})" "$MONGO_URI" 2>/dev/null || echo "N/A")

PUBLISHED=$(mongosh --quiet --eval \
  "db.outbox_entries.countDocuments({status:'PUBLISHED'})" "$MONGO_URI" 2>/dev/null || echo "N/A")

echo "  📊 PENDING:    $PENDING"
echo "  📊 PROCESSING: $PROCESSING"
echo "  📊 PUBLISHED:  $PUBLISHED"
echo "  📊 FAILED:     $FAILED"

# Alert thresholds
if [[ "$PENDING" =~ ^[0-9]+$ ]]; then
  [ "$PENDING" -lt "$MAX_PENDING" ] && \
    check "pending below threshold ($MAX_PENDING)" "$PENDING" "true" || \
    check "pending ABOVE threshold ($MAX_PENDING)" "$PENDING" "false"
fi

if [[ "$FAILED" =~ ^[0-9]+$ ]]; then
  [ "$FAILED" -lt "$MAX_FAILED" ] && \
    check "failed below threshold ($MAX_FAILED)" "$FAILED" "true" || \
    check "failed ABOVE threshold ($MAX_FAILED)" "$FAILED" "false"
fi

# ── API Health ────────────────────────────────────────────────────────────────
echo ""
echo "[ API Server ]"
if curl -sf "${API_URL}/health" &>/dev/null; then
  check "API /health" "responding" "true"
else
  check "API /health" "NOT RESPONDING" "false"
fi

# ── Publisher Lock ────────────────────────────────────────────────────────────
echo ""
echo "[ Publisher ]"
LOCK_FILE="./tmp/outbox.lock"
if [ -f "$LOCK_FILE" ]; then
  PID=$(cat "$LOCK_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    check "publisher lock" "active (PID $PID)" "true"
  else
    check "publisher lock" "stale (PID $PID not running)" "false"
  fi
else
  echo "  ℹ️  No publisher lock (publisher not in batch mode)"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════"
if [ "$HEALTHY" = "true" ]; then
  echo "   STATUS: ✅ HEALTHY"
  exit 0
else
  echo "   STATUS: ❌ DEGRADED — see above"
  exit 1
fi
