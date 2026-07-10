# AlphaNine Dune Suite 1.0.30

Market Bot stock-control update built around predictable NPC supply and player-only buying.

## Highlights

- Replaces the normal simulation controls with five clear economy settings: buy timer, list timer, AI order minimum, AI order maximum, and maximum player-order buys.
- Maintains a random pool of 30-60 NPC listings by default.
- Refills only when NPC stock falls below the configured minimum.
- Prunes bot-owned NPC stock when it exceeds the configured maximum.
- Automatic and full-cycle buying target player listings only; the bot no longer consumes its own NPC listings.
- Defaults to checking player listings every 20 minutes, checking NPC stock every 30 minutes, and buying at most two player listings per cycle.

## Admin Notes

- Use **Install / Update Bot** once after updating the Suite so the VM receives the new Market Bot binary and deployment settings.
- Existing player and NPC market listings are preserved during the update.
- The household simulation API remains internally compatible but is disabled in the shipped configuration and removed from the normal Suite workflow.
