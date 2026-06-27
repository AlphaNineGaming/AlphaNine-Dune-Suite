from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import os
import subprocess
import sys
import tempfile
import threading
import webbrowser


ROOT = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent


def writable_data_root():
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA")
    data_root = Path(base) / "AlphaNine Dune Awakening Manager" if base else ROOT
    try:
        data_root.mkdir(parents=True, exist_ok=True)
        return data_root
    except OSError:
        return ROOT


DATA_ROOT = writable_data_root()
APPLIED_PROFILE = DATA_ROOT / "applied-profile.json"
APPLIED_SETTINGS = DATA_ROOT / "applied-server-settings.json"
APPLIED_USERGAME = DATA_ROOT / "applied-UserGame.ini"
APPLIED_USERENGINE = DATA_ROOT / "applied-UserEngine.ini"
REWARD_REQUESTS = DATA_ROOT / "character-reward-requests.json"
MANAGER_CONFIG = DATA_ROOT / "manager-config.json"


def default_ssh_key():
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    return str(Path(local_app_data) / "DuneAwakeningServer" / "sshKey") if local_app_data else ""


DEFAULT_MANAGER_CONFIG = {
    "vmIp": "",
    "sshKeyPath": default_ssh_key(),
    "battlegroup": "",
}


def read_manager_config():
    config = dict(DEFAULT_MANAGER_CONFIG)
    if MANAGER_CONFIG.exists():
        try:
            saved = json.loads(MANAGER_CONFIG.read_text(encoding="utf-8"))
            if isinstance(saved, dict):
                config.update({key: str(saved.get(key, config[key])).strip() for key in config})
        except json.JSONDecodeError:
            pass
    return config


def sanitize_manager_config(payload):
    config = read_manager_config()
    for key in ("vmIp", "sshKeyPath", "battlegroup"):
        if key in payload:
            config[key] = str(payload.get(key, "")).strip()
    return config


def write_manager_config(payload):
    config = sanitize_manager_config(payload)
    MANAGER_CONFIG.write_text(json.dumps(config, indent=2), encoding="utf-8")
    return config


def connection_values(require_battlegroup=False):
    config = read_manager_config()
    vm_ip = config.get("vmIp", "").strip()
    ssh_key = Path(config.get("sshKeyPath", "").strip())
    battlegroup = config.get("battlegroup", "").strip()
    if not vm_ip:
        raise RuntimeError("Server setup needs a VM IP address.")
    if not ssh_key:
        raise RuntimeError("Server setup needs an SSH key path.")
    if require_battlegroup and not battlegroup:
        raise RuntimeError("Server setup needs a battlegroup ID.")
    namespace = f"funcom-seabass-{battlegroup}" if battlegroup else ""
    return config, vm_ip, ssh_key, battlegroup, namespace


def setting(profile, section, key, default):
    value = profile.get("settings", {}).get(section, {}).get(key, default)
    return value if value is not None else default


def bool_text(value):
    return "True" if bool(value) else "False"


