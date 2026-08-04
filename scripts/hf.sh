#!/usr/bin/env bash
# HexForge Gateway CLI wrapper - remembers ids between commands so you're
# not copy-pasting workspace/job/workflow ids out of every curl response.
#
# State lives in ~/.hexforge/state.env (plain key=value, not JSON) and is
# updated automatically after commands that return a new id.
#
# Requires: curl, jq
#
# If the Gateway has AUTH_ENABLED=true, set HEXFORGE_API_KEY to one of its
# API_KEYS and every command here will send it automatically.
#
# Usage:
#   hf ws <name> [targetLabel]        get-or-create a workspace by name, sets current workspace
#   hf ws-id <id>                     set current workspace to an existing id directly
#   hf ws-show                        print the current workspace's full record
#   hf ws-list                        list every workspace that exists on the server
#
#   hf job <agent> <operation> [json] submit a job against the current workspace, sets current job
#   hf job-status [id]                fetch a job (defaults to current job)
#   hf jobs                           list jobs for the current workspace
#
#   hf wf <name> <stepsJsonArray>     submit a workflow against the current workspace, sets current workflow
#   hf wf-status [id]                 fetch a workflow (defaults to current workflow)
#   hf wfs                            list workflows for the current workspace
#
#   hf knowledge                      list knowledge entries for the current workspace
#   hf summarize <entryId>            AI-summarize a knowledge entry
#   hf chat                           interactive terminal chat with the AI in the current workspace ('exit' or Ctrl+D to quit)
#   hf chat-log                       print the current workspace's full chat transcript
#
#   hf health                         GET /health
#   hf plugins                        GET /plugins
#   hf current                        print current workspace/job/workflow ids
#
# Examples:
#   hf ws clite-analysis
#   hf job jadx decompile '{"apkPath": "/storage/emulated/0/MT2/apks/Clite Dialer_1.0.apk"}'
#   hf job-status
#   hf wf analyze-clite '[{"agent":"jadx","operation":"decompile","payload":{"apkPath":"/path/app.apk"}}]'
#   hf wf-status

set -euo pipefail

HEXFORGE_URL="${HEXFORGE_URL:-http://localhost:8080}"
STATE_DIR="${HOME}/.hexforge"
STATE_FILE="${STATE_DIR}/state.env"

mkdir -p "$STATE_DIR"
touch "$STATE_FILE"
# shellcheck disable=SC1090
source "$STATE_FILE"

# Sent on every request if set - no-op against a Gateway with AUTH_ENABLED=false.
AUTH_ARGS=()
if [ -n "${HEXFORGE_API_KEY:-}" ]; then
  AUTH_ARGS=(-H "Authorization: Bearer ${HEXFORGE_API_KEY}")
fi

save_state() {
  # $1=key $2=value - rewrites the whole file so repeated keys don't pile up
  local key="$1" value="$2"
  grep -v "^${key}=" "$STATE_FILE" > "${STATE_FILE}.tmp" 2>/dev/null || true
  mv "${STATE_FILE}.tmp" "$STATE_FILE"
  echo "${key}=\"${value}\"" >> "$STATE_FILE"
}

require_jq() {
  command -v jq >/dev/null 2>&1 || {
    echo "This command needs jq (e.g. 'pkg install jq' on Termux, 'apt install jq' elsewhere)." >&2
    exit 1
  }
}

require_workspace() {
  if [ -z "${WORKSPACE_ID:-}" ]; then
    echo "No current workspace set. Run: hf ws <name>" >&2
    exit 1
  fi
}

cmd="${1:-}"
shift || true

