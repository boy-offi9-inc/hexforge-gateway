#!/usr/bin/env bash
# HexForge Gateway - automated smoke test.
#
# Exercises every subsystem that doesn't require external Android tooling
# (a real device, jadx/apktool/adb/frida binaries, an APK file) end to
# end: workspaces, the filesystem agent, Jobs, Workflows, the Knowledge
# Engine (including the auto-indexer), AI (job + chat, if configured),
# and the Plugin System. Prints a PASS/FAIL/SKIP summary at the end.
#
# What this does NOT test (needs real hardware/binaries/files you have to
# provide - see the "MANUAL TESTING" section this script prints at the
# end): jadx, apktool, adb, frida, apkmcp/MT Manager.
#
# Requires: curl, jq. Uses HEXFORGE_URL (default http://localhost:8080)
# and HEXFORGE_API_KEY (only if the Gateway has AUTH_ENABLED=true) same
# as scripts/hf.sh.
#
# Usage: ./scripts/smoke-test.sh

set -uo pipefail  # NOT -e - a failed check should be recorded and continue, not abort the whole run

HEXFORGE_URL="${HEXFORGE_URL:-http://localhost:8080}"
AUTH_ARGS=()
if [ -n "${HEXFORGE_API_KEY:-}" ]; then
  AUTH_ARGS=(-H "Authorization: Bearer ${HEXFORGE_API_KEY}")
fi

PASS=0
FAIL=0
SKIP=0
FAILED_NAMES=()

command -v curl >/dev/null 2>&1 || { echo "curl is required."; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "jq is required (e.g. 'pkg install jq' on Termux, 'apt install jq' elsewhere)."; exit 1; }

pass() { PASS=$((PASS + 1)); echo "  [PASS] $1"; }
fail() { FAIL=$((FAIL + 1)); FAILED_NAMES+=("$1"); echo "  [FAIL] $1${2:+ - $2}"; }
skip() { SKIP=$((SKIP + 1)); echo "  [SKIP] $1${2:+ - $2}"; }
section() { echo ""; echo "=== $1 ==="; }

# curl wrapper: on transport failure (server unreachable) prints a clear
# message once and exits, rather than letting every remaining check fail
# with a confusing empty-response error.
req() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sf "${AUTH_ARGS[@]}" -X "$method" "${HEXFORGE_URL}${path}")
  [ -n "$body" ] && args+=(-H "Content-Type: application/json" -d "$body")
  curl "${args[@]}"
}

# ---------------------------------------------------------------------------
section "Preflight"

health=$(req GET /health) || { echo "Could not reach ${HEXFORGE_URL}/health - is the Gateway running?"; exit 1; }
pass "Gateway reachable at ${HEXFORGE_URL}"

storage_backend=$(echo "$health" | jq -r '.storageBackend')
ai_provider=$(echo "$health" | jq -r '.aiProvider')
ai_configured=$(echo "$health" | jq -r '.aiConfigured')
auth_enabled=$(echo "$health" | jq -r '.authEnabled')
echo "  storageBackend=${storage_backend}  aiProvider=${ai_provider}  aiConfigured=${ai_configured}  authEnabled=${auth_enabled}"

if [ "$auth_enabled" = "true" ] && [ -z "${HEXFORGE_API_KEY:-}" ]; then
  echo ""
  echo "AUTH_ENABLED is true on the Gateway but HEXFORGE_API_KEY isn't set here - every"
  echo "request below will 401. Set HEXFORGE_API_KEY and re-run."
  exit 1
fi

root=$(req GET /) && pass "GET / (cheat sheet) responds" || fail "GET / (cheat sheet) responds"

# ---------------------------------------------------------------------------
section "Workspace"

WORKSPACE_NAME="smoke-test-$(date +%s)"
ws=$(req PUT "/workspaces/by-name/${WORKSPACE_NAME}" '{"targetLabel": "smoke-test"}') \
  && WORKSPACE_ID=$(echo "$ws" | jq -r '.id') \
  && [ -n "$WORKSPACE_ID" ] && [ "$WORKSPACE_ID" != "null" ] \
  && pass "get-or-create workspace by name" \
  || { fail "get-or-create workspace by name"; echo "Cannot continue without a workspace."; exit 1; }
echo "  workspace: ${WORKSPACE_ID} (${WORKSPACE_NAME})"

ws2=$(req PUT "/workspaces/by-name/${WORKSPACE_NAME}" '{}') \
  && [ "$(echo "$ws2" | jq -r '.id')" = "$WORKSPACE_ID" ] \
  && pass "get-or-create is idempotent (same id on second call)" \
  || fail "get-or-create is idempotent (same id on second call)"

