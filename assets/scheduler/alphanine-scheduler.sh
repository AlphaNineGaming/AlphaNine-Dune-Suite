#!/bin/bash

# AlphaNine Dune Suite VM scheduler.
# This script is installed and managed by the Suite. It deliberately targets
# one configured battlegroup instead of using the interactive Funcom CLI.

set -u
set -o pipefail

# Cron has a deliberately minimal environment on Alpine. Use the operating
# system paths explicitly so the k3s-provided kubectl remains available.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

SCHEDULER_VERSION="1"
ROOT_DIR="${ALPHANINE_SCHEDULER_DIR:-/home/dune/.dune/alphanine-scheduler}"
CONFIG_FILE="$ROOT_DIR/config.json"
STATE_FILE="$ROOT_DIR/state.json"
HISTORY_FILE="$ROOT_DIR/history.jsonl"
LAST_STATUS_FILE="$ROOT_DIR/last-status.json"
LOG_FILE="$ROOT_DIR/scheduler.log"
LOCK_FILE="$ROOT_DIR/scheduler.lock"
MAINTENANCE_HOLD_FILE="${ALPHANINE_MAINTENANCE_HOLD_FILE:-/home/dune/.dune/alphanine-migration-maintenance.json}"
FUNCOM_PREFIX="funcom-seabass-"

mkdir -p "$ROOT_DIR"
touch "$HISTORY_FILE" "$LOG_FILE"

log_line() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG_FILE"
  tail -n 1000 "$LOG_FILE" > "$LOG_FILE.tmp" 2>/dev/null && mv "$LOG_FILE.tmp" "$LOG_FILE"
}

maintenance_active() {
  # Presence is authoritative and fail-closed, including malformed content.
  [ -e "$MAINTENANCE_HOLD_FILE" ]
}

require_config() {
  if [ ! -s "$CONFIG_FILE" ] || ! jq -e . "$CONFIG_FILE" >/dev/null 2>&1; then
    printf '%s\n' "Scheduler configuration is missing or invalid." >&2
    return 1
  fi
}

config_text() {
  jq -r "$1 // \"$2\"" "$CONFIG_FILE"
}

config_number() {
  jq -r "$1 // $2" "$CONFIG_FILE"
}

config_bool() {
  jq -r "$1 // $2" "$CONFIG_FILE"
}

ensure_state() {
  if [ ! -s "$STATE_FILE" ] || ! jq -e . "$STATE_FILE" >/dev/null 2>&1; then
    jq -cn --arg installedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{
      version: 1,
      installedAt: $installedAt,
      lastTickAt: "",
      lastBackupDate: "",
      lastRestartDate: "",
      lastSuccessfulBackupEpoch: 0,
      lastSuccessfulBackupName: "",
      deferredRestartDate: "",
      deferredSinceEpoch: 0
    }' > "$STATE_FILE"
  fi
}

state_update() {
  local filter="$1"
  shift
  if jq "$@" "$filter" "$STATE_FILE" > "$STATE_FILE.tmp"; then
    mv "$STATE_FILE.tmp" "$STATE_FILE"
  else
    rm -f "$STATE_FILE.tmp"
    return 1
  fi
}

record_event() {
  local action="$1"
  local status="$2"
  local message="$3"
  local details="${4-}"
  [ -n "$details" ] || details='{}'
  local event
  if ! printf '%s' "$details" | jq -e . >/dev/null 2>&1; then
    details='{}'
  fi
  event=$(jq -cn \
    --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg action "$action" \
    --arg status "$status" \
    --arg message "$message" \
    --argjson details "$details" \
    '{timestamp:$timestamp,action:$action,status:$status,message:$message,details:$details}')
  printf '%s\n' "$event" >> "$HISTORY_FILE"
  printf '%s\n' "$event" > "$LAST_STATUS_FILE"
  tail -n 200 "$HISTORY_FILE" > "$HISTORY_FILE.tmp" 2>/dev/null && mv "$HISTORY_FILE.tmp" "$HISTORY_FILE"
  log_line "$action [$status] $message"
}

