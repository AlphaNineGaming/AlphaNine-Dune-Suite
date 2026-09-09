# AlphaNine Dune Suite 1.0.98

Market Bot can now optionally buy random player-owned Exchange listings.

- Player buying is disabled by default and must be explicitly enabled while the bot is paused and Quiescent.
- Administrators control the chance per cycle, maximum purchases, maximum unit price, and maximum total spend.
- Only structurally valid, active listings tied to verified player accounts are eligible.
- Each purchase uses the Exchange seller-payout fulfillment records and is written to the Market Bot audit log.
- The purchased item leaves the market; purchases are irreversible.
- Clean Bot Market and Uninstall Bot still affect only strictly tracked bot-owned listings.
- Schema-2 Market Bot fingerprints remain compatible for safe upgrades from v1.0.97.
