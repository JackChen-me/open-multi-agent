/**
 * Renders the provider-call log as a standalone HTML page for screenshotting.
 *
 *   npx tsx bench/src/render-log.mts --date 2026-08-18 --limit 24
 *
 * The page body is the byte-for-byte stdout of `show-calls.mts`, so the image
 * and the CLI cannot disagree. This is a rendering of the log file, not a
 * capture of a terminal session, and it says so on the page.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { BENCH_ROOT } from './config.mts'

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? undefined : argv[index + 1]
}

const date = flag('date') ?? new Date().toISOString().slice(0, 10)
const limit = flag('limit')
const outPath = path.resolve(flag('out') ?? path.join(BENCH_ROOT, 'runs', date, `${flag('file') ? 'single-run' : (flag('view') ?? 'calls')}-log.html`))

// `--file` renders console output that was captured earlier (a traced single
// run, say); otherwise one of the audit views is executed and its stdout used.
const captured = flag('file')
const view = captured ? 'captured' : (flag('view') ?? 'calls')
const script = view === 'runs' ? 'show-runs.mts' : 'show-calls.mts'
const commandLabel = flag('command')
  ?? (captured ? 'npx tsx bench/src/run-bench.mts --verbose' : `npx tsx bench/src/${script} --date ${date}`)
const stdout = captured
  ? readFileSync(path.resolve(captured), 'utf-8')
  : execFileSync('npx', (() => {
    const args = ['tsx', path.join(BENCH_ROOT, 'src', script), '--date', date]
    if (limit && view !== 'runs') args.push('--limit', limit)
    return args
  })(), { encoding: 'utf-8', cwd: path.resolve(BENCH_ROOT, '..') })

const escaped = stdout
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')

writeFileSync(outPath, `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>OMA benchmark call log ${date}</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0;
    background: #0d1117;
    display: flex;
    justify-content: center;
    padding: 28px 20px 20px;
    font-family: "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
  }
  .frame { width: min(1180px, 100%); }
  .chrome {
    display: flex; align-items: center; gap: 8px;
    background: #21262d; border-radius: 10px 10px 0 0;
    padding: 10px 14px; border: 1px solid #30363d; border-bottom: none;
  }
  .dot { width: 12px; height: 12px; border-radius: 50%; }
  .dot.r { background: #ff5f57; } .dot.y { background: #febc2e; } .dot.g { background: #28c840; }
  .chrome span { color: #8b949e; font-size: 12px; margin-left: 10px; }
  pre {
    margin: 0; background: #0d1117; color: #c9d1d9;
    border: 1px solid #30363d; border-radius: 0 0 10px 10px;
    padding: 18px 20px; font-size: 12.5px; line-height: 1.5;
    /* Wrap rather than clip: a still image has no horizontal scrollbar, and a
       silently truncated token count is worse than a wrapped line. */
    white-space: pre-wrap; word-break: break-word;
    padding-left: 44px; text-indent: -24px;
  }
  .note { color: #6e7681; font-size: 11.5px; margin-top: 10px; line-height: 1.6; }
  .note code { color: #8b949e; }
</style>
</head>
<body>
  <div class="frame">
    <div class="chrome">
      <i class="dot r"></i><i class="dot y"></i><i class="dot g"></i>
      <span>${commandLabel}</span>
    </div>
    <pre>${escaped}</pre>
    <p class="note">
      ${view === 'captured'
        ? `Console output of one traced benchmark run, captured verbatim. Timestamps are the runner's clock; ` +
          `<code>http</code> lines are the recording proxy reporting each provider response as it arrived, with ` +
          `the token counts that response carried.`
        : view === 'runs'
        ? `Rendered from <code>bench/results-${date}.csv</code> and the mtime of each run's saved output in ` +
          `<code>bench/runs/${date}/</code>. Token counts are provider-reported usage captured at the HTTP boundary. ` +
          `This is a rendering of those files, not a capture of a terminal session; every row is checkable against them.`
        : `Rendered from <code>bench/runs/${date}/calls.json</code>, the recording proxy's log of every provider ` +
          `HTTP call. Timestamps and token counts are as returned by the provider; every row can be checked against ` +
          `that file and against <code>bench/results-${date}.csv</code>.`}
    </p>
  </div>
</body>
</html>
`)
console.log(`Wrote ${outPath}`)