req GET "/workspaces/${WORKSPACE_ID}" >/dev/null && pass "fetch workspace by id" || fail "fetch workspace by id"
req GET "/workspaces" | jq -e ".[] | select(.id == \"${WORKSPACE_ID}\")" >/dev/null 2>&1 \
  && pass "workspace appears in list" || fail "workspace appears in list"

# ---------------------------------------------------------------------------
# POST /workspaces/:id/tasks returns almost immediately with
# status="queued" - orchestrator.dispatch() is fire-and-forget internally
# (execution happens in a detached async call, updates flow via events).
# There's no GET /tasks/:id, so polling means re-listing all tasks for
# the workspace and finding this one by id - same idea as polling a Job
# or Workflow by id, just via the list endpoint instead of a single-item one.
poll_task() {
  local task_id="$1"
  local found="" status=""
  for _ in $(seq 1 20); do
    found=$(req GET "/workspaces/${WORKSPACE_ID}/tasks" | jq -c ".[] | select(.id == \"${task_id}\")")
    status=$(echo "$found" | jq -r '.status // empty')
    [ "$status" = "completed" ] || [ "$status" = "failed" ] && break
    sleep 0.3
  done
  echo "$found"
}

section "Filesystem agent (list/write/read/search/delete - no external tools needed)"

TEST_FILE="smoke-test.txt"
TEST_CONTENT="android.permission.CALL_PHONE smoke-test-marker-$(date +%s)"

write_task_id=$(req POST "/workspaces/${WORKSPACE_ID}/tasks" \
  "$(jq -n --arg fp "$TEST_FILE" --arg c "$TEST_CONTENT" '{agent:"filesystem",operation:"write",payload:{filePath:$fp,content:$c}}')" | jq -r '.id')
write_task=$(poll_task "$write_task_id")
if [ "$(echo "$write_task" | jq -r '.status')" = "completed" ]; then
  pass "filesystem write"
  WRITTEN_PATH=$(echo "$write_task" | jq -r '.result.filePath')
else
  fail "filesystem write" "$(echo "$write_task" | jq -r '.error // "unknown error or task never settled"')"
  WRITTEN_PATH=""
fi

if [ -n "$WRITTEN_PATH" ]; then
  read_task_id=$(req POST "/workspaces/${WORKSPACE_ID}/tasks" \
    "$(jq -n --arg fp "$WRITTEN_PATH" '{agent:"filesystem",operation:"read",payload:{filePath:$fp}}')" | jq -r '.id')
  read_task=$(poll_task "$read_task_id")
  read_content=$(echo "$read_task" | jq -r '.result.content // empty')
  if [ "$read_content" = "$TEST_CONTENT" ]; then
    pass "filesystem read (content round-trips correctly)"
  else
    fail "filesystem read (content round-trips correctly)" "expected '${TEST_CONTENT}', got '${read_content}'"
  fi

  search_dir=$(dirname "$WRITTEN_PATH")
  search_task_id=$(req POST "/workspaces/${WORKSPACE_ID}/tasks" \
    "$(jq -n --arg dp "$search_dir" '{agent:"filesystem",operation:"search",payload:{dirPath:$dp,pattern:"smoke-test-marker-[0-9]+"}}')" | jq -r '.id')
  search_task=$(poll_task "$search_task_id")
  match_count=$(echo "$search_task" | jq -r '.result.matchCount // 0')
  if [ "$match_count" -ge 1 ] 2>/dev/null; then
    pass "filesystem search finds the written content"
  else
    fail "filesystem search finds the written content" "matchCount=${match_count}"
  fi

  delete_task_id=$(req POST "/workspaces/${WORKSPACE_ID}/tasks" \
    "$(jq -n --arg fp "$WRITTEN_PATH" '{agent:"filesystem",operation:"delete",payload:{filePath:$fp}}')" | jq -r '.id')
  delete_task=$(poll_task "$delete_task_id")
  if [ "$(echo "$delete_task" | jq -r '.result.deleted')" = "true" ]; then
    pass "filesystem delete"
  else
    fail "filesystem delete" "$(echo "$delete_task" | jq -r '.error // "unknown error"')"
  fi

  outside_write_id=$(req POST "/workspaces/${WORKSPACE_ID}/tasks" \
    '{"agent":"filesystem","operation":"write","payload":{"filePath":"/tmp/hexforge-smoke-test-should-not-exist.txt","content":"x"}}' | jq -r '.id')
  outside_write=$(poll_task "$outside_write_id")
  if [ "$(echo "$outside_write" | jq -r '.status')" = "failed" ]; then
    pass "filesystem write outside workspace dir is correctly refused"
  else
    fail "filesystem write outside workspace dir is correctly refused" "expected status=failed, got $(echo "$outside_write" | jq -r '.status')"
  fi
