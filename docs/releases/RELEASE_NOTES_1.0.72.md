# AlphaNine Dune Suite 1.0.72

## Named Give Item storage destinations

- Give Item storage destinations now read valid in-game container names from the server database.
- Custom names appear first in the picker, followed by the derived container type, actor ID, and current slot usage.
- Storage search now matches custom names and container types, making named containers such as `Fuel Cells` directly searchable.
- The selected-target details and storage-deposit result preserve both the custom name and the technical container type.

## Compatibility and fallback behavior

- Unnamed storage containers continue to use the existing class-derived label.
- Internal placeholder names and `None` values are ignored.
- Player-inventory Give Item routing and storage-deposit safety checks are unchanged.
