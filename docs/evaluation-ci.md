# Evaluation in CI

This page answers one question: how do you turn an EvalSet into a pass/fail
signal a CI job can act on? It covers the `oma eval` commands, the `GatePolicy`
contract that decides a verdict, and the baseline workflow that turns an
accepted report into a regression check.

Scorers, EvalSets, stores, and online sampling are in
[evaluation](evaluation.md). The exact argument and exit-code contract for each
command is in [the CLI reference](cli.md#oma-eval-run).

## Run evaluations from the CLI

After building or installing the package, a no-network target can be evaluated
from a shell or CI job:

```bash
oma eval run --set ./evals/greetings.json --target ./evals/target.mjs \
  --report json --report junit --out ./eval-results \
  --gate ./evals/gate.json --baseline ./evals/baseline.json \
  --meta prompt_version=v2
```

The target module must default-export an `EvalTarget` function or
`{ target, scorers? }`. An optional `--scorers` module default-exports a
`Scorer[]`; scorer names must be unique across both sources. The CLI dynamically
imports and executes these user modules with the current process permissions,
so they must be trusted.

Reports are written below `<out>/<evalRunId>/`; `--out` defaults to
`./eval-results`. `--report` is repeatable and defaults to JSON. `--meta
key=value` is also repeatable and all values are strings. See
[the CLI reference](cli.md#oma-eval-run) for the complete argument and exit-code
contract.

Without `--gate`, low scores and `pass: false` records do not change the exit
code. With `--gate`, the stdout summary includes the verdict and its path, and
the exact `{ pass, failures, warnings }` object is written to
`<out>/<evalRunId>/verdict.json`. A failed gate or every selected target failing
exits 1. Usage/file/module errors exit 2. `--baseline` requires `--gate`.

## Gate quality in CI

`evaluateGate()` is pure logic exported from `@open-multi-agent/core/eval`:

```ts
import { evaluateGate } from '@open-multi-agent/core/eval'

const verdict = evaluateGate(report, {
  schemaVersion: 1,
  thresholds: [
    // A rule scorer plus passRate=1 is a deterministic quality gate.
    { scorer: 'exact', metric: 'passRate', min: 1 },
    { scorer: 'relevancy', metric: 'avg', min: 0.8 },
    { scorer: 'relevancy', metric: 'p50', min: 0.85, tag: 'critical' },
  ],
  maxScorerErrorRate: 0.1,
  maxTargetErrorRate: 0,
  baseline: {
    maxRegression: 0.05,
    perScorer: { exact: 0 },
  },
}, baseline)

if (!verdict.pass) process.exitCode = 1
```

The equivalent JSON policy is:

```json
{
  "schemaVersion": 1,
  "thresholds": [
    { "scorer": "exact", "metric": "passRate", "min": 1 },
    { "scorer": "relevancy", "metric": "avg", "min": 0.8 },
    { "scorer": "relevancy", "metric": "p50", "min": 0.85, "tag": "critical" }
  ],
  "maxScorerErrorRate": 0.1,
  "maxTargetErrorRate": 0,
  "baseline": {
    "maxRegression": 0.05,
    "perScorer": { "exact": 0 }
  }
}
```

Thresholds support `avg`, `p50`, `p95`, `min`, and `passRate`, with optional
tag scoping and inclusive `min`/`max` boundaries. A missing scorer, tag, or
`passRate` source is a configuration failure rather than a silent pass. The
health defaults fail when scorer errors exceed 10% of scored plus scorer-error
records, or when any selected target fails.

Every verdict contains only `pass`, `failures`, and `warnings`. A failure has a
stable `kind`, optional scorer/metric/tag coordinates, the observed `actual`,
the configured `limit`, and a human-readable `message`. For failures about
availability rather than a measured score, `missing_scorer` uses `actual: 0`
and `limit: 1`, while `baseline_mismatch` uses `actual: 1` and `limit: 0`.

A baseline is an ordinary JSON `EvalRunReport`, not a second file format. The
recommended workflow is:

1. Run the accepted target with `--report json` and copy its `report.json` to a
   reviewed location such as `evals/baseline.json`.
2. Commit that report together with its versioned EvalSet and gate policy.
3. In CI, compare the candidate report with `--baseline`.
4. Update the baseline only after intentionally reviewing and accepting the
   behavior change; the CLI never updates it automatically.

Set name or version mismatches fail by default. Set
`baseline.allowSetMismatch` to `true` only when a warning plus skipped
regression checks is intended. When a scorer version differs, OMA warns and
skips that scorer's regression checks because a changed judge prompt or model
does not produce a comparable score. Threshold and health checks still run.
If baseline rules are configured but no baseline report is supplied, OMA warns
and skips regression checks.

Use `oma eval gate` when report generation and quality enforcement are separate
CI stages. It prints the exact verdict JSON to stdout:

```bash
oma eval gate --report ./candidate/report.json --gate ./evals/gate.json \
  --baseline ./evals/baseline.json
```

A GitHub Actions job can preserve both machine-readable reports while letting
the gate control the step status:

```yaml
- name: Run deterministic evaluation gate
  run: |
    oma eval run --set ./evals/set.json --target ./evals/target.mjs \
      --gate ./evals/gate.json --baseline ./evals/baseline.json \
      --report json --report junit --out ./eval-results || exit 1

- name: Upload evaluation JUnit report
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: evaluation-junit
    path: eval-results/**/report.junit.xml
```