load_runtime_config() {
  require_config || return 1
  ensure_state
  BATTLEGROUP=$(config_text '.battlegroup' '')
  TIMEZONE=$(config_text '.timezone' 'UTC')
  NAMESPACE="$FUNCOM_PREFIX$BATTLEGROUP"
  BACKUP_DIR="/funcom/artifacts/database-dumps/$BATTLEGROUP"
  export TZ="$TIMEZONE"
  if ! printf '%s' "$BATTLEGROUP" | grep -Eq '^[a-z0-9][a-z0-9-]{2,62}$'; then
    printf '%s\n' "Configured battlegroup is invalid." >&2
    return 1
  fi
  if [ ! -e "/usr/share/zoneinfo/$TIMEZONE" ]; then
    printf '%s\n' "Timezone data is unavailable for $TIMEZONE." >&2
    return 1
  fi
}

kubectl_safe() {
  sudo -n kubectl "$@"
}

control_snapshot() {
  local data
  data=$(kubectl_safe get battlegroup "$BATTLEGROUP" -n "$NAMESPACE" -o json 2>/dev/null) || return 1
  printf '%s' "$data" | jq -ce '{resourceVersion:(.metadata.resourceVersion|tostring),generation:(.metadata.annotations["control.alphanine.io/generation"] // "0"),stop:.spec.stop}'
}

guarded_control_patch() {
  local desired_stop="$1" expected_generation="$2" operation_id="$3" reason="$4"
  local before current_generation resource_version timestamp profile_identity battlegroup_identity patch after
  before=$(control_snapshot) || return 1
  current_generation=$(printf '%s' "$before" | jq -r '.generation')
  resource_version=$(printf '%s' "$before" | jq -r '.resourceVersion')
  if [ "$current_generation" != "$expected_generation" ]; then
    record_event "restart" "rejected-stale" "A newer explicit battlegroup control generation superseded this scheduler intent." "$(jq -cn --arg expected "$expected_generation" --arg current "$current_generation" --arg operationId "$operation_id" '{expectedGeneration:$expected,currentGeneration:$current,operationId:$operationId}')"
    return 1
  fi
  timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  profile_identity=$(sha256sum "$CONFIG_FILE" | awk '{print $1}') || return 1
  battlegroup_identity=$(printf '%s' "$NAMESPACE/$BATTLEGROUP" | sha256sum | awk '{print $1}') || return 1
  patch=$(jq -cn --arg rv "$resource_version" --arg generation "$expected_generation" --arg operation "$operation_id" --arg reason "$reason" --arg timestamp "$timestamp" --arg process "scheduler:$$" --arg profile "$profile_identity" --arg battlegroup "$battlegroup_identity" --argjson stop "$desired_stop" '{metadata:{resourceVersion:$rv,annotations:{"control.alphanine.io/generation":$generation,"control.alphanine.io/operation-id":$operation,"control.alphanine.io/reason":$reason,"control.alphanine.io/call-site":"assets/scheduler/alphanine-scheduler.sh:run_restart","control.alphanine.io/process":$process,"control.alphanine.io/timestamp":$timestamp,"control.alphanine.io/profile":$profile,"control.alphanine.io/battlegroup":$battlegroup}},spec:{stop:$stop}}') || return 1
  kubectl_safe patch battlegroup "$BATTLEGROUP" -n "$NAMESPACE" --type=merge -p "$patch" >> "$LOG_FILE" 2>&1 || return 1
  after=$(control_snapshot) || return 1
  if [ "$(printf '%s' "$after" | jq -r '.generation')" != "$expected_generation" ] || [ "$(printf '%s' "$after" | jq -r '.stop')" != "$desired_stop" ]; then
    record_event "restart" "failed" "Scheduler control attribution did not survive the Kubernetes mutation." "$(jq -cn --arg operationId "$operation_id" '{operationId:$operationId}')"
    return 1
  fi
  record_event "control" "applied" "Attributed scheduler battlegroup mutation completed." "$(jq -cn --arg timestamp "$timestamp" --arg operationId "$operation_id" --arg reason "$reason" --arg process "scheduler:$$" --arg oldResourceVersion "$(printf '%s' "$before" | jq -r '.resourceVersion')" --arg newResourceVersion "$(printf '%s' "$after" | jq -r '.resourceVersion')" --arg oldStop "$(printf '%s' "$before" | jq -r '.stop')" --arg newStop "$(printf '%s' "$after" | jq -r '.stop')" --arg generation "$expected_generation" --arg profile "$profile_identity" --arg battlegroup "$battlegroup_identity" '{timestamp:$timestamp,operationId:$operationId,reason:$reason,processIdentity:$process,oldResourceVersion:$oldResourceVersion,newResourceVersion:$newResourceVersion,oldStop:$oldStop,newStop:$newStop,generation:$generation,profileIdentity:$profile,battlegroupIdentity:$battlegroup}')"
}

