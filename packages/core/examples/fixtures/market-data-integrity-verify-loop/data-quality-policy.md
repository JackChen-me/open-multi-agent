# MOCK Market Data Quality Policy

This synthetic policy is for the cookbook scenario only.

## Decisions

- `ACCEPT`: the snapshot-to-stream bridge invariant passes, retained update IDs
  are continuous, quantities are valid, the reconstructed book never crosses,
  and no unexplained collector interruption overlaps market activity.
- `QUARANTINE`: any missing update-ID range is proven, or a reconnect overlaps
  independent trade activity without a verified snapshot bridge. The interval
  must not enter backtests until replacement data passes every acceptance rule.
- `REPAIR_REQUIRED`: evidence is inconclusive but a deterministic repair can be
  attempted. Name the missing source and do not claim the interval is valid.

## Required report fields

Every non-accept decision must include the affected time or update-ID range,
the violated invariant, the source that proves it, and a remediation. For a
snapshot boundary gap, redownload a fresh snapshot plus diff-depth overlap that
starts before or at `lastUpdateId + 1`, replay the bridge check, and replace the
entire quarantined interval rather than splicing isolated book levels.