case "$cmd" in
  ws)
    name="${1:?usage: hf ws <name> [targetLabel]}"
    target="${2:-$name}"
    require_jq
    resp=$(curl -sf "${AUTH_ARGS[@]}" -X PUT "${HEXFORGE_URL}/workspaces/by-name/${name}" \
      -H "Content-Type: application/json" \
      -d "{\"targetLabel\": \"${target}\"}")
    id=$(echo "$resp" | jq -r '.id')
    save_state WORKSPACE_ID "$id"
    echo "$resp" | jq .
    echo "Current workspace: $id ($name)" >&2
    ;;

  ws-id)
    id="${1:?usage: hf ws-id <id>}"
    save_state WORKSPACE_ID "$id"
    echo "Current workspace: $id" >&2
    ;;

  ws-show)
    require_workspace
    curl -sf "${AUTH_ARGS[@]}" "${HEXFORGE_URL}/workspaces/${WORKSPACE_ID}" | (command -v jq >/dev/null && jq . || cat)
    ;;

  ws-list)
    resp=$(curl -sf "${AUTH_ARGS[@]}" "${HEXFORGE_URL}/workspaces")
    if command -v jq >/dev/null; then
      count=$(echo "$resp" | jq 'length')
      if [ "$count" -eq 0 ]; then
        echo "No workspaces yet. Create one: hf ws <name>"
      else
        echo "$resp" | jq -r '.[] | "\(.id)  \(.name)  [\(.status)]"'
      fi
    else
      echo "$resp"
    fi
    ;;

  job)
    require_workspace
    require_jq
    agent="${1:?usage: hf job <agent> <operation> [payloadJson]}"
    operation="${2:?usage: hf job <agent> <operation> [payloadJson]}"
    payload="${3:-{}}"
    resp=$(curl -sf "${AUTH_ARGS[@]}" -X POST "${HEXFORGE_URL}/workspaces/${WORKSPACE_ID}/jobs" \
      -H "Content-Type: application/json" \
      -d "{\"agent\": \"${agent}\", \"operation\": \"${operation}\", \"payload\": ${payload}}")
    id=$(echo "$resp" | jq -r '.id')
    save_state JOB_ID "$id"
    echo "$resp" | jq .
    echo "Current job: $id" >&2
    ;;

  job-status)
    require_jq
    id="${1:-${JOB_ID:-}}"
    [ -n "$id" ] || { echo "No job id given and no current job set." >&2; exit 1; }
    curl -sf "${AUTH_ARGS[@]}" "${HEXFORGE_URL}/jobs/${id}" | jq .
    ;;

  jobs)
    require_workspace
    curl -sf "${AUTH_ARGS[@]}" "${HEXFORGE_URL}/workspaces/${WORKSPACE_ID}/jobs" | (command -v jq >/dev/null && jq . || cat)
    ;;

  wf)
    require_workspace
    require_jq
    name="${1:?usage: hf wf <name> <stepsJsonArray>}"
    steps="${2:?usage: hf wf <name> <stepsJsonArray>}"
    resp=$(curl -sf "${AUTH_ARGS[@]}" -X POST "${HEXFORGE_URL}/workspaces/${WORKSPACE_ID}/workflows" \
      -H "Content-Type: application/json" \
      -d "{\"name\": \"${name}\", \"steps\": ${steps}}")
    id=$(echo "$resp" | jq -r '.id')
    save_state WORKFLOW_ID "$id"
    echo "$resp" | jq .
    echo "Current workflow: $id" >&2
    ;;

  wf-status)
    require_jq
    id="${1:-${WORKFLOW_ID:-}}"
    [ -n "$id" ] || { echo "No workflow id given and no current workflow set." >&2; exit 1; }
    curl -sf "${AUTH_ARGS[@]}" "${HEXFORGE_URL}/workflows/${id}" | jq .
    ;;

  wfs)
    require_workspace
    curl -sf "${AUTH_ARGS[@]}" "${HEXFORGE_URL}/workspaces/${WORKSPACE_ID}/workflows" | (command -v jq >/dev/null && jq . || cat)
    ;;

  knowledge)
    require_workspace
    curl -sf "${AUTH_ARGS[@]}" "${HEXFORGE_URL}/workspaces/${WORKSPACE_ID}/knowledge" | (command -v jq >/dev/null && jq . || cat)
    ;;

  summarize)
    entryId="${1:?usage: hf summarize <entryId>}"
    curl -sf "${AUTH_ARGS[@]}" -X POST "${HEXFORGE_URL}/knowledge/${entryId}/summarize" | (command -v jq >/dev/null && jq . || cat)
    ;;

  chat)
    require_workspace
    require_jq
    echo "Chatting in workspace ${WORKSPACE_ID}. Type 'exit' or press Ctrl+D to quit." >&2
    echo "" >&2
    while true; do
      printf "you> " >&2
      if ! IFS= read -r line; then
        echo "" >&2
        break
      fi
      [ "$line" = "exit" ] || [ "$line" = "quit" ] && break
      [ -z "$line" ] && continue

      # jq -n --arg safely JSON-encodes arbitrary text (quotes, backslashes,
      # newlines) - unlike every other command here, chat input is genuinely
      # free-form, so naive string interpolation into a JSON body would break.
      body=$(jq -n --arg msg "$line" '{message: $msg}')
      resp=$(curl -sf "${AUTH_ARGS[@]}" -X POST "${HEXFORGE_URL}/workspaces/${WORKSPACE_ID}/chat" \
        -H "Content-Type: application/json" -d "$body") || { echo "(request failed - is the Gateway running and is an AI provider configured?)" >&2; continue; }
      reply=$(echo "$resp" | jq -r '.reply // "(no reply field in response)"')
      echo "ai>  $reply"
      echo ""
    done
    ;;

  chat-log)
    require_workspace
    curl -sf "${AUTH_ARGS[@]}" "${HEXFORGE_URL}/workspaces/${WORKSPACE_ID}/chat" | (command -v jq >/dev/null && jq . || cat)
    ;;

  health)
    # No AUTH_ARGS needed - /health is always exempt - but harmless to send anyway.
    curl -sf "${AUTH_ARGS[@]}" "${HEXFORGE_URL}/health" | (command -v jq >/dev/null && jq . || cat)
    ;;

  plugins)
    curl -sf "${AUTH_ARGS[@]}" "${HEXFORGE_URL}/plugins" | (command -v jq >/dev/null && jq . || cat)
    ;;

  current)
    echo "workspace: ${WORKSPACE_ID:-<none>}"
    echo "job:       ${JOB_ID:-<none>}"
    echo "workflow:  ${WORKFLOW_ID:-<none>}"
    ;;

  *)
    sed -n '3,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
    echo ""
    echo "--- current state ---"
    echo "workspace: ${WORKSPACE_ID:-<none - run: hf ws <name>>}"
    echo ""
    echo "--- existing workspaces on ${HEXFORGE_URL} ---"
    curl -sf "${AUTH_ARGS[@]}" "${HEXFORGE_URL}/workspaces" 2>/dev/null | (command -v jq >/dev/null && jq -r 'if length == 0 then "(none yet)" else .[] | "\(.id)  \(.name)  [\(.status)]" end' || cat) \
      || echo "(couldn't reach ${HEXFORGE_URL} - is the Gateway running, and if AUTH_ENABLED=true, is HEXFORGE_API_KEY set?)"
    exit 1
    ;;
esac
