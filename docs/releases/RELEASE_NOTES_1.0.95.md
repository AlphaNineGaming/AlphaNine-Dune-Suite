# AlphaNine Dune Suite 1.0.95

## Market Bot repair launch fix

Version 1.0.94 exposed the safe **Repair / Update Bot** workflow but omitted two VM path constants from the server runtime import. Repair stopped before making remote changes with:

> VM_MARKET_BOT_PAUSE_MARKER is not defined

Version 1.0.95 imports both repair-boundary paths and adds a regression assertion against the actual server import block. The repair remains fail-closed and still verifies the pause marker, absent cycle lease, bot-specific advisory lock, stable tracked listings, and zero unfinished cycles before replacing the VM runtime.
