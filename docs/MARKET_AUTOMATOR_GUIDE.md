# Persistent AlphaNine Market Bot

AlphaNine Market Bot is a Suite-native Linux/amd64 service. The Suite installs and updates it in the Dune VM under `/home/dune/.dune/alphanine-market-bot`, and Alpine OpenRC keeps it running after the Windows Suite closes.

The normal Market page has five operator actions:

- **Enable Market Bot** stages the runtime paused, installs its ownership schema, generates the exact activation preview, and requires explicit confirmation.
- **Economy Style** selects Affordable, Balanced, or Expensive. Expensive is the default.
- **Preview Market** runs the production VM planner without writes and returns every enabled catalog item.
- **Restock Now** runs one capped reconciliation cycle.
- **Pause Bot** stops new cycles while leaving active listings unchanged.

Customize Items intentionally exposes only enable/disable, unit price, stack size, target listing count, and reset. The preview can be searched or filtered by category and tier, and the complete unfiltered plan can be exported as CSV.

## Pricebook and stacks

Prices are static built-in pricebooks, not “dynamic pricing.” Resolution order is:

1. exact per-item override;
2. catalog price or known metadata;
3. category pricebook;
4. a conservative 1,000-Solari baseline for an unknown category.

Stack resolution uses:

1. exact per-item override, bounded by a known catalog maximum;
2. catalog maximum or known stack metadata;
3. category default;
4. a conservative value of 1.

The bundled catalog currently has no populated maximum-stack values, so conservative category/default behavior remains in force until authoritative values are available.

## Reconciliation and ownership

Each cycle:

1. acquires a PostgreSQL advisory transaction lock scoped to the battlegroup;
2. verifies one usable Exchange, its inventory, a valid PostgreSQL clock (optionally cross-checked against a player listing), and the dedicated `AlphaNineMarket` actor marker;
3. recognizes only orders recorded in `public.alphanine_market_bot_listings`;
4. retires invalid ownership records and removes only expired/invalid listings that still match the dedicated actor and NPC flag;
5. counts active managed listings per item;
6. creates only the deficit up to the configured creation and total-value caps;
7. records the cycle result and structured audit in the same transaction.

An existing active listing is never repriced, removed, or reposted. Player listings, untracked NPC listings, manual listings, and Legacy Market Automator listings are never modified by Market Bot.

Repeated cycle IDs return the stored result. A later cycle observes the committed target stock and creates no duplicate deficit. Database credentials are read at runtime from the DB pod and are not stored in Market Bot configuration or logs.

## Migration and rollback

Existing `market-automator.json` settings are snapshotted. Exact template and price overrides are converted into the new per-item model, but migration never activates the new bot automatically. Existing market listings remain untouched and are not adopted by actor class alone.

Activation requires the fingerprint of the exact production preview. The Suite disables the Legacy Market Automator before starting Market Bot, and both API paths reject concurrent operation.

Rollback pauses Market Bot first, restores the preserved Legacy Market Automator configuration disabled for review, and leaves all existing listings unchanged. The legacy implementation remains in the source and is labeled **Legacy Market Automator** until replacement validation is complete.

## Status

The Market page reports Running, Paused, Waiting for Exchange, or Error, plus the last run, last result, created/removed/error counts, next run, installed version, and whether a VM runtime update is required.

“Waiting for Exchange” is a healthy fail-closed state: the bot makes no listing changes until the Exchange, inventory, database clock, actor identity, and database lock are all valid. A player-created listing is not required to initialize the clock.

During VM startup, Kubernetes and database operations use bounded timeouts. If the database pod is not ready, the OpenRC daemon stays fail-closed and retries automatically instead of becoming stuck.
