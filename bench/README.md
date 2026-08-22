# OMA A/B benchmark

Measures what multi-agent orchestration actually costs and buys, on two tasks
taken from `packages/core/examples/cookbook/`, against a single-agent baseline
pursuing the identical goal.

Outputs: `bench/results-<date>.csv` (one row per run), `bench/REPORT.md`
(method, headline numbers, limits), and `bench/runs/<date>/` (every raw output,
the judge verdicts, and a manifest recording the git SHA and full config).

All three are gitignored. The harness is tracked; results belong to whoever ran
them, and a report generated from one operator's models, prices, and day is not
a fact about the framework. Publish a specific run deliberately, with its date,
models and limits attached, rather than by committing it.

## Groups

| Group | Execution | Models |
|---|---|---|
| A | OMA multi-agent orchestration via `runTasks()`, with deterministic model routing and a token budget | mixed tier per role (see `roleModels` in `src/tasks.mts`) |
| B | One agent, one call, same goal, same deliverable | the strong model only |
| C | One agent, one call, same goal, same deliverable | the cheap model only |

B and C bracket group A from both sides. A-vs-B alone conflates two effects —
orchestration and model tier — because A runs most of its work on the cheap
tier. Running C isolates them: whatever A gains over *both* single-agent
baselines is attributable to the orchestration, not to the model mix.

## Tasks

| Task | Kind | Source example | Why |
|---|---|---|---|
| `contract-review` | favourable | [contract-review-dag.ts](../packages/core/examples/cookbook/contract-review-dag.ts) | Four roles, a genuine fan-out, and a compliance review independent of the summary it is merged with. |
| `meeting-report` | boundary | [meeting-summarizer.ts](../packages/core/examples/cookbook/meeting-summarizer.ts) | One document in, one report out. A single competent agent does it in one pass, so the multi-agent shape pays for four calls and three copies of the transcript. |

Both are always reported. Reporting only the favourable task would not survive
the first question from an audience.

Group A runs the examples' roles through `runTasks()`; groups B and C run one
agent whose system prompt is those same roles concatenated in DAG order, closed
by the terminal role's output spec. Neither side is given task content the other
lacks. The role prompts are **read out of the example source at load time**
(`src/prompts.mts`), not restated here, so what was measured cannot drift from
what the examples say.

`meeting-summarizer.ts` drives `AgentPool` directly rather than the
orchestrator. Group A ports its four roles to `runTasks()` unchanged, because
model routing and token budgets are orchestrator-level features the experiment
requires. That is the one structural deviation from the example.

## Prerequisites

- `DEEPSEEK_API_KEY` for the models under test.
- An API key for the **judge**. Set `judge.provider` and `judge.model` in
  `config.json`; the runner refuses to start without the matching key.

  A different vendor from the models under test is the stronger control and is
  worth preferring. The shipped config does not use one: it judges DeepSeek with
  DeepSeek, because both candidates in every A-vs-B pair are the same vendor and
  the same model, so vendor self-preference applies to both sides equally, and
  position bias is handled separately by scoring each pair in both orders. That
  symmetry is weaker for A-vs-C, where the two candidates sit on different tiers.
  The runner warns when the judge vendor matches the vendor under test, and
  `REPORT.md` states it in Limits either way. Change `judge.provider` if you want
  the stronger control.
- Prices in `config.json` under `pricing`. Left `null`, the cost column stays
  empty and the report says cost was not computed. The harness never invents a
  rate.

## Running

Offline wiring check — no provider calls, no spend:

```bash
npx tsx bench/src/run-bench.mts --mock --repetitions 1 --groups A,B,C --label mock
```

Paid pilot at n=1, to size the full run before committing to it:

```bash
npx tsx bench/src/run-bench.mts --repetitions 1 --label pilot
```

Full run:

```bash
npx tsx bench/src/run-bench.mts --repetitions 5
```

Harness unit tests (pricing, dispersion, concurrency, CSV round-tripping, judge
aggregation, prompt provenance):

```bash
npm run bench:ab:test
```