else
  skip "filesystem read/search/delete" "write step failed, nothing to operate on"
fi

# ---------------------------------------------------------------------------
section "Job Engine"

job=$(req POST "/workspaces/${WORKSPACE_ID}/jobs" \
  '{"agent":"filesystem","operation":"list","payload":{"dirPath":"."}}')
JOB_ID=$(echo "$job" | jq -r '.id')
if [ -n "$JOB_ID" ] && [ "$JOB_ID" != "null" ]; then
  pass "job submitted"
  for _ in $(seq 1 20); do
    job_status=$(req GET "/jobs/${JOB_ID}" | jq -r '.status')
    [ "$job_status" = "completed" ] || [ "$job_status" = "failed" ] && break
    sleep 0.5
  done
  [ "$job_status" = "completed" ] && pass "job reached completed status" || fail "job reached completed status" "status=${job_status}"
else
  fail "job submitted"
  skip "job status polling" "no job id to poll"
fi

req GET "/workspaces/${WORKSPACE_ID}/jobs" | jq -e ".[] | select(.id == \"${JOB_ID}\")" >/dev/null 2>&1 \
  && pass "job appears in workspace job list" || fail "job appears in workspace job list"

# ---------------------------------------------------------------------------
section "Workflow Engine (also exercises mergePreviousResult and the Knowledge Indexer)"

wf=$(req POST "/workspaces/${WORKSPACE_ID}/workflows" '{
  "name": "smoke-test-workflow",
  "steps": [
    {"agent": "filesystem", "operation": "list", "payload": {"dirPath": "."}},
    {"agent": "filesystem", "operation": "stat", "payload": {"filePath": "."}, "mergePreviousResult": true}
  ]
}')
WORKFLOW_ID=$(echo "$wf" | jq -r '.id')
if [ -n "$WORKFLOW_ID" ] && [ "$WORKFLOW_ID" != "null" ]; then
  pass "workflow submitted"
  for _ in $(seq 1 30); do
    wf_full=$(req GET "/workflows/${WORKFLOW_ID}")
    wf_status=$(echo "$wf_full" | jq -r '.status')
    [ "$wf_status" = "completed" ] || [ "$wf_status" = "failed" ] && break
    sleep 0.5
  done
  if [ "$wf_status" = "completed" ]; then
    pass "workflow reached completed status"
    step_count=$(echo "$wf_full" | jq '[.steps[] | select(.status == "completed")] | length')
    [ "$step_count" = "2" ] && pass "both workflow steps completed" || fail "both workflow steps completed" "only ${step_count}/2 completed"
  else
    fail "workflow reached completed status" "status=${wf_status}"
  fi
else
  fail "workflow submitted"
fi

if [ "${wf_status:-}" = "completed" ]; then
  sleep 1  # give the async knowledge-indexer event listener a moment to fire
  report=$(req GET "/workspaces/${WORKSPACE_ID}/knowledge?type=report" | jq -e ".[] | select(.sourceId == \"${WORKFLOW_ID}\")" 2>/dev/null)
  [ -n "$report" ] && pass "Knowledge Indexer auto-created a report entry for the workflow" \
    || fail "Knowledge Indexer auto-created a report entry for the workflow"
fi

# ---------------------------------------------------------------------------
section "Knowledge Engine (manual CRUD)"

entry=$(req POST "/workspaces/${WORKSPACE_ID}/knowledge" '{"type":"note","title":"Smoke test note","content":"created by smoke-test.sh"}')
ENTRY_ID=$(echo "$entry" | jq -r '.id')
[ -n "$ENTRY_ID" ] && [ "$ENTRY_ID" != "null" ] && pass "create knowledge entry" || fail "create knowledge entry"

if [ -n "${ENTRY_ID:-}" ] && [ "$ENTRY_ID" != "null" ]; then
  req GET "/knowledge/${ENTRY_ID}" >/dev/null && pass "fetch knowledge entry by id" || fail "fetch knowledge entry by id"

  updated=$(req PATCH "/knowledge/${ENTRY_ID}" '{"title":"Smoke test note (updated)"}')
  [ "$(echo "$updated" | jq -r '.title')" = "Smoke test note (updated)" ] \
    && pass "update knowledge entry" || fail "update knowledge entry"

  del_status=$(curl -sf -o /dev/null -w "%{http_code}" "${AUTH_ARGS[@]}" -X DELETE "${HEXFORGE_URL}/knowledge/${ENTRY_ID}")
  [ "$del_status" = "204" ] && pass "delete knowledge entry" || fail "delete knowledge entry" "http ${del_status}"
