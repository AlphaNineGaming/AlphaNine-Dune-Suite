# 1.3.10 — Scheduler runtime detection

Fix scheduler installation incorrectly reporting that BusyBox crond is stopped when it is running. The process check now consumes the complete process list, preventing an early closed pipe from failing the scheduler self-test under pipefail. The installer uses the same check.