def stop_stale_local_server(port=8812):
    if os.name != "nt":
        return
    try:
        result = subprocess.run(
            ["netstat.exe", "-ano", "-p", "tcp"],
            text=True,
            capture_output=True,
            timeout=5,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError):
        return

    current_pid = str(os.getpid())
    port_marker = f":{port}"
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) < 5 or parts[0].upper() != "TCP" or parts[3].upper() != "LISTENING":
            continue
        if port_marker not in parts[1]:
            continue
        pid = parts[-1]
        if pid == current_pid or not pid.isdigit():
            continue
        try:
            subprocess.run(
                ["taskkill.exe", "/PID", pid, "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
                check=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            return
        except (OSError, subprocess.SubprocessError):
            continue


def bool_int(value):
    return "1" if bool(value) else "0"


def build_ini(profile):
    pvp_mode = setting(profile, "pvp", "pvpMode", "frontier_zones")
    force_pvp = pvp_mode == "always_on"
    security_zones = pvp_mode != "always_on"
    if pvp_mode == "off":
        force_pvp = False
        security_zones = True

    storm_switch = bool(setting(profile, "environment", "stormEnabled", True))
    storm_frequency = max(0, float(setting(profile, "environment", "stormFrequency", 1)))
    storm_severity = max(0, min(10, float(setting(profile, "environment", "stormSeverity", 1))))
    storm_enabled = storm_switch and storm_frequency > 0 and storm_severity > 0
    worm_enabled = float(setting(profile, "environment", "wormAggression", 1)) > 0
    sandworm_safe_seconds = max(0, float(setting(profile, "environment", "waterRetentionMultiplier", 1)) * 900)
    item_decay = max(0, min(10, float(setting(profile, "resources", "structureDecayMultiplier", 1))))
    mining = max(0, float(setting(profile, "resources", "harvestMultiplier", 1)))
    vehicle_mining = max(0, float(setting(profile, "resources", "spiceYieldMultiplier", mining)))
    pvp_resource = max(0, float(setting(profile, "resources", "lootQualityMultiplier", 2.5)))
    harvest_amount = max(0, float(setting(profile, "resources", "globalHarvestAmountMultiplier", 1)))
    harvest_health = max(0, float(setting(profile, "resources", "globalHarvestHealthMultiplier", 1)))
    cutteray_hem = max(0, float(setting(profile, "resources", "cutterayHemMultiplierPerNodeTierTable", 1)))
    min_augment_quality = max(0, int(setting(profile, "resources", "minimumAugmentableItemQuality", 0)))
    item_durability_loss = max(0, float(setting(profile, "resources", "itemDurabilityLossMultiplier", 1)))
    xp_multiplier = max(0, float(setting(profile, "progression", "xpMultiplier", 1)))
    fame_multiplier = max(0, float(setting(profile, "progression", "fameMultiplier", 1)))
    progression_speed = max(0, float(setting(profile, "progression", "progressionSpeedMultiplier", 1)))
    guild_creation_cost = max(0, int(setting(profile, "progression", "guildCreationCost", 1000)))
    sell_fee = max(0, float(setting(profile, "progression", "sellOrderPricePercentageFee", 2)))
    spice_tax_amount = max(0, float(setting(profile, "progression", "spiceTaxAmount", 0.1)))
    spice_tax_interval = max(0, int(setting(profile, "progression", "spiceTaxInterval", 3600)))
    legacy_pvp = bool(setting(profile, "pvp", "legacyPvpEnabled", False))
    server_pve = bool(setting(profile, "pvp", "serverPve", True))
    water_rate = max(0, float(setting(profile, "environment", "waterConsumptionRate", 1)))
    storm_water_rate = max(0, float(setting(profile, "environment", "waterConsumptionInStormMultiplier", 4)))
    npc_damage = max(0, float(setting(profile, "environment", "globalDamageToNpcsMultiplier", 1)))
    player_damage = max(0, float(setting(profile, "environment", "globalDamageToPlayersMultiplier", 1)))
    health_multiplier = max(0, float(setting(profile, "environment", "globalHealthMultiplier", 1)))
    building_damage = max(0, float(setting(profile, "environment", "globalBuildingDamageMultiplier", 1)))
    building_decay = max(0, float(setting(profile, "clans", "buildingDecayRateMultiplier", 1)))
    building_stability = bool(setting(profile, "clans", "enableBuildingStability", True))
    inventory_weight = max(0, float(setting(profile, "inventory", "inventoryWeightMultiplier", 1)))
    inventory_slots = max(1, int(setting(profile, "inventory", "playerInventoryStartingSize", 40)))
    inventory_volume = max(1, float(setting(profile, "inventory", "playerInventoryStartingVolumeCapacity", 225)))
    starting_water = max(0, float(setting(profile, "inventory", "playerStartingWater", 100)))
    reconnect_grace = max(0, int(setting(profile, "admin", "defaultReconnectGracePeriodSeconds", 300)))
    cycle_days = max(1, int(setting(profile, "admin", "cycleDurationInDays", 7)))
    db_wipe = bool(setting(profile, "admin", "dbWipeEnabled", True))
    max_guild_members = max(1, int(setting(profile, "clans", "maxGuildMembersAllowed", 32)))
    max_guilds = max(1, int(setting(profile, "clans", "maxGuildsAllowed", 3)))
    max_permissions = max(1, int(setting(profile, "clans", "maxPermissionsPerActor", 20)))
    vehicle_quicksand_damage = max(0, float(setting(profile, "environment", "vehicleQuicksandDamage", 10)))
    max_claims = int(setting(profile, "clans", "baseClaimLimit", 6))
    build_ext = int(setting(profile, "clans", "buildHeightLimit", 4))
    restriction_limits = not bool(setting(profile, "clans", "publicBuildDamage", False))

    user_game = f"""; Settings in these config files will be applied to every server in the battlegroup
; Generated by Dune Awakening Manager.
; Unsupported manager sliders are intentionally not written here.

[/Script/DuneSandbox.PvpPveSettings]
; Enable PVP for all partitions
m_bShouldForceEnablePvpOnAllPartitions={bool_text(force_pvp)}

[/Script/DuneSandbox.SecurityZonesSubsystem]
; Disabling security zones across the board allows for PVP and ability usage everywhere
m_bAreSecurityZonesEnabled={bool_text(security_zones)}

[/DeteriorationSystem.ItemDeteriorationConstants]
; Deterioration rate for items | (0 to 10)  0=off
UpdateRateInSeconds={item_decay:.2f}

[/Script/DuneSandbox.SandStormConfig]
; Enable Coriolis storm
m_bCoriolisAutoSpawnEnabled={bool_text(storm_enabled)}

[/Script/DuneSandbox.BuildingSettings]
; Max number of landclaims. Needs to also be applied to each client.
m_MaxNumLandclaimSegments={max_claims}
; Number of times a landclaim can be expanded
m_BuildingBlueprintMaxExtensions={build_ext}
m_BaseBackupMaxExtensions={max(0, build_ext * 2)}
; Enable building restriction limits. Needs to also be applied to each client.
m_bBuildingRestrictionLimitsEnabled={bool_text(restriction_limits)}

[/Script/DuneSandbox.DuneGameMode]
; Advanced progression and economy settings from community documentation.
m_GlobalXPMultiplier={xp_multiplier:.2f}
m_GlobalFameMultiplier={fame_multiplier:.2f}
m_GlobalProgressionSpeedMultiplier={progression_speed:.2f}
m_GuildCreationCost={guild_creation_cost}
SellOrderPricePercentageFee={sell_fee:.2f}
SpiceTaxAmount={spice_tax_amount:.2f}
SpiceTaxInterval={spice_tax_interval}

; Advanced harvesting and item settings from community documentation.
m_GlobalHarvestAmountMultiplier={harvest_amount:.2f}
m_GlobalHarvestHealthMultiplier={harvest_health:.2f}
CutterayHemMultiplierPerNodeTierTable={cutteray_hem:.2f}
m_MinimumAugmentableItemQuality={min_augment_quality}
m_ItemDurabilityLossMultiplier={item_durability_loss:.2f}

; Advanced survival and combat settings from community documentation.
bPvPEnabled={bool_text(legacy_pvp)}
bServerPVE={bool_text(server_pve)}
m_WaterConsumptionRate={water_rate:.2f}
m_WaterConsumptionInStormMultiplier={storm_water_rate:.2f}
m_GlobalDamageToNpcsMultiplier={npc_damage:.2f}
m_GlobalDamageToPlayersMultiplier={player_damage:.2f}
m_GlobalHealthMultiplier={health_multiplier:.2f}
m_GlobalBuildingDamageMultiplier={building_damage:.2f}
m_BuildingDecayRateMultiplier={building_decay:.2f}
bEnableBuildingStability={bool_text(building_stability)}
m_InventoryWeightMultiplier={inventory_weight:.2f}
m_PlayerStartingWater={starting_water:.1f}
m_DefaultReconnectGracePeriodSeconds={reconnect_grace}

; Advanced world reset, guild, permission, and vehicle settings from community documentation.
m_CycleDurationInDays={cycle_days}
m_bIsDbWipeEnabled={bool_text(db_wipe)}
m_MaxGuildMembersAllowed={max_guild_members}
m_MaxGuildsAllowed={max_guilds}
m_MaxPermissionsPerActor={max_permissions}
m_VehicleQuicksandDamage={vehicle_quicksand_damage:.1f}

[/Script/DuneSandbox.InventorySystemSettings]
; Player starting inventory defaults from server UserGame.ini.
PlayerInventoryStartingSize={inventory_slots}
PlayerInventoryStartingVolumeCapacity={inventory_volume:.1f}
"""

    display_name = profile.get("profileName", "Dune Awakening Server").replace('"', "'").replace("|", "-")
    user_engine = f"""; Settings in these config files will be applied to every server in the battlegroup
; Generated by Dune Awakening Manager.

[URL]
Port=7777
IGWPort=7888

[ConsoleVariables]
Bgd.ServerDisplayName="{display_name}"

; Mining multipliers
Dune.GlobalMiningOutputMultiplier={mining:.2f}
Dune.GlobalVehicleMiningOutputMultiplier={vehicle_mining:.2f}
SecurityZones.PvpResourceMultiplier={pvp_resource:.2f}

; Durability damage multiplier for vehicles | (0 to 10)  0=off
dw.VehicleDurabilityDamageMultiplier={storm_severity:.2f}

; Sandstorm and sandstorm treasure spawning settings
Sandstorm.Enabled={bool_int(storm_enabled)}
Sandstorm.Treasure.Enabled={bool_int(setting(profile, "resources", "lootQualityMultiplier", 1) > 0)}

; Sandworm settings
sandworm.dune.Enabled={bool_int(worm_enabled)}
; Sandworm can push/damage vehicles
Vehicle.SandwormCollisionInteraction={str(worm_enabled).lower()}
; Enables dangerzones where the sandworm can attack
Sandworm.SandwormDangerZonesEnabled={str(worm_enabled).lower()}
; Seconds of invulnerability from sandworm on specific situations
Vehicle.SandwormInvulnerabilitySecondsOnExit={sandworm_safe_seconds:.1f}
Vehicle.SandwormInvulnerabilitySecondsOnServerRestart=7200.0
"""
    return user_game, user_engine


def run_ssh(command, timeout=60):
    _, vm_ip, ssh_key, _, _ = connection_values()
    args = [
        "ssh",
        "-o", "StrictHostKeyChecking=no",
        "-o", "LogLevel=QUIET",
        "-o", "ConnectTimeout=8",
        "-i", str(ssh_key),
        f"dune@{vm_ip}",
        command,
    ]
    return subprocess.run(args, text=True, capture_output=True, timeout=timeout)


def copy_to_vm(local_path, remote_path):
    _, vm_ip, ssh_key, _, _ = connection_values()
    args = [
        "ssh",
        "-o", "StrictHostKeyChecking=no",
        "-o", "LogLevel=QUIET",
        "-o", "ConnectTimeout=8",
        "-i", str(ssh_key),
        f"dune@{vm_ip}",
        f"cat > {remote_path}",
    ]
    with open(local_path, "rb") as source:
        return subprocess.run(args, stdin=source, capture_output=True, timeout=60)


def json_response(handler, payload, status=200):
    body = json.dumps(payload, indent=2).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def json_error(handler, status, message):
    json_response(handler, {"ok": False, "error": message}, status)


def read_reward_requests():
    if not REWARD_REQUESTS.exists():
        return []
    try:
        data = json.loads(REWARD_REQUESTS.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []
    return data if isinstance(data, list) else []


def sanitize_reward_request(payload):
    character = str(payload.get("character", "")).strip()
    if not character:
        raise ValueError("Character name or ID is required")

    try:
        xp = int(payload.get("xp", 0) or 0)
    except (TypeError, ValueError):
        raise ValueError("XP must be a whole number")
    if xp < 0:
        raise ValueError("XP cannot be negative")

    items = []
    for item in payload.get("items", []):
        if not isinstance(item, dict):
            continue
        item_id = str(item.get("id", "")).strip()
        if not item_id:
            continue
        try:
            quantity = int(item.get("quantity", 1) or 1)
        except (TypeError, ValueError):
            quantity = 1
        items.append({
            "id": item_id,
            "label": str(item.get("label", item_id)).strip() or item_id,
            "category": str(item.get("category", "")).strip(),
            "quantity": max(1, quantity),
        })

    if xp == 0 and not items:
        raise ValueError("Add XP, at least one item, or both")

    return {
        "character": character,
        "xp": xp,
        "items": items,
        "reason": str(payload.get("reason", "")).strip(),
        "status": "pending",
        "createdAt": payload.get("createdAt") or "",
        "note": "",
    }


def sql_literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def run_db_sql(sql, timeout=45):
    _, vm_ip, ssh_key, battlegroup, namespace = connection_values(require_battlegroup=True)
    command = (
        f"sudo kubectl exec -i -n {namespace} {battlegroup}-db-dbdepl-sts-0 -- "
        "psql -h 127.0.0.1 -p 15432 -U dune -d dune "
        "-v ON_ERROR_STOP=1 -q -P pager=off -F '|' -At"
    )
    args = [
        "ssh",
        "-o", "StrictHostKeyChecking=no",
        "-o", "LogLevel=QUIET",
        "-o", "ConnectTimeout=8",
        "-i", str(ssh_key),
        f"dune@{vm_ip}",
        command,
    ]
    return subprocess.run(args, input=sql, text=True, capture_output=True, timeout=timeout)


def apply_reward_now(reward_request):
    items = reward_request["items"]
    xp = reward_request["xp"]
    warnings = []

    if xp:
        warnings.append("XP was not applied because the self-hosted database does not expose a verified plain XP field yet.")
        if not items:
            raise RuntimeError(warnings[0])

    value_rows = []
    for item in items:
        value_rows.append(
            f"({sql_literal(item['id'])}, {int(item['quantity'])}, {sql_literal(item.get('label') or item['id'])})"
        )

    if not value_rows:
        return {"appliedItems": [], "warnings": warnings}

    character = sql_literal(reward_request["character"])
    values_sql = ",\n    ".join(value_rows)
    default_stats = sql_literal(json.dumps({"FItemStackAndDurabilityStats": [[], {"DecayedMaxDurability": 0.0}]}))

    sql = f"""
BEGIN;
CREATE TEMP TABLE reward_target ON COMMIT DROP AS
SELECT
  eps.account_id,
  dune.decrypt_user_data(eps.encrypted_character_name) AS character_name,
  eps.player_pawn_id AS actor_id,
  eps.online_status
FROM dune.encrypted_player_state eps
WHERE lower(dune.decrypt_user_data(eps.encrypted_character_name)) = lower({character})
   OR eps.account_id::text = {character}
   OR eps.player_controller_id::text = {character}
   OR eps.player_pawn_id::text = {character}
   OR eps.player_state_id::text = {character}
ORDER BY eps.last_login_time DESC NULLS LAST
LIMIT 1;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM reward_target) THEN
    RAISE EXCEPTION 'Character not found';
  END IF;
END $$;

CREATE TEMP TABLE reward_inventory ON COMMIT DROP AS
SELECT i.id AS inventory_id, i.max_item_count
FROM reward_target rt
JOIN dune.inventories i ON i.actor_id = rt.actor_id
WHERE i.inventory_type = 0
ORDER BY i.id
LIMIT 1;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM reward_inventory) THEN
    RAISE EXCEPTION 'Main character inventory not found';
  END IF;
END $$;

CREATE TEMP TABLE reward_input(template_id text, stack_size bigint, label text) ON COMMIT DROP;
INSERT INTO reward_input(template_id, stack_size, label) VALUES
    {values_sql};

CREATE TEMP TABLE reward_prepared ON COMMIT DROP AS
WITH base AS (
  SELECT
    ri.inventory_id,
    COALESCE(MAX(it.position_index), -1) AS max_position
  FROM reward_inventory ri
  LEFT JOIN dune.items it ON it.inventory_id = ri.inventory_id
  GROUP BY ri.inventory_id
)
SELECT
  nextval('dune.items_id_seq'::regclass) AS item_id,
  base.inventory_id,
  reward_input.stack_size,
  base.max_position + row_number() OVER (ORDER BY reward_input.template_id, reward_input.label) AS position_index,
  reward_input.template_id,
  reward_input.label
FROM reward_input
CROSS JOIN base;

SELECT dune.save_item(ROW(
  item_id,
  inventory_id,
  stack_size,
  position_index,
  template_id,
  true,
  extract(epoch from now())::bigint,
  {default_stats}::jsonb,
  0,
  NULL
)::dune.inventoryitem)
FROM reward_prepared;

SELECT rt.character_name, rt.online_status, rp.item_id, rp.template_id, rp.label, rp.stack_size, rp.inventory_id, rp.position_index
FROM reward_prepared rp
CROSS JOIN reward_target rt
ORDER BY rp.position_index;
COMMIT;
"""
    result = run_db_sql(sql)
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or "Database reward apply failed"
        raise RuntimeError(detail)

    applied_items = []
    character_name = reward_request["character"]
    online_status = ""
    for line in result.stdout.splitlines():
        parts = line.split("|")
        if len(parts) != 8:
            continue
        character_name, online_status, item_id, template_id, label, stack_size, inventory_id, position_index = parts
        applied_items.append({
            "itemId": int(item_id),
            "templateId": template_id,
            "label": label,
            "quantity": int(stack_size),
            "inventoryId": int(inventory_id),
            "positionIndex": int(position_index),
        })

    return {
        "characterName": character_name,
        "onlineStatus": online_status,
        "appliedItems": applied_items,
        "warnings": warnings,
    }


def apply_to_self_hosted_server(profile):
    user_game, user_engine = build_ini(profile)
    APPLIED_USERGAME.write_text(user_game, encoding="utf-8")
    APPLIED_USERENGINE.write_text(user_engine, encoding="utf-8")

    with tempfile.TemporaryDirectory() as tmp:
        game_tmp = Path(tmp) / "UserGame.ini"
        engine_tmp = Path(tmp) / "UserEngine.ini"
        game_tmp.write_text(user_game, encoding="utf-8")
        engine_tmp.write_text(user_engine, encoding="utf-8")

        for local, remote in [(game_tmp, "/tmp/UserGame.ini"), (engine_tmp, "/tmp/UserEngine.ini")]:
            result = copy_to_vm(local, remote)
            if result.returncode != 0:
                raise RuntimeError(result.stderr.strip() or result.stdout.strip() or f"Failed to copy {local.name}")

    install = run_ssh(
        "sudo cp /tmp/UserGame.ini /home/dune/.dune/download/scripts/setup/config/UserGame.ini && "
        "sudo cp /tmp/UserEngine.ini /home/dune/.dune/download/scripts/setup/config/UserEngine.ini && "
        "/home/dune/.dune/bin/battlegroup apply-default-usersettings",
        timeout=90,
    )
    if install.returncode != 0:
        raise RuntimeError(install.stderr.strip() or install.stdout.strip() or "Failed to apply UserSettings")

    restart = run_ssh("/home/dune/.dune/bin/battlegroup restart", timeout=120)
    if restart.returncode != 0:
        raise RuntimeError(restart.stderr.strip() or restart.stdout.strip() or "Settings applied, but battlegroup restart failed")

    return {
        "userGameFile": str(APPLIED_USERGAME),
        "userEngineFile": str(APPLIED_USERENGINE),
        "applyOutput": install.stdout.strip(),
        "restartOutput": restart.stdout.strip(),
    }


def discover_battlegroups():
    result = run_ssh(
        "sudo kubectl get ns --no-headers -o custom-columns=NAME:.metadata.name 2>/dev/null | "
        "sed -n 's/^funcom-seabass-//p'",
        timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "Could not discover battlegroups")
    battlegroups = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    return sorted(set(battlegroups))


class ManagerHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        if self.path == "/api/server/config":
            json_response(self, {"config": read_manager_config(), "configFile": str(MANAGER_CONFIG)})
            return

        if self.path == "/api/server/discover":
            try:
                battlegroups = discover_battlegroups()
            except Exception as exc:
                json_error(self, 502, f"Battlegroup discovery failed: {exc}")
                return
            json_response(self, {"battlegroups": battlegroups})
            return

        if self.path == "/api/server/rewards":
            json_response(self, {"requests": read_reward_requests()})
            return

        if self.path != "/api/server/settings":
            super().do_GET()
            return

        if APPLIED_PROFILE.exists():
            payload = json.loads(APPLIED_PROFILE.read_text(encoding="utf-8"))
        else:
            payload = {"profileName": "No applied profile", "settings": {}}

        json_response(self, payload)

    def do_POST(self):
        if self.path == "/api/server/config":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                config = write_manager_config(payload if isinstance(payload, dict) else {})
            except Exception:
                json_error(self, 400, "Invalid server setup payload")
                return
            json_response(self, {"ok": True, "config": config, "configFile": str(MANAGER_CONFIG)})
            return

        if self.path == "/api/server/rewards":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                reward_request = sanitize_reward_request(payload)
            except ValueError as exc:
                json_error(self, 400, str(exc))
                return
            except Exception:
                json_error(self, 400, "Invalid JSON payload")
                return

            requests = read_reward_requests()
            reward_request["id"] = f"reward-{len(requests) + 1:04d}"
            try:
                applied = apply_reward_now(reward_request)
                reward_request["status"] = "sent"
                reward_request["appliedAt"] = payload.get("appliedAt") or payload.get("createdAt") or ""
                reward_request["applied"] = applied
                reward_request["note"] = "Items were written immediately with the database save_item function."
            except Exception as exc:
                reward_request["status"] = "failed"
                reward_request["note"] = str(exc)
                requests.insert(0, reward_request)
                REWARD_REQUESTS.write_text(json.dumps(requests, indent=2), encoding="utf-8")
                json_error(self, 502, f"Reward send failed: {exc}")
                return

            requests.insert(0, reward_request)
            REWARD_REQUESTS.write_text(json.dumps(requests, indent=2), encoding="utf-8")
            json_response(self, {
                "ok": True,
                "message": "Reward sent immediately and saved to the admin audit log",
                "request": reward_request,
                "requestFile": str(REWARD_REQUESTS),
            })
            return

        if self.path != "/api/server/settings":
            json_error(self, 404, "Unknown endpoint")
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            json_error(self, 400, "Invalid JSON payload")
            return

        settings = payload.get("settings", {})
        flat_settings = {}
        for section_name, section_settings in settings.items():
            if isinstance(section_settings, dict):
                for key, value in section_settings.items():
                    flat_settings[f"{section_name}.{key}"] = value

        APPLIED_PROFILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        APPLIED_SETTINGS.write_text(json.dumps(flat_settings, indent=2), encoding="utf-8")

        try:
            real_apply = apply_to_self_hosted_server(payload)
        except Exception as exc:
            json_error(self, 502, f"Saved locally, but real self-hosted apply failed: {exc}")
            return

        response = {
            "ok": True,
            "message": "Settings applied to self-hosted Dune server UserSettings and battlegroup restarted",
            "profileFile": str(APPLIED_PROFILE),
            "settingsFile": str(APPLIED_SETTINGS),
            **real_apply,
            "settingCount": len(flat_settings),
        }

        json_response(self, response)


if __name__ == "__main__":
    stop_stale_local_server()
    server = ThreadingHTTPServer(("127.0.0.1", 8812), ManagerHandler)
    print("Dune Awakening Manager receiver running at http://127.0.0.1:8812/")
    if getattr(sys, "frozen", False):
        threading.Timer(1.0, lambda: webbrowser.open("http://127.0.0.1:8812/")).start()
    server.serve_forever()