target_exists() {
  kubectl_safe get namespace "$NAMESPACE" >/dev/null 2>&1 &&
    kubectl_safe get battlegroup "$BATTLEGROUP" -n "$NAMESPACE" >/dev/null 2>&1
}

active_database_operation_count() {
  local data
  data=$(kubectl_safe get databaseoperations -n "$NAMESPACE" -o json 2>/dev/null) || return 1
  printf '%s' "$data" | jq '[.items[] | select((.status.phase // "Pending") != "Succeeded" and (.status.phase // "Pending") != "Failed")] | length'
}

update_process_running() {
  pgrep -f 'steamcmd|battlegroup(.sh)? update|update-from-downloads' >/dev/null 2>&1
}

player_count() {
  local data
  data=$(kubectl_safe get serverstats -n "$NAMESPACE" -o json 2>/dev/null) || return 1
  printf '%s' "$data" | jq '[.items[] | (.status.runtime.players // 0)] | add // 0'
}

health_snapshot() {
  local bg stats
  bg=$(kubectl_safe get battlegroup "$BATTLEGROUP" -n "$NAMESPACE" -o json 2>/dev/null) || return 1
  stats=$(kubectl_safe get serverstats -n "$NAMESPACE" -o json 2>/dev/null) || stats='{"items":[]}'
  # Battlegroup status can exceed Linux's per-argument size limit. Stream both
  # documents into jq instead of passing their JSON through --argjson.
  printf '%s\n%s\n' "$bg" "$stats" | jq -s '.[0] as $bg | .[1] as $stats | {
    phase: ($bg.status.phase // "Unknown"),
    database: ($bg.status.database.phase // "Unknown"),
    gateway: ($bg.status.utilities.serverGateway.phase // "Unknown"),
    director: ($bg.status.utilities.director.phase // "Unknown"),
    serverGroup: ($bg.status.serverGroupPhase // "Unknown"),
    expectedServers: (($bg.status.servers // []) | length),
    readyServers: ([($bg.status.servers // [])[] | select(.ready == true and .phase == "Running")] | length),
    players: ([($stats.items // [])[] | (.status.runtime.players // 0)] | add // 0),
    healthy: (
      ($bg.status.phase // "") == "Healthy" and
      ($bg.status.database.phase // "") == "Ready" and
      ($bg.status.utilities.serverGateway.phase // "") == "Healthy" and
      ($bg.status.utilities.director.phase // "") == "Healthy" and
      ($bg.status.serverGroupPhase // "") == "Running" and
      ((($bg.status.servers // []) | length) > 0) and
      ([($bg.status.servers // [])[] | select(.ready == true and .phase == "Running")] | length) == (($bg.status.servers // []) | length)
    )
  }'
}

wait_for_health() {
  local timeout_seconds="$1"
  local elapsed=0
  local snapshot='{}'
  while [ "$elapsed" -lt "$timeout_seconds" ]; do
    snapshot=$(health_snapshot 2>/dev/null || printf '{}')
    if [ "$(printf '%s' "$snapshot" | jq -r '.healthy // false')" = "true" ]; then
      printf '%s' "$snapshot"
      return 0
    fi
    sleep 10
    elapsed=$((elapsed + 10))
  done
  printf '%s' "$snapshot"
  return 1
}

wait_for_stopped() {
  local timeout_seconds="$1"
  local elapsed=0
  local phase=""
  while [ "$elapsed" -lt "$timeout_seconds" ]; do
    phase=$(kubectl_safe get battlegroup "$BATTLEGROUP" -n "$NAMESPACE" -o json 2>/dev/null | jq -r '.status.phase // "Unknown"')
    if [ "$phase" = "Stopped" ]; then
      return 0
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done
  printf '%s\n' "$phase"
  return 1
}

operation_conflict_reason() {
  local count
  count=$(active_database_operation_count 2>/dev/null) || {
    printf '%s' "Database operation state could not be verified."
    return 0
  }
  if [ "$count" -gt 0 ]; then
    printf '%s' "$count database operation(s) are already active."
    return 0
  fi
  if update_process_running; then
    printf '%s' "A Funcom server update process is active."
    return 0
  fi
  printf '%s' ""
}

prune_backups() {
  local retention
  retention=$(config_number '.backup.retention' '7')
  [ "$retention" -ge 1 ] 2>/dev/null || retention=7
  local index=0
  local file
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    index=$((index + 1))
    if [ "$index" -gt "$retention" ]; then
      case "$file" in
        "$BACKUP_DIR"/alphanine-scheduled-*.backup)
          sudo -n rm -f "$file" "$file.yaml"
          ;;
      esac
    fi
  done < <(sudo -n ls -1t "$BACKUP_DIR"/alphanine-scheduled-*.backup 2>/dev/null || true)
}

run_backup() {
  local reason="${1:-manual}"
  local conflict
  conflict=$(operation_conflict_reason)
  if [ -n "$conflict" ]; then
    record_event "backup" "blocked" "$conflict" "$(jq -cn --arg reason "$reason" '{reason:$reason}')"
    return 1
  fi

  local timestamp backup_name operation_name manifest phase elapsed timeout_seconds
  timestamp=$(date -u +%Y%m%d-%H%M%S)
  backup_name="alphanine-scheduled-$timestamp.backup"
  operation_name="alphanine-dump-$timestamp"
  manifest="$ROOT_DIR/$operation_name.yaml"
  timeout_seconds=$(config_number '.backup.timeoutMinutes' '15')
  timeout_seconds=$((timeout_seconds * 60))

  cat > "$manifest" <<EOF
apiVersion: igw.funcom.com/v1
kind: DatabaseOperation
metadata:
  name: $operation_name
  namespace: $NAMESPACE
  labels:
    app.kubernetes.io/managed-by: alphanine-dune-suite
    alphanine.io/scheduler-operation: backup
spec:
  battleGroup: $BATTLEGROUP
  action: dump
  backup: $backup_name
EOF

  record_event "backup" "running" "Creating verified battlegroup backup." "$(jq -cn --arg reason "$reason" --arg name "$backup_name" '{reason:$reason,backupName:$name}')"
  if ! kubectl_safe apply -f "$manifest" >> "$LOG_FILE" 2>&1; then
    rm -f "$manifest"
    record_event "backup" "failed" "The Funcom DatabaseOperation could not be created." "$(jq -cn --arg name "$backup_name" '{backupName:$name}')"
    return 1
  fi
  rm -f "$manifest"

  elapsed=0
  phase="Pending"
  while [ "$elapsed" -lt "$timeout_seconds" ]; do
    phase=$(kubectl_safe get databaseoperation "$operation_name" -n "$NAMESPACE" -o json 2>/dev/null | jq -r '.status.phase // "Pending"')
    case "$phase" in
      Succeeded) break ;;
      Failed)
        record_event "backup" "failed" "Funcom reported that the database backup failed." "$(jq -cn --arg name "$backup_name" --arg operation "$operation_name" '{backupName:$name,operation:$operation}')"
        return 1
        ;;
    esac
    sleep 5
    elapsed=$((elapsed + 5))
  done
  if [ "$phase" != "Succeeded" ]; then
    record_event "backup" "failed" "Database backup timed out before Funcom reported success." "$(jq -cn --arg name "$backup_name" --arg operation "$operation_name" --arg phase "$phase" '{backupName:$name,operation:$operation,phase:$phase}')"
    return 1
  fi

  local backup_path="$BACKUP_DIR/$backup_name"
  if ! sudo -n test -s "$backup_path"; then
    record_event "backup" "failed" "Funcom reported success but the backup artifact is missing or empty." "$(jq -cn --arg path "$backup_path" '{backupPath:$path}')"
    return 1
  fi
  if ! kubectl_safe get battlegroup "$BATTLEGROUP" -n "$NAMESPACE" -o yaml | sudo -n tee "$backup_path.yaml" >/dev/null; then
    record_event "backup" "failed" "The database dump succeeded, but its battlegroup recovery manifest could not be saved." "$(jq -cn --arg path "$backup_path" '{backupPath:$path}')"
    return 1
  fi
  if ! sudo -n test -s "$backup_path.yaml"; then
    record_event "backup" "failed" "The battlegroup recovery manifest is empty." "$(jq -cn --arg path "$backup_path.yaml" '{manifestPath:$path}')"
    return 1
  fi

  local size now_epoch local_date
  size=$(sudo -n stat -c %s "$backup_path" 2>/dev/null || printf '0')
  now_epoch=$(date +%s)
  local_date=$(date +%Y-%m-%d)
  state_update '.lastBackupDate=$date | .lastSuccessfulBackupEpoch=$epoch | .lastSuccessfulBackupName=$name' \
    --arg date "$local_date" --argjson epoch "$now_epoch" --arg name "$backup_name"
  prune_backups
  record_event "backup" "succeeded" "Verified battlegroup backup completed." "$(jq -cn --arg name "$backup_name" --arg path "$backup_path" --argjson size "$size" --arg reason "$reason" '{backupName:$name,backupPath:$path,sizeBytes:$size,reason:$reason}')"
  return 0
}

backup_is_fresh() {
  local max_age_minutes last_epoch now_epoch age
  max_age_minutes=$(config_number '.restart.backupFreshMinutes' '90')
  last_epoch=$(jq -r '.lastSuccessfulBackupEpoch // 0' "$STATE_FILE")
  now_epoch=$(date +%s)
  age=$((now_epoch - last_epoch))
  [ "$last_epoch" -gt 0 ] && [ "$age" -ge 0 ] && [ "$age" -le $((max_age_minutes * 60)) ]
}

run_restart() {
  local reason="${1:-manual}"
  local bypass_players="${2:-false}"
  local conflict
  local control_before control_generation control_operation_id
  control_before=$(control_snapshot) || { record_event "restart" "blocked" "Battlegroup control generation could not be captured." '{}'; return 1; }
  control_generation=$(printf '%s' "$control_before" | jq -r '.generation')
  control_operation_id="scheduler-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  if maintenance_active; then
    record_event "restart" "blocked" "Migration Maintenance Mode holds the game server offline." '{}'
    return 1
  fi
  conflict=$(operation_conflict_reason)
  if [ -n "$conflict" ]; then
    record_event "restart" "blocked" "$conflict" "$(jq -cn --arg reason "$reason" '{reason:$reason}')"
    return 1
  fi

  local players
  if ! players=$(player_count); then
    record_event "restart" "blocked" "Player count could not be verified; restart was blocked safely." "$(jq -cn --arg reason "$reason" '{reason:$reason}')"
    return 1
  fi
  if [ "$players" -gt 0 ] && [ "$bypass_players" != "true" ]; then
    record_event "restart" "deferred" "Restart postponed because players are online." "$(jq -cn --argjson players "$players" --arg reason "$reason" '{players:$players,reason:$reason}')"
    return 2
  fi

  local preflight_health
  if ! preflight_health=$(health_snapshot 2>/dev/null) ||
     [ "$(printf '%s' "$preflight_health" | jq -r '.healthy // false')" != "true" ]; then
    [ -n "$preflight_health" ] || preflight_health='{}'
    record_event "restart" "blocked" "Battlegroup health was not fully ready before restart; no shutdown was requested." "$preflight_health"
    return 1
  fi

  local backup_first
  backup_first=$(config_bool '.restart.backupFirst' 'true')
  if [ "$backup_first" = "true" ]; then
    if backup_is_fresh; then
      record_event "restart" "backup-ready" "Using the recent verified scheduler backup." "$(jq -cn --arg name "$(jq -r '.lastSuccessfulBackupName // ""' "$STATE_FILE")" '{backupName:$name}')"
    elif ! run_backup "pre-restart"; then
      record_event "restart" "aborted" "Restart was cancelled because the required safety backup failed." '{}'
      return 1
    fi
  fi

  conflict=$(operation_conflict_reason)
  if [ -n "$conflict" ]; then
    record_event "restart" "blocked" "$conflict" '{}'
    return 1
  fi

  local script_root refresh_script
  script_root=$(dirname "$(readlink -f /home/dune/.dune/bin/battlegroup)")
  refresh_script="$script_root/setup/battlegroup_ip.sh"
  if [ ! -x "$refresh_script" ] || ! "$refresh_script" refresh >> "$LOG_FILE" 2>&1; then
    record_event "restart" "aborted" "The Funcom battlegroup IP refresh failed before shutdown; the server was left running." '{}'
    return 1
  fi

  if maintenance_active; then
    record_event "restart" "blocked" "Migration Maintenance Mode became active before shutdown." '{}'
    return 1
  fi
  record_event "restart" "running" "Stopping the configured battlegroup." "$(jq -cn --argjson players "$players" --arg reason "$reason" '{players:$players,reason:$reason}')"
  if ! guarded_control_patch true "$control_generation" "$control_operation_id" "Protected scheduler restart stop phase: $reason"; then
    record_event "restart" "failed" "The battlegroup stop request failed." '{}'
    return 1
  fi
  local stopped_phase
  if ! stopped_phase=$(wait_for_stopped 180); then
    if ! maintenance_active; then
      guarded_control_patch false "$control_generation" "$control_operation_id" "Protected scheduler recovery start after stop timeout" || true
      record_event "restart" "failed" "The battlegroup did not stop within 180 seconds; a recovery start was requested." "$(jq -cn --arg phase "$stopped_phase" '{phase:$phase}')"
    else
      record_event "restart" "blocked" "Migration Maintenance Mode appeared while shutdown was pending; no recovery start was requested." "$(jq -cn --arg phase "$stopped_phase" '{phase:$phase}')"
    fi
    return 1
  fi

  sleep 5
  if maintenance_active; then
    record_event "restart" "blocked" "Migration Maintenance Mode appeared after shutdown; the battlegroup remains stopped." '{}'
    return 1
  fi
  record_event "restart" "running" "Starting the configured battlegroup and waiting for health checks." '{}'
  if ! guarded_control_patch false "$control_generation" "$control_operation_id" "Protected scheduler restart start phase: $reason"; then
    sleep 5
    if maintenance_active; then
      record_event "restart" "blocked" "Migration Maintenance Mode appeared after the first start request; no retry was made." '{}'
      return 1
    fi
    if ! guarded_control_patch false "$control_generation" "$control_operation_id" "Protected scheduler restart start retry: $reason"; then
      record_event "restart" "failed" "The battlegroup start request failed twice after shutdown; manual recovery is required." '{}'
      return 1
    fi
    record_event "restart" "warning" "The first start request failed; the protected retry succeeded." '{}'
  fi

  local health_timeout health
  health_timeout=$(config_number '.restart.healthTimeoutMinutes' '15')
  health_timeout=$((health_timeout * 60))
  if ! health=$(wait_for_health "$health_timeout"); then
    record_event "restart" "failed" "Battlegroup restart did not return to full health before timeout." "$health"
    return 1
  fi

  local local_date
  local_date=$(date +%Y-%m-%d)
  state_update '.lastRestartDate=$date | .deferredRestartDate="" | .deferredSinceEpoch=0' --arg date "$local_date"
  record_event "restart" "succeeded" "Battlegroup restart completed and all health checks passed." "$health"
  return 0
}

scheduled_epoch() {
  local date_value="$1"
  local time_value="$2"
  date -d "$date_value $time_value:00" +%s 2>/dev/null
}

within_catchup_window() {
  local target_epoch="$1"
  local window_minutes="$2"
  local now_epoch
  now_epoch=$(date +%s)
  [ "$now_epoch" -ge "$target_epoch" ] && [ $((now_epoch - target_epoch)) -le $((window_minutes * 60)) ]
}

tick_scheduler() {
  local enabled
  enabled=$(config_bool '.enabled' 'true')
  if [ "$enabled" != "true" ]; then
    return 0
  fi
  if ! target_exists; then
    record_event "tick" "failed" "Configured battlegroup or namespace does not exist." "$(jq -cn --arg battlegroup "$BATTLEGROUP" --arg namespace "$NAMESPACE" '{battlegroup:$battlegroup,namespace:$namespace}')"
    return 1
  fi

  local today now_epoch catchup_minutes backup_time restart_time backup_epoch restart_epoch
  today=$(date +%Y-%m-%d)
  now_epoch=$(date +%s)
  catchup_minutes=$(config_number '.catchUpWindowMinutes' '120')
  backup_time=$(config_text '.backup.time' '04:00')
  restart_time=$(config_text '.restart.time' '05:00')
  backup_epoch=$(scheduled_epoch "$today" "$backup_time" || printf '0')
  restart_epoch=$(scheduled_epoch "$today" "$restart_time" || printf '0')

  state_update '.lastTickAt=$timestamp' --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  if [ "$(config_bool '.backup.enabled' 'true')" = "true" ] &&
     [ "$(jq -r '.lastBackupDate // ""' "$STATE_FILE")" != "$today" ] &&
     [ "$backup_epoch" -gt 0 ] && within_catchup_window "$backup_epoch" "$catchup_minutes"; then
    run_backup "scheduled" || true
  fi

  if [ "$(config_bool '.restart.enabled' 'true')" != "true" ] ||
     [ "$(jq -r '.lastRestartDate // ""' "$STATE_FILE")" = "$today" ] ||
     [ "$restart_epoch" -le 0 ] || [ "$now_epoch" -lt "$restart_epoch" ]; then
    return 0
  fi

  local deferred_date deferred_since max_deferral policy result
  deferred_date=$(jq -r '.deferredRestartDate // ""' "$STATE_FILE")
  deferred_since=$(jq -r '.deferredSinceEpoch // 0' "$STATE_FILE")
  if [ "$deferred_date" != "$today" ]; then
    deferred_since="$now_epoch"
    state_update '.deferredRestartDate=$date | .deferredSinceEpoch=$epoch' --arg date "$today" --argjson epoch "$now_epoch"
  fi
  max_deferral=$(config_number '.restart.maxDeferralMinutes' '180')
  policy=$(config_text '.restart.playersOnlinePolicy' 'skip')

  run_restart "scheduled" "false"
  result=$?
  if [ "$result" -eq 0 ]; then
    return 0
  fi
  if [ "$result" -ne 2 ]; then
    return "$result"
  fi

  if [ $((now_epoch - deferred_since)) -lt $((max_deferral * 60)) ]; then
    return 0
  fi
  if [ "$policy" = "force" ]; then
    record_event "restart" "warning" "Maximum player deferral elapsed; configured force policy is starting the protected restart." '{}'
    run_restart "scheduled-force-after-deferral" "true"
    return $?
  fi
  state_update '.lastRestartDate=$date | .deferredRestartDate="" | .deferredSinceEpoch=0' --arg date "$today"
  record_event "restart" "skipped" "Daily restart was skipped after the maximum player deferral elapsed." "$(jq -cn --argjson minutes "$max_deferral" '{maxDeferralMinutes:$minutes}')"
  return 0
}

initialize_schedule() {
  local today now_epoch backup_time restart_time backup_epoch restart_epoch
  today=$(date +%Y-%m-%d)
  now_epoch=$(date +%s)
  backup_time=$(config_text '.backup.time' '04:00')
  restart_time=$(config_text '.restart.time' '05:00')
  backup_epoch=$(scheduled_epoch "$today" "$backup_time" || printf '0')
  restart_epoch=$(scheduled_epoch "$today" "$restart_time" || printf '0')
  if [ "$backup_epoch" -gt 0 ] && [ "$now_epoch" -ge "$backup_epoch" ]; then
    state_update '.lastBackupDate=$date' --arg date "$today"
  fi
  if [ "$restart_epoch" -gt 0 ] && [ "$now_epoch" -ge "$restart_epoch" ]; then
    state_update '.lastRestartDate=$date' --arg date "$today"
  fi
  record_event "install" "succeeded" "Scheduler configuration installed and validated; past times today were not run automatically." "$(jq -cn --arg timezone "$TIMEZONE" --arg battlegroup "$BATTLEGROUP" '{timezone:$timezone,battlegroup:$battlegroup}')"
}

self_test() {
  local failures='[]'
  local checks='[]'
  add_check() {
    local name="$1" ok="$2" detail="$3"
    checks=$(printf '%s' "$checks" | jq --arg name "$name" --argjson ok "$ok" --arg detail "$detail" '. + [{name:$name,ok:$ok,detail:$detail}]')
    if [ "$ok" != "true" ]; then
      failures=$(printf '%s' "$failures" | jq --arg name "$name" '. + [$name]')
    fi
  }
  local command
  for command in bash jq sudo kubectl flock timeout crond; do
    if command -v "$command" >/dev/null 2>&1; then add_check "$command" true "available"; else add_check "$command" false "missing"; fi
  done
  if [ -e "/usr/share/zoneinfo/$TIMEZONE" ]; then add_check "timezone" true "$TIMEZONE"; else add_check "timezone" false "$TIMEZONE missing"; fi
  if target_exists; then add_check "battlegroup" true "$BATTLEGROUP"; else add_check "battlegroup" false "$BATTLEGROUP not found"; fi
  local players health cron_ok
  if players=$(player_count 2>/dev/null); then add_check "player-count" true "$players online"; else add_check "player-count" false "query failed"; fi
  if health=$(health_snapshot 2>/dev/null); then add_check "health-query" true "$(printf '%s' "$health" | jq -c .)"; else add_check "health-query" false "query failed"; fi
  if sudo -n grep -q '^# BEGIN ALPHANINE DUNE SCHEDULER$' /etc/crontabs/dune 2>/dev/null; then cron_ok=true; else cron_ok=false; fi
  add_check "cron-registration" "$cron_ok" "/etc/crontabs/dune"
  if sudo -n ps -eo comm= 2>/dev/null | grep -Eq '^crond$'; then add_check "cron-runtime" true "BusyBox crond is running"; else add_check "cron-runtime" false "BusyBox crond is not running"; fi
  local ok
  if [ "$(printf '%s' "$failures" | jq 'length')" -eq 0 ]; then ok=true; else ok=false; fi
  local result
  result=$(jq -cn --argjson ok "$ok" --argjson checks "$checks" --argjson failures "$failures" '{ok:$ok,checks:$checks,failures:$failures}')
  if [ "$ok" = "true" ]; then
    record_event "self-test" "succeeded" "Scheduler self-test passed without changing the battlegroup." "$result"
    printf '%s\n' "$result"
    return 0
  fi
  record_event "self-test" "failed" "Scheduler self-test found missing requirements." "$result"
  printf '%s\n' "$result"
  return 1
}

show_status() {
  local history='[]' last='null' state='{}' config='{}' cron=false health='null' players='null'
  config=$(cat "$CONFIG_FILE" 2>/dev/null || printf '{}')
  state=$(cat "$STATE_FILE" 2>/dev/null || printf '{}')
  last=$(cat "$LAST_STATUS_FILE" 2>/dev/null || printf 'null')
  history=$(tail -n 50 "$HISTORY_FILE" 2>/dev/null | jq -s '.' 2>/dev/null || printf '[]')
  if sudo -n grep -q '^# BEGIN ALPHANINE DUNE SCHEDULER$' /etc/crontabs/dune 2>/dev/null; then cron=true; fi
  health=$(health_snapshot 2>/dev/null || printf 'null')
  players=$(player_count 2>/dev/null || printf 'null')
  jq -cn \
    --argjson config "$config" \
    --argjson state "$state" \
    --argjson last "$last" \
    --argjson history "$history" \
    --argjson cronRegistered "$cron" \
    --argjson health "$health" \
    --argjson players "$players" \
    --arg schedulerVersion "$SCHEDULER_VERSION" \
    --arg vmNow "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg localNow "$(date +%Y-%m-%dT%H:%M:%S%z)" \
    '{ok:true,installed:true,schedulerMode:"installed",ambiguousRegistration:false,schedulerVersion:$schedulerVersion,cronRegistered:$cronRegistered,config:$config,state:$state,lastStatus:$last,history:$history,health:$health,players:$players,vmNow:$vmNow,localNow:$localNow}'
}

main() {
  local action="${1:-status}"
  load_runtime_config || exit 1
  case "$action" in
    status) show_status ;;
    self-test) self_test ;;
    initialize) initialize_schedule ;;
    tick)
      exec 9>"$LOCK_FILE"
      if ! flock -n 9; then exit 0; fi
      tick_scheduler
      ;;
    backup-now)
      exec 9>"$LOCK_FILE"
      if ! flock -n 9; then record_event "backup" "blocked" "Another scheduler operation is running." '{}'; exit 1; fi
      target_exists || { record_event "backup" "failed" "Configured battlegroup was not found." '{}'; exit 1; }
      run_backup "manual"
      ;;
    restart-now)
      exec 9>"$LOCK_FILE"
      if ! flock -n 9; then record_event "restart" "blocked" "Another scheduler operation is running." '{}'; exit 1; fi
      target_exists || { record_event "restart" "failed" "Configured battlegroup was not found." '{}'; exit 1; }
      run_restart "manual" "false"
      ;;
    *) printf '%s\n' "Unknown scheduler action: $action" >&2; exit 2 ;;
  esac
}

main "$@"
