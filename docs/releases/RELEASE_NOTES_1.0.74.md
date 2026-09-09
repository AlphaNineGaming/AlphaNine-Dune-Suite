# AlphaNine Dune Suite 1.0.74

## Landsraad ambiguity display

- Ambiguous Landsraad reward configurations now show one concise warning instead of repeating the complete API response.
- Detected thresholds are available as a readable list under an expandable Advanced Details section.
- The tier list and preview log use neutral placeholders while editing is unavailable.
- Generate Preview + Backup, the confirmation input, and Apply Tier Changes are visibly disabled whenever tier detection fails.
- Failed tier detection clears any stale preview and confirmation state.
- API failure formatting now extracts the structured `reason` field without rendering raw JSON or `[object Object]`.

## Safety policy

- Mixed active and historical reward groups remain fail-closed; this release does not choose a group by threshold value, position, or row count.
- The existing backup, confirmation, table lock, transaction, stale-preview detection, and read-back verification remain unchanged for valid exact-five configurations.
- Read-only schema investigation confirmed that reward groups are related through `landsraad_task_rewards.task_id`, `landsraad_tasks.term_id`, and `landsraad_decree_term.term_id`. A future selector must prove exactly one current non-test term and exactly five joined thresholds before enabling writes.
