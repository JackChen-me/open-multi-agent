# Observability v2 performance baseline

This document records a reproducible engineering snapshot, not a permanent
marketing promise. Absolute timings depend on Node, CPU, OS, filesystem, power
state, and background load. Release decisions use same-host medians and the RFC
budgets; CI uses deliberately wider gates to avoid hardware-dependent flakes.

## Budgets

| Path | Dedicated benchmark gate | CI guard |
|---|---:|---:|
| no sink wall time | `<1%` median regression versus the OBS-1A identity/status baseline | measured in dedicated release run, not a shallow CI checkout |
| no sink retained memory | `<1 KiB` additional per retained top-level result versus OBS-1A | reported with `--expose-gc`; not an absolute shared-runner gate |
| legacy synchronous callback dispatch | p95 `<10 µs` per completion event | p95 `<100 µs` |
| batching enqueue | p95 `<20 µs` per record | p95 `<200 µs` |
| OTel conversion + in-memory processor | p95 `<50 µs` per record | p95 `<500 µs` |
| same-host whole-run sink overhead | report relative to no sink | `<1,000%` to catch order-of-magnitude regressions |

The wide CI thresholds are 10x the dedicated microsecond budgets. They are a
regression alarm, not the release acceptance result.

## Matrix and method

The existing benchmark scripts remain the shared harness:

| Matrix row | Harness and statistic |
|---|---|
| no sink | `observability-no-sink.mjs`; alternating baseline/candidate rounds, median wall time |
| no-sink memory | same harness under `--expose-gc`; retained result arrays, alternating median bytes/result |
| legacy callback | `observability-sinks.mjs`; full-run medians plus direct legacy dispatch p95 |
| `BatchingTraceSink` | full-run medians and synchronous enqueue p95 |
| `InMemoryTraceStore` | 1k/10k append, first-page query, and estimated retained heap |
| `FileTraceStore` | 1k/10k append, fsync, reopen, full query, compaction, file size, and batch-size comparison |
| OTel adapter | official `InMemorySpanExporter` + `SimpleSpanProcessor`; per-record p95 and 1k/10k batches |
| 1/10/100-agent equivalent envelopes | metadata-only start/end record sets; bytes and enqueue p95 |
| streaming metadata | 10k payload-free `stream_chunk` events; bytes and enqueue p95 |
| queue pressure/drop | record-count and byte-pressure snapshots from bounded queues |

Commands from the repository root after building:

```bash
# Same-host historical comparison. The baseline must be a separately built
# OBS-1A/core dist, while candidate is this checkout's core dist.
node --expose-gc packages/core/benchmarks/observability-no-sink.mjs \
  /tmp/oma-obs1a-baseline/packages/core/dist/index.js \
  packages/core/dist/index.js

# Sink/store/OTel matrix.
node --expose-gc packages/core/benchmarks/observability-sinks.mjs \
  packages/core/dist/index.js packages/otel/dist/index.js

# File durability and query boundary.
node --expose-gc packages/core/benchmarks/file-trace-store.mjs

# Tolerant CI gate.
npm run bench:observability:ci
```

Defaults are nine alternating rounds and 2,000 top-level runs for the historical
comparison. Override with `OMA_BENCH_ITERATIONS`, `OMA_BENCH_ROUNDS`,
`OMA_BENCH_MEMORY_ITERATIONS`, and `OMA_BENCH_MEMORY_ROUNDS`. Record all
overrides with the result.

## Current release snapshot

Final OBS-5 dedicated run: Node `v22.22.3`, macOS/Darwin `25.5.0`
`darwin-arm64`, Apple M1. Historical wall-time comparison used 2,000 runs × 9
alternating rounds; retained-memory comparison used 2,000 retained results × 3
alternating rounds. Microsecond p95 samples used 10,000 legacy/batching events
and 1,000 post-warm-up OTel records.

| Check | Result | Gate |
|---|---:|---:|
| no-sink median regression | `-0.530%` (18.743 ms baseline; 18.644 ms candidate) | `<1%` |
| additional retained bytes/result | `-1.18 B` (1,154.16 B baseline; 1,152.98 B candidate) | `<1,024 B` |
| legacy dispatch p95 | `0.125 µs` | `<10 µs` |
| batching enqueue p95 | `1.250 µs` | `<20 µs` |
| OTel conversion/processor p95 | `15.208 µs` | `<50 µs` |

All five dedicated gates pass. The historical baseline is the built OBS-1A
merge `58096804a04c241a4c02943050acc4c89c884a85`; key source blobs in the
baseline snapshot were hash-matched to that commit before measurement.

### Matrix snapshot

| Path | 1k records | 10k records |
|---|---:|---:|
| InMemory append | 5.14 ms | 36.33 ms |
| InMemory first-page query | 15.20 ms | 42.46 ms |
| InMemory estimated retained heap | 414,384 B | 1,878,976 B |
| OTel convert + in-memory process | 12.24 ms | 79.00 ms |
| File append (write-complete) | 12.47 ms | 84.80 ms |
| File fsync | 3.56 ms | 7.60 ms |
| File reopen/index rebuild | 9.77 ms | 63.51 ms |
| File full paginated query | 16.33 ms | 339.57 ms |
| File compaction | 32.65 ms | 933.37 ms |

The file rows represent 500/5,000 logical runs (two records each). File sizes
were 431,818/4,393,820 bytes before compaction and 427,810/4,353,812 bytes
after. For 1,000 records, append time by batch size was 158.99 ms (1), 26.62 ms
(10), 9.04 ms (100), and 7.92 ms (1,000).

Equivalent metadata envelopes produced enqueue p95 of 1.291 µs (1 agent),
1.250 µs (10 agents), and 1.250 µs (100 agents), using at least 1,000 timing
samples per row. The representative 100-agent envelope was 202,500 bytes for
402 records, 1.21% of the default 16 MiB queue. Ten thousand payload-free
stream metadata events occupied 4,196,674 bytes and enqueued at 1.084 µs p95.

Pressure injection behaved as designed: a 100-record queue accepted 1,000
events, retained 100, and reported 900 drops; a four-record-equivalent byte
limit accepted 100, retained 4, and reported 96 drops. No unbounded growth or
silent loss was observed.

Whole deterministic-run medians were 9.001 µs/run (no sink), 15.185 µs/run
(legacy callback), and 59.117 µs/run (batch sink). These end-to-end relative
figures include creation and JSON byte accounting for six v2 records per run;
the RFC release gates are the hot-path p95 and historical no-sink comparison,
not a promise that enabled tracing has zero total work.

## Content capture boundary

There is no public content-on mode in this release. `TraceCapturePolicy` keeps
the default metadata-only contract and `@open-multi-agent/otel` exposes only a
disabled content-capture extension point. Therefore content-on benchmarking is
explicitly a non-goal, not a missing benchmark row. No synthetic prompt or tool
payload path is added merely to satisfy the matrix; metadata-only remains the
product baseline.

## Interpreting storage numbers

- `InMemoryTraceStore` numbers include in-process indexes and are not a
  durability claim.
- `FileTraceStore.append()` is write-complete, while `flush()` and `close()` are
  the fsync boundary. Report both separately.
- Reopen time includes a full append-log scan and in-memory index rebuild.
- Compaction is same-directory temp write, fsync, atomic rename, and best-effort
  parent-directory fsync. It is not a database vacuum or multi-process test.
- Queue-pressure output is expected to show drops. Passing means memory remains
  bounded and the drops appear in stats/diagnostics, not that no record is ever
  dropped.
