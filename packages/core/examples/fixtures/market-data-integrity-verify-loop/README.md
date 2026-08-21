# Market Data Integrity Verify Loop Fixtures

All files in this directory are **MOCK** fixtures created for the cookbook
example. They contain no exchange credentials and do not make live network
requests.

| File | Consumer | Purpose |
|---|---|---|
| `depth-updates.json` | Depth sequence extractor | Retained Binance-style diff-depth events that are locally continuous. |
| `aggregate-trades.json` | Trade activity extractor | Independent evidence that the market traded during the suspect boundary window. |
| `snapshot-metadata.json` | Protocol continuity judge | Snapshot-to-stream boundary metadata with an intentionally missing update-ID range. |
| `collector-log.txt` | Backtest risk judge | A collector disconnect, reconnect, and late first buffered event. |
| `data-quality-policy.md` | Backtest risk judge | The decision policy for accept, quarantine, and repair outcomes. |

The conflict is deliberate: the proposer sees only the locally continuous
retained depth events and aggregate trades, so it emits a provisional `ACCEPT`.
The verify hook gives each judge a different withheld source. The judges expose
the boundary gap and reconnect risk, and the proposer must revise the report to
`QUARANTINE` before both judges accept it.
