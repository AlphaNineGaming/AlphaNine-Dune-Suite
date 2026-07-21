# Suite-native Market Automator

The market automator is an original AlphaNine Suite component. It operates through the Suite's existing market database functions and does not install, call, bundle, or proxy an external market-bot service.

It is disabled by default. When the template allowlist is empty, automatic listing cycles rotate through normal spawnable, marketable items from the Suite's existing local item catalog. Operators can optionally enter newline-separated template IDs to restrict automation to a specific set. Automatic purchasing remains inactive unless the maximum purchases, unit price, and per-cycle spend are all greater than zero.

Configuration and activity logs are stored in the Suite data directory as `market-automator.json` and `market-automator.log`. Operators can run a listing or buyer cycle manually from the Market page before enabling the scheduler.

Pricing can be fixed or dynamic. Dynamic pricing calculates each new listing independently from the configured base, optional category base, local catalog metadata multipliers, deterministic item and cycle variation, and an optional exact per-item override. The pricing preview uses the same calculator and cycle-ID definition as the listing cycle. Legacy configurations containing a single `price` value migrate to fixed pricing with that value preserved as `basePrice`; dynamic pricing remains review-required until the operator selects Dynamic, reviews the preview, and saves that exact configuration.

Pricing changes apply only to newly created orders. Existing listings are never automatically repriced, removed, or reposted.

The automator intentionally contains no copied item catalog. Automatic selection uses the Suite's existing item catalog and excludes non-spawnable records plus research and recipe-unlock pseudo-items. Every selected template is validated again by the existing live-market posting path before a listing is created.