fi

# ---------------------------------------------------------------------------
section "AI (skipped if not configured)"

if [ "$ai_configured" = "true" ]; then
  ai_job=$(req POST "/workspaces/${WORKSPACE_ID}/jobs" \
    '{"agent":"ai","operation":"summarize","payload":{"content":"Say the single word: pong"}}')
  AI_JOB_ID=$(echo "$ai_job" | jq -r '.id')
  if [ -n "$AI_JOB_ID" ] && [ "$AI_JOB_ID" != "null" ]; then
    for _ in $(seq 1 30); do
      ai_job_status=$(req GET "/jobs/${AI_JOB_ID}" | jq -r '.status')
      [ "$ai_job_status" = "completed" ] || [ "$ai_job_status" = "failed" ] && break
      sleep 0.5
    done
    if [ "$ai_job_status" = "completed" ]; then
      pass "ai agent (summarize) job completed"
    else
      ai_error=$(req GET "/jobs/${AI_JOB_ID}" | jq -r '.error // "unknown"')
      fail "ai agent (summarize) job completed" "$ai_error"
    fi
  else
    fail "ai agent (summarize) job submitted"
  fi

  chat_resp=$(req POST "/workspaces/${WORKSPACE_ID}/chat" '{"message":"Reply with the single word: pong"}')
  chat_reply=$(echo "$chat_resp" | jq -r '.reply // empty')
  if [ -n "$chat_reply" ]; then
    pass "chat send + reply"
    log=$(req GET "/workspaces/${WORKSPACE_ID}/chat")
    [ "$(echo "$log" | jq 'length')" -ge 2 ] && pass "chat transcript recorded both turns" \
      || fail "chat transcript recorded both turns"
  else
    fail "chat send + reply" "$(echo "$chat_resp" | jq -r '.error // "no reply field"')"
  fi
else
  skip "ai agent job" "AI_PROVIDER=${ai_provider} not configured (no API key / model set)"
  skip "chat send + reply" "AI_PROVIDER=${ai_provider} not configured"
fi

# ---------------------------------------------------------------------------
section "Plugin System"

plugins=$(req GET /plugins)
echo "$plugins" | jq -e '.[] | select(.name == "example-strings")' >/dev/null 2>&1 \
  && pass "example-strings plugin loaded" || fail "example-strings plugin loaded"
echo "$plugins" | jq -e '.[] | select(.name == "webhook-notifier")' >/dev/null 2>&1 \
  && pass "webhook-notifier plugin loaded" || fail "webhook-notifier plugin loaded"

if command -v strings >/dev/null 2>&1; then
  strings_job=$(req POST "/workspaces/${WORKSPACE_ID}/jobs" \
    "$(jq -n --arg fp "$(command -v strings)" '{agent:"strings",operation:"extract",payload:{filePath:$fp}}')")
  STRINGS_JOB_ID=$(echo "$strings_job" | jq -r '.id')
  for _ in $(seq 1 20); do
    strings_status=$(req GET "/jobs/${STRINGS_JOB_ID}" | jq -r '.status')
    [ "$strings_status" = "completed" ] || [ "$strings_status" = "failed" ] && break
    sleep 0.5
  done
  [ "$strings_status" = "completed" ] && pass "example-strings plugin agent runs end to end" \
    || fail "example-strings plugin agent runs end to end" "status=${strings_status}"
else
  skip "example-strings plugin agent" "\"strings\" binary not found on PATH here"
fi

# ---------------------------------------------------------------------------
section "SUMMARY"
echo "  PASS: ${PASS}   FAIL: ${FAIL}   SKIP: ${SKIP}"
if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "  Failed checks:"
  for name in "${FAILED_NAMES[@]}"; do echo "    - ${name}"; done
fi

cat <<EOF

=== MANUAL TESTING (needs real hardware/binaries this script can't assume) ===

  jadx / apktool:
    hf ws ${WORKSPACE_NAME}
    hf job jadx decompile '{"apkPath": "/absolute/path/to/some.apk"}'
    hf job-status

  adb (needs a connected device/emulator):
    hf job adb devices '{}'

  frida (needs frida-tools + a matching frida-server on the device):
    hf job frida list-processes '{"includeApps": true}'

  apkmcp (Android + MT Manager's APK MCP service running):
    hf job apkmcp list_available_apks '{}'

Workspace "${WORKSPACE_NAME}" (${WORKSPACE_ID}) was left in place - it's
real data (workspace, jobs, workflow, report entry), not deleted after
this run, so you can inspect it:
  hf ws-id ${WORKSPACE_ID}
  hf knowledge
EOF

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