`bench/` is not an npm workspace, so it is reached through explicit root scripts
rather than by `--workspaces`. Both are wired into the repository-wide commands
and run in CI: `npm test` ends with `bench:ab:test`, and `npm run lint` ends with
`lint:bench` (`tsc --noEmit -p bench/tsconfig.json`).

Flags: `--repetitions N`, `--tasks a,b`, `--groups A,B,C`, `--config <path>`,
`--out <csv>`, `--label <suffix>`, `--variant <name>`, `--verbose`, `--skip-judge`, `--mock`.

## DAG variants

`--variant` selects how group A's task graph is wired. `as-published` (the
default) reproduces the cookbook example exactly. `fixed-merge` gives each
terminal synthesis task the source material as well as its dependencies' output,
which is the hypothesis that the published graph loses information at the merge.

A variant is a separate experiment, not a replacement headline: run it with its
own `--label`, include group B so each invocation measures its own A-minus-B
gap, and pass both CSVs to the report:

```bash
npx tsx bench/src/run-bench.mts --variant fixed-merge --repetitions 5 \
  --groups A,B --label fixed-merge
npx tsx bench/src/report.mts --csv bench/results-<date>.csv \
  --variant-csv bench/results-<date>-fixed-merge.csv
```

Comparing A-as-published against A-fixed directly is invalid when the two ran on
different days. Comparing the two A-minus-B gaps is not, which is why B is
re-run in every variant invocation.

## Reading and recovering a run

An invocation is identified by its **stamp**: `<date>`, or `<date>-<label>` when
`--label` was passed. It names both the CSV (`bench/results-<stamp>.csv`) and the
raw-data directory (`bench/runs/<stamp>/`), and it is what `--date` below wants —
`--date 2026-08-18-pilot`, not `--date 2026-08-18`.

```bash
npx tsx bench/src/report.mts      --csv bench/results-<stamp>.csv  # regenerate REPORT.md
npx tsx bench/src/show-runs.mts   --date <stamp>                   # per-run audit table
npx tsx bench/src/show-calls.mts  --date <stamp>                   # per-HTTP-call audit table
npx tsx bench/src/render-log.mts  --date <stamp> --view runs       # same table as an HTML page
npx tsx bench/src/merge-judge.mts --date <stamp>                   # recover a stopped judging pass
```

`report.mts` takes a CSV path rather than a stamp, and reads the stamp back out
of the CSV's `run_stamp` column to locate `bench/runs/<stamp>/`. It refuses to
run when the manifest is not there instead of emitting a report whose models and
controlled variables all say `unknown`; pass `--manifest <path>` to point it
somewhere else, or rebuild a missing manifest with `merge-judge`.

`show-runs` works from the CSV plus each saved output's mtime, so it is
available as soon as the runs finish. `show-calls` needs `calls.json`, which is
only written when a whole invocation completes.

`--verbose` traces a single run as it executes — one timestamped line per task
transition and one per provider response, carrying that response's own token
counts — which is the useful form when you want to watch or capture one run
rather than aggregate many:

```bash
npx tsx bench/src/run-bench.mts --verbose --repetitions 1 \
  --tasks contract-review --groups A --skip-judge --label single | tee /tmp/single.log
npx tsx bench/src/render-log.mts --file /tmp/single.log --out /tmp/single.html
qlmanage -t -s 1500 -o /tmp /tmp/single.html   # macOS: HTML to PNG
```

Always pass `--label` for one-off runs so they land in their own CSV and run
directory instead of overwriting the dataset a report was built from.

`run-bench` writes each judge verdict to `runs/<date>/judge-*.json` as it goes
but folds the scores into the CSV only at the end, so an invocation stopped
during judging leaves the CSV without a quality column. `merge-judge` recovers
the verdicts that did complete, reports how many repetitions were actually
scored, and reconstructs the manifest. `report.mts` then carries the smaller
quality sample through to the headline and the limits rather than letting it
pass as a full-n result.

## Controlled variables

Everything below is fixed in `config.json`, applied identically to every group,
and copied into `REPORT.md`.

