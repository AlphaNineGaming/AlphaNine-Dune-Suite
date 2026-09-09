# AlphaNine Dune Suite 1.0.69

## Market Automator pricing preview

- Replaced the cramped pricing-preview grid with a clean, semantic table showing Item, Grade, Tier, Category, and Price.
- Rebalanced the Market Automator workspace so the preview receives two-thirds of the available width instead of overflowing from a narrow settings column.
- Added a contained scroll region, sticky column headings, alternating rows, metadata badges, highlighted Solari prices, and a visible sample count.
- Kept advanced pricing factors and template identifiers out of the normal preview while preserving the existing Advanced settings and JSON configuration support.
- Confirmed the redesigned preview works in both AlphaNine Gold and Royal Desert themes without page-level or table-level horizontal overflow at the reported desktop resolution.

## Pricing behavior

- No Market Automator pricing calculations, presets, deterministic seeds, overrides, listing execution, or existing-order behavior were changed.
- The preview continues to use the same production pricing function as newly created listings.

## Validation

- Market Automator regression tests, including distinct per-item pricing.
- Market listing regression tests.
- Rendered Suite UI syntax test.
- Packaged application smoke test.
