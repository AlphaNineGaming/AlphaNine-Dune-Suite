# Skill and Reputation Discovery

Date: 2026-06-05

Scope: read-only inspection of the local AlphaNine Dune Suite code, the live self-hosted Dune PostgreSQL database, Kubernetes/RabbitMQ metadata, and recent server logs. No skill, reputation, faction, or player tables were modified during discovery.

## Summary

The Dune database exposes confirmed storage and functions for specialization track XP/level and faction reputation.

I did not find a plain, confirmed "unspent skill points" column. The confirmed specialization system stores per-track XP and level in `dune.specialization_tracks`. AlphaNine's actor JSON also contains `TechKnowledgePlayerComponent.m_TechKnowledgePoints`, but that appears to be tech/research knowledge, not the specialization skill-point system requested here.

RabbitMQ did not expose a known skill-point or reputation command. The only already-proven live command path in this project remains the existing give-item `ServerCommand: "AddItemToInventory"` path. Do not change that flow for skill/reputation work.

## Player Identity

Confirmed identity mapping for the current character:

| Field | Source | Current value |
| --- | --- | --- |
| `account_id` | `dune.player_state.account_id`, joins `dune.accounts.id` | `2` |
| `character_name` | `dune.player_state.character_name` | `AlphaNine` |
| `funcom_id` | `dune.accounts.funcom_id`, fallback `dune.accounts.user` | `AlphaNine#45674` |
| `player_controller_id` | `dune.player_state.player_controller_id` | `4` |
| `player_state_id` | `dune.player_state.player_state_id` | `5` |
| `player_pawn_id` | `dune.player_state.player_pawn_id` | `6` |

For specialization and reputation systems, the confirmed identifier is actor/player id, not account id:

- `dune.specialization_tracks.player_id` references `dune.actors(id)`.
- `dune.player_faction.actor_id` references `dune.actors(id)`.
- `dune.player_faction_reputation.actor_id` references `dune.actors(id)`.

For the current player, use `player_controller_id = 4`.

## Skill / Specialization Storage

### Confirmed tables

`dune.specialization_tracks`

| Column | Type | Notes |
| --- | --- | --- |
| `player_id` | `bigint` | References `dune.actors(id)`. For AlphaNine this is `player_controller_id = 4`. |
| `track_type` | `dune.specializationtracktype` | Enum value. |
| `xp_amount` | `integer` | Stored specialization XP for the track. |
| `level` | `real` | Stored specialization level for the track. |

Primary key: `(player_id, track_type)`

Foreign key: `player_id -> dune.actors(id) ON DELETE CASCADE`

Current row count on this server: `0`

Confirmed enum values for `dune.specializationtracktype`:

- `Invalid`
- `Crafting`
- `Gathering`
- `Exploration`
- `Combat`
- `Sabotage`
- `Count`

Other specialization-related tables:

`dune.purchased_specialization_keystones`

| Column | Type |
| --- | --- |
| `player_id` | `bigint` |
| `keystone_id` | `smallint` |

`dune.specialization_keystones_map`

| Column | Type |
| --- | --- |
| `id` | `smallint` |
| `name` | `text` |

`dune.specialization_refund_id`

| Column | Type |
| --- | --- |
| `player_id` | `bigint` |
| `refund_id` | `smallint` |

### Existing DB functions

Confirmed modification function:

```sql
select dune.set_specialization_xp_and_level(
  in_player_id bigint,
  in_track_type dune.specializationtracktype,
  in_xp_amount integer,
  in_level real
);
```

Function behavior:

```sql
INSERT INTO specialization_tracks (player_id, track_type, xp_amount, level)
VALUES (...)
ON CONFLICT(player_id, track_type)
DO UPDATE SET xp_amount = in_xp_amount, level = in_level;
```

Related reset functions:

```sql
select dune.reset_specialization_tracks(in_player_id bigint);
select dune.reset_specialization_keystones(in_player_id bigint);
```

Keystone functions found:

```sql
select dune.purchase_specialization_keystone(in_player_id bigint, in_keystone text);
select dune.update_specialization_refund_id(in_player_id bigint, in_refund_id smallint, in_removed_keystones text[]);
```

### Safe update method

Use the existing function, not direct table writes:

```sql
select dune.set_specialization_xp_and_level(4, 'Combat'::dune.specializationtracktype, 1000, 5);
```

For "Set Skill Points", the safe interpretation is "set specialization XP/level for a track." There is no confirmed unspent skill-points field.

For "Give Skill Points", the safe implementation should read the current `xp_amount` for `(player_controller_id, track_type)`, add the requested amount, calculate or accept the target level, then call `set_specialization_xp_and_level(...)`.

### Rollback method

Before writing, record the exact previous row:

```sql
select player_id, track_type::text, xp_amount, level
from dune.specialization_tracks
where player_id = 4 and track_type = 'Combat'::dune.specializationtracktype;
```

If a row existed, rollback with:

```sql
select dune.set_specialization_xp_and_level(4, 'Combat'::dune.specializationtracktype, <old_xp_amount>, <old_level>);
```

If no row existed before the write, rollback with:

```sql
delete from dune.specialization_tracks
where player_id = 4 and track_type = 'Combat'::dune.specializationtracktype;
```

That rollback delete is a direct table write. It should only be used as a rollback after auditing the pre-write state. A safer UI should log the pre-write state and expose rollback SQL, not run destructive rollback automatically.

## Reputation Storage

### Confirmed tables

`dune.player_faction`

| Column | Type | Notes |
| --- | --- | --- |
| `actor_id` | `bigint` | References `dune.actors(id)`. |
| `faction_id` | `smallint` | References `dune.factions(id)`. |
| `utc_time_faction_change` | `timestamp with time zone` | Last faction change time. |