- **Model versions** — pinned by id and recorded per run and per role.
- **Temperature** — one value for every agent in every group.
- **Thinking** — DeepSeek V4 enables thinking by default at `high` effort, which
  would put a large and highly variable block of reasoning tokens into the
  output column. The benchmark disables it on both sides. Both settings are
  defensible; what is not defensible is letting them differ between groups.
- **Prompt caching** — DeepSeek's context cache cannot be switched off. With
  `cacheBusting: true` each run's system prompts carry a
  `[bench <nonce> <run_id>]` prefix, which defeats the prefix cache identically
  for every group. The `cached_tokens` column then verifies it worked rather
  than assuming it did.

  The nonce is generated per invocation and is not decoration. Run ids are
  deterministic (`task-group-rN`), so a salt built from the run id alone repeats
  across invocations, and a re-run inherits the *previous* attempt's cache. That
  is not hypothetical: it happened on 2026-08-18, where repetition 1 picked up
  cached prefixes from an aborted earlier invocation and is flagged in that
  run's `REPORT.md`.
- **Input** — the same fixture file for every group on a given task.
- **Run order** — group order rotates each repetition (`A>B>C`, then `B>C>A`, …)
  so no group is systematically first, and the order used is recorded per row.

## CSV columns

`run_id`, `date`, `run_stamp`, `task`, `task_kind`, `group`, `variant`, `repetition`,
`group_order`, `role_models` (`role=model;…`), `input_tokens`, `output_tokens`,
`cached_tokens`, `total_tokens`, `est_cost_usd`, `wall_seconds`, `agent_count`,
`parallelism`, `max_concurrent_calls`, `llm_calls`, `success`, `quality_score`,
`quality_by_opponent` (`opponent=score;…`), `judge_model`, `temperature`,
`thinking`, `cache_busting`, `framework_input_tokens`,
`framework_output_tokens`, `budget_exceeded`, `notes`.

Token counts come from a loopback recording proxy (`src/proxy.mts`) that reads
`usage` off each provider response. OMA's own `TokenUsage` is
`{ input_tokens, output_tokens }` with no cache field and no per-model split, so
it cannot price a group-A run that deliberately mixes two tiers.
`framework_*_tokens` carries OMA's numbers alongside, and any disagreement
between the two is written into `notes` rather than reconciled silently.

`parallelism` is the sum of per-call latency divided by the run's wall time:
1.0 is fully serial, 3.0 means three calls' worth of work completed in one
call's worth of wall time. `max_concurrent_calls` is the peak number of
provider calls in flight.

## Quality scoring

Judge-scored, not human-scored — `REPORT.md` states this in the same breath as
any quality number.

Two outputs for one task and repetition are shown to the judge without group
labels, scored against a rubric fixed before any run (`rubric` in
`src/tasks.mts`), and then scored again with the positions swapped. A
candidate's reported score is the mean of its two positions, so a judge that
merely prefers whatever it reads first cannot move the result. Each number is
validated through the repo's own `defineScorer()` contract from
`@open-multi-agent/core/eval`.

**A score belongs to a pairing, not to a run.** Group A is judged once against
each challenger, so an A run carries one score per challenger — two readings of
the same output taken under two different contrasts, not one number measured
twice. `quality_by_opponent` keeps them all, and every comparison in `REPORT.md`
uses the pairing it names: the A-minus-B row subtracts A's score against B, and
A's score against C appears only in the A-vs-C row. `quality_score` is the mean
across a run's pairings, carried for eyeballing a row rather than for any
comparison.

`merge-judge` re-folds the verdict files on disk, so a CSV written before this
column existed is repaired by re-running it against the same `runs/<date>/`.

`createJudgeScorer()` from that same subpath is single-candidate — its verdict
contract hard-requires one top-level `score` — so it cannot carry a pairwise
verdict, and the judge call is made directly instead.

## Reporting rules

- Both tasks are reported. Always.
- `n` and dispersion travel together: median with min/max, never a bare mean.
- If group A costs more tokens, that is what gets reported. The claim then
  becomes a trade — more tokens for less wall time and an independent review
  step — which is still a clean statement about what was measured.
- No result is extrapolated to a task, model, or scale that was not run.
