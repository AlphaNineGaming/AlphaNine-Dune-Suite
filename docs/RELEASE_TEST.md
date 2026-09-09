# Release Test Checklist

1. Install the EXE.
2. Launch from the Desktop shortcut.
3. Confirm AlphaNine Dune Suite opens.
4. Confirm `server.js` starts automatically.
5. Confirm the receiver starts when live give env is configured.
6. Confirm Admin Probe works.
7. Confirm live give still works with quality `0`.
8. Confirm the app closes and child processes stop.
9. Open Database Explorer locally and confirm schemas, tables, column metadata, and the first row page load from the selected battlegroup.
10. Confirm Database Explorer filtering, header sorting, Previous/Next navigation, selected-row details, and CSV/JSON page export.
11. Confirm Database Explorer is hidden and its `/api/database-browser/` routes return 403 from LAN, HTTPS, and internet portal access.
12. Confirm a filter value containing quotes, `%`, `_`, and SQL text remains a value and cannot alter the generated query.