Primary key: `actor_id`

`dune.player_faction_reputation`

| Column | Type | Notes |
| --- | --- | --- |
| `actor_id` | `bigint` | References `dune.actors(id)`. For AlphaNine this is `player_controller_id = 4`. |
| `faction_id` | `smallint` | References `dune.factions(id)`. |
| `reputation_amount` | `integer` | Stored reputation amount. |

Primary key: `(actor_id, faction_id)`

Current row counts on this server:

- `dune.player_faction`: `0`
- `dune.player_faction_reputation`: `0`

`dune.factions`

| id | name |
| --- | --- |
| `1` | `Atreides` |
| `2` | `Harkonnen` |
| `3` | `None` |
| `4` | `Smuggler` |

### Existing DB functions

Confirmed modification function:

```sql
select dune.set_player_faction_reputation(
  in_actor_id bigint,
  in_faction_id smallint,
  in_reputation_amount integer
);
```

Function behavior:

```sql
INSERT INTO player_faction_reputation (actor_id, faction_id, reputation_amount)
VALUES (...)
ON CONFLICT (actor_id, faction_id)
DO UPDATE SET reputation_amount = EXCLUDED.reputation_amount;
```

Read helper:

```sql
select * from dune.get_player_current_faction_reputation(in_actor_id bigint);
```

Important limitation: `get_player_current_faction_reputation` reads the current faction from `dune.player_faction`. On this server `player_faction` is currently empty, so per-faction reputation rows may exist independently of "current faction" state.

Related faction function:

```sql
select dune.change_player_faction(
  in_player_id bigint,
  in_faction_id smallint,
  neutral_faction_id smallint,
  in_utc_time_faction_change timestamp
);
```

This function emits `pg_notify('faction_notify_channel', ...)`, unlike the reputation setter.

### Safe update method

Use the existing reputation function, not direct table writes:

```sql
select dune.set_player_faction_reputation(4, 1, 500);
```

For "Add Reputation", read the current row for `(actor_id, faction_id)`, add the delta, then call `set_player_faction_reputation(...)`.

For "Set Reputation", call `set_player_faction_reputation(...)` with the target amount.

### Rollback method

Before writing, record the exact previous row:

```sql
select actor_id, faction_id, reputation_amount
from dune.player_faction_reputation
where actor_id = 4 and faction_id = 1;
```

If a row existed, rollback with:

```sql
select dune.set_player_faction_reputation(4, 1, <old_reputation_amount>);
```

If no row existed before the write, rollback with:

```sql
delete from dune.player_faction_reputation
where actor_id = 4 and faction_id = 1;
```

That rollback delete is a direct table write. It should only be used as audited rollback after recording that the row did not exist before the admin write.

## Live Pickup / Restart Risk

The confirmed setter functions for specialization XP/level and reputation do not call `pg_notify`.

No triggers were found on:

- `dune.specialization_tracks`
- `dune.player_faction_reputation`
- `dune.player_faction`

Because there is no notify in the two setter functions and no table trigger discovered, live pickup is not confirmed. These changes may require one of:

- player relog,
- character reload,
- map/server process reload,
- or full battlegroup restart.

By contrast, `dune.change_player_faction(...)` does emit `faction_notify_channel`, but that changes the player's faction assignment, not reputation amount.

## RabbitMQ Discovery

Game RabbitMQ exchanges found by name included:

- `heartbeats`
- `chat.faction.1`
- `chat.faction.2`
- `chat.faction.3`
- `chat.faction.4`
- faction status exchanges

Game RabbitMQ bindings showed:

- `heartbeats -> queue.server.*`
- routing keys for server ids and `notifications`
- `notifications -> queue.server.*` with routing key `PlayerOnlineState`

Admin RabbitMQ exchanges/queues showed server state, completion, and travel surfaces.

No RabbitMQ exchange, queue, binding, or recent log entry revealed a confirmed skill-point or reputation command. The only proven command payload in this project remains:

```json
{
  "ServerCommand": "AddItemToInventory"
}
```

Do not reuse the give-item RabbitMQ path for skill/reputation unless a real server command name and payload schema are discovered.

## Risks

- The tables are empty on the current server, so first writes create new rows. That increases uncertainty because there is no existing live value to compare.
- `set_specialization_xp_and_level` and `set_player_faction_reputation` are DB upserts only; no live notification was found.
- "Skill points" is not a confirmed DB field. The confirmed data model is specialization XP/level, not unspent points.
- `actors.properties` contains large JSON blobs. AlphaNine's player pawn contains tech knowledge fields such as `m_TechKnowledgePoints`, but this is not confirmed as skill points or reputation and should not be modified by the requested Admin Tools.
- Direct table rollback deletes may be necessary if a function-created row needs removal. That should be treated as manual recovery, not a normal UI action.
- Reputation can be set for a faction even when `dune.player_faction` has no current faction row. The in-game UI may not show it until the player has/changes faction state.

## Recommendation For UI Actions

Add UI actions only for the confirmed functions:

- Give Skill Points: implemented as add specialization XP to a selected track, then call `dune.set_specialization_xp_and_level(...)`.
- Set Skill Points: implemented as set specialization XP/level for a selected track, then call `dune.set_specialization_xp_and_level(...)`.
- Add Reputation: read current `player_faction_reputation`, add delta, then call `dune.set_player_faction_reputation(...)`.
- Set Reputation: call `dune.set_player_faction_reputation(...)`.

Every write must:

- use `player_controller_id`, not `account_id`;
- require confirmation;
- show the exact function call before execution;
- log the previous row for rollback;
- log the result;
- warn that live pickup is not confirmed and may require relog/server restart.

