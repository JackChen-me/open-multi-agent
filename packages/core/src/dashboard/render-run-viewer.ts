/** Pure, self-contained HTML renderer for one OMA run (no filesystem or network I/O). */

import { redactSensitiveObject } from '../utils/redaction.js'
import { DAG_NODE_HEIGHT, DAG_NODE_WIDTH } from './layout-tasks.js'
import { layoutWaterfall } from './layout-waterfall.js'
import {
  buildRunViewerModel,
  type RunViewerInput,
  type RunViewerOptions,
} from './run-viewer-model.js'

/** Escape JSON embedded in a script element so untrusted text cannot close it. */
export function escapeJsonForHtmlScript(json: string): string {
  return json.replace(/<\/script/gi, '<\\/script')
}

export function renderRunViewer(input: RunViewerInput, options: RunViewerOptions = {}): string {
  const model = buildRunViewerModel(input, options)
  const payload = redactSensitiveObject({ ...model, waterfall: layoutWaterfall(model.spans) })
  const dataJson = escapeJsonForHtmlScript(JSON.stringify(payload))

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
  <title>OMA Run Viewer</title>
  <style>
    :root {
      color-scheme: dark;
      --ink: #e8edf5;
      --muted: #8995a8;
      --faint: #586476;
      --void: #070a0e;
      --deck: #0d1118;
      --panel: #121823;
      --panel-2: #171f2b;
      --line: #263141;
      --line-strong: #3b495d;
      --mint: #79f2c0;
      --cyan: #64d9ff;
      --amber: #ffc857;
      --coral: #ff6b6b;
      --violet: #b9a3ff;
      --radius: 3px;
      --shadow: 0 20px 50px rgba(0,0,0,.32);
      --display: "Avenir Next Condensed", "Roboto Condensed", "Arial Narrow", sans-serif;
      --body: "Avenir Next", "Segoe UI", sans-serif;
      --mono: "SFMono-Regular", "Roboto Mono", "Cascadia Code", monospace;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; background: var(--void); color: var(--ink); }
    body {
      font-family: var(--body);
      background-image:
        linear-gradient(rgba(121,242,192,.025) 1px, transparent 1px),
        linear-gradient(90deg, rgba(121,242,192,.025) 1px, transparent 1px),
        radial-gradient(circle at 85% -10%, rgba(100,217,255,.09), transparent 34%);
      background-size: 32px 32px, 32px 32px, auto;
      overflow: hidden;
    }
    button, input, select { font: inherit; }
    button, select { color: inherit; }
    button:focus-visible, input:focus-visible, select:focus-visible {
      outline: 2px solid var(--cyan); outline-offset: 2px;
    }
    .shell { height: 100vh; display: grid; grid-template-rows: auto auto auto auto minmax(0,1fr); }
    .masthead {
      min-width: 0; display: grid; border-bottom: 1px solid var(--line); background: rgba(7,10,14,.93);
    }
    .masthead-primary {
      min-height: 70px; padding: 13px 22px; display: flex; align-items: center;
      justify-content: space-between; gap: 28px;
    }
    .brand { min-width: 260px; }
    .eyebrow, .metric-label, .control-label, .detail-label, .attempt-label {
      font: 700 10px/1.1 var(--mono); letter-spacing: .13em; text-transform: uppercase;
      color: var(--muted);
    }
    .brand h1 { margin: 4px 0 0; font: 800 25px/.95 var(--display); letter-spacing: .05em; text-transform: uppercase; }
    .brand h1::before { content: "//"; color: var(--mint); margin-right: 8px; }
    .summary-grid {
      min-width: 0; display: grid; grid-template-columns: repeat(10, minmax(120px, 1fr));
      overflow-x: auto; scrollbar-width: thin; border-top: 1px solid var(--line);
    }
    .metric { min-width: 120px; min-height: 56px; display: grid; align-content: center; padding: 9px 14px; border-right: 1px solid var(--line); }
    .metric:last-child { border-right: 0; }
    .metric-value { display: block; margin-top: 5px; overflow: hidden; text-overflow: ellipsis; font: 700 13px/1 var(--mono); white-space: nowrap; }
    .run-context {
      min-width: 320px; max-width: min(48vw, 620px); display: grid;
      grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 10px;
    }
    .run-id-label { white-space: nowrap; }
    .run-id-box {
      min-width: 0; display: flex; align-items: center; gap: 8px; padding: 5px 5px 5px 10px;
      border: 1px solid var(--line); background: rgba(18,24,35,.72);
    }
    .run-id { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; font: 11px/1.3 var(--mono); color: #b6c0cf; white-space: nowrap; }
    .icon-btn, .fit-btn, .load-more {
      border: 1px solid var(--line-strong); background: var(--panel); border-radius: var(--radius);
      cursor: pointer; min-height: 32px; padding: 6px 10px; font: 700 10px/1 var(--mono);
      letter-spacing: .08em; text-transform: uppercase;
    }
    .icon-btn:hover, .fit-btn:hover, .load-more:hover { border-color: var(--cyan); color: var(--cyan); }
    .warning-strip { display: none; padding: 9px 22px; gap: 8px; align-items: center; background: #251f12; border-bottom: 1px solid #5a4820; color: #ffd989; font: 12px/1.3 var(--mono); }
    .warning-strip.visible { display: flex; }
    .routing-summary {
      display: none; grid-template-columns: minmax(180px,.75fr) minmax(240px,1.25fr) minmax(260px,1.5fr);
      border-bottom: 1px solid var(--line); background: rgba(18,24,35,.96);
    }
    .routing-summary.visible { display: grid; }
    .routing-card { min-width: 0; padding: 11px 18px; border-right: 1px solid var(--line); }
    .routing-card:last-child { border-right: 0; }
    .routing-value { margin-top: 6px; font: 700 13px/1.35 var(--mono); color: var(--ink); overflow-wrap: anywhere; }
    .routing-meta { margin-top: 5px; font: 10px/1.35 var(--mono); color: var(--muted); overflow-wrap: anywhere; }
    .toolbar {
      padding: 10px 18px; display: flex; align-items: end; gap: 9px; border-bottom: 1px solid var(--line);
      background: rgba(13,17,24,.96); overflow-x: auto;
    }
    .tabs { display: flex; align-self: stretch; gap: 2px; margin-right: 8px; }
    .tab {
      min-width: 112px; padding: 0 15px; border: 0; border-bottom: 2px solid transparent;
      background: transparent; color: var(--muted); cursor: pointer; font: 800 12px/1 var(--display);
      letter-spacing: .12em; text-transform: uppercase;
    }
    .tab[aria-selected="true"] { color: var(--ink); border-color: var(--mint); background: rgba(121,242,192,.04); }
    .control { display: grid; gap: 5px; min-width: 128px; }
    .control.search { min-width: 230px; flex: 1; max-width: 380px; }
    .control input, .control select {
      height: 34px; width: 100%; border: 1px solid var(--line); background: var(--void);
      border-radius: var(--radius); padding: 0 10px; color: var(--ink); font: 12px/1 var(--mono);
    }
    .result-count { margin-left: auto; padding-bottom: 8px; white-space: nowrap; font: 11px/1 var(--mono); color: var(--muted); }
    .workspace { grid-row: 5; min-height: 0; display: grid; grid-template-columns: minmax(0,1fr) 360px; }
    .stage { min-width: 0; min-height: 0; position: relative; background: rgba(7,10,14,.58); }
    .view { position: absolute; inset: 0; min-height: 0; }
    .view[hidden] { display: none; }
    .empty { display: grid; place-items: center; height: 100%; color: var(--muted); font: 12px/1.5 var(--mono); text-align: center; padding: 30px; }
    .dag-tools { position: absolute; z-index: 4; right: 14px; top: 14px; display: flex; gap: 6px; }
    .dag-viewport { position: absolute; inset: 0; overflow: hidden; cursor: grab; }
    .dag-viewport.dragging { cursor: grabbing; }
    .dag-canvas { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
    .dag-edges { position: absolute; inset: 0; pointer-events: none; overflow: visible; }
    .dag-nodes { position: absolute; inset: 0; }
    .dag-node {
      position: absolute; width: ${DAG_NODE_WIDTH}px; min-height: ${DAG_NODE_HEIGHT}px; padding: 16px 17px 14px;
      text-align: left; color: var(--ink); border: 1px solid var(--line);
      background: linear-gradient(145deg, rgba(23,31,43,.98), rgba(12,16,23,.98));
      box-shadow: 0 12px 28px rgba(0,0,0,.24); cursor: pointer; border-radius: var(--radius);
    }
    .dag-node:hover { border-color: var(--line-strong); transform: translateY(-1px); }
    .dag-node.selected { border-color: var(--cyan); box-shadow: 0 0 0 1px var(--cyan), 0 15px 35px rgba(0,0,0,.4); }
    .node-top { display: flex; justify-content: space-between; gap: 10px; }
    .node-id { font: 700 10px/1 var(--mono); letter-spacing: .08em; color: var(--cyan); }
    .status-pill { padding: 4px 7px; border: 1px solid currentColor; font: 700 9px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; }
    .node-title { margin: 19px 0 17px; font: 750 16px/1.2 var(--display); letter-spacing: .015em; }
    .node-meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--muted); font: 11px/1 var(--mono); }
    .waterfall { height: 100%; overflow: auto; scrollbar-color: var(--line-strong) transparent; }
    .waterfall-head {
      position: sticky; top: 0; z-index: 5; display: grid; grid-template-columns: minmax(270px,34%) 1fr 82px;
      min-width: 840px; height: 40px; align-items: center; border-bottom: 1px solid var(--line-strong);
      background: rgba(13,17,24,.97); font: 700 9px/1 var(--mono); color: var(--muted); letter-spacing: .12em; text-transform: uppercase;
    }
    .waterfall-head > * { padding: 0 12px; }
    .attempt { min-width: 840px; }
    .attempt-header {
      position: sticky; top: 40px; z-index: 4; display: flex; justify-content: space-between;
      padding: 8px 12px; background: #101722; border-bottom: 1px solid var(--line);
    }
    .attempt-range { font: 10px/1 var(--mono); color: var(--muted); }
    .wf-row {
      display: grid; grid-template-columns: minmax(270px,34%) 1fr 82px; min-height: 38px;
      align-items: stretch; border-bottom: 1px solid rgba(38,49,65,.62); background: rgba(10,14,19,.38);
    }
    .wf-row:hover { background: rgba(100,217,255,.035); }
    .wf-row.selected { background: rgba(100,217,255,.08); box-shadow: inset 2px 0 var(--cyan); }
    .wf-label { display: flex; align-items: center; gap: 4px; padding: 4px 7px; min-width: 0; }
    .wf-select {
      min-width: 0; flex: 1; border: 0; background: transparent; color: var(--ink); cursor: pointer;
      text-align: left; display: flex; align-items: center; gap: 7px; padding: 4px 2px;
    }
    .disclosure {
      width: 22px; height: 22px; flex: 0 0 22px; border: 0; background: transparent;
      color: var(--muted); font: 13px/1 var(--mono); text-align: center; cursor: pointer;
    }
    .disclosure:hover { color: var(--cyan); background: rgba(100,217,255,.08); }
    .disclosure-spacer { cursor: default; }
    .kind-dot { width: 7px; height: 7px; flex: 0 0 7px; background: var(--faint); }
    .kind-dot.llm { background: var(--violet); }
    .kind-dot.tool { background: var(--amber); }
    .kind-dot.task { background: var(--mint); }
    .kind-dot.agent { background: var(--cyan); }
    .kind-dot.routing { background: var(--coral); }
    .wf-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 700 11px/1.2 var(--mono); }
    .wf-kind { color: var(--faint); font-size: 9px; text-transform: uppercase; }
    .wf-track {
      position: relative; align-self: center; height: 22px; margin: 0 12px;
      background-image: linear-gradient(90deg, transparent 24.8%, var(--line) 25%, transparent 25.2%, transparent 49.8%, var(--line) 50%, transparent 50.2%, transparent 74.8%, var(--line) 75%, transparent 75.2%);
    }
    .wf-bar { position: absolute; top: 5px; height: 12px; min-width: 3px; background: var(--cyan); opacity: .86; box-shadow: 0 0 12px rgba(100,217,255,.18); }
    .wf-bar.kind-llm { background: var(--violet); }
    .wf-bar.kind-tool { background: var(--amber); }
    .wf-bar.kind-task { background: var(--mint); }
    .wf-bar.kind-routing { background: var(--coral); }
    .wf-bar.failed { background: var(--coral); }
    .wf-bar.incomplete { background: repeating-linear-gradient(90deg, var(--amber), var(--amber) 5px, transparent 5px, transparent 8px); border: 1px solid var(--amber); }
    .wf-unknown { position: absolute; left: 3px; top: 4px; color: var(--faint); font: 9px/1 var(--mono); }
    .wf-duration { display: grid; place-items: center end; padding-right: 12px; font: 10px/1 var(--mono); color: var(--muted); }
    .load-more-wrap { padding: 16px; text-align: center; border-bottom: 1px solid var(--line); }
    .details { min-width: 0; border-left: 1px solid var(--line); background: rgba(13,17,24,.97); overflow: auto; }
    .detail-empty { display: grid; place-items: center; min-height: 100%; padding: 30px; text-align: center; color: var(--muted); font: 12px/1.5 var(--mono); }
    .detail-content { padding: 18px; }
    .detail-head { display: flex; justify-content: space-between; gap: 10px; padding-bottom: 15px; border-bottom: 1px solid var(--line); }
    .detail-head > .status-pill { display: grid; place-items: center; text-align: center; }
    .detail-title { margin: 4px 0 0; font: 800 20px/1.05 var(--display); letter-spacing: .02em; }
    .detail-section { padding: 15px 0; border-bottom: 1px solid var(--line); }
    .detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 10px; }
    .detail-value { display: block; margin-top: 4px; color: var(--ink); font: 11px/1.35 var(--mono); overflow-wrap: anywhere; }
    .detail-list { margin: 9px 0 0; padding: 0; list-style: none; display: grid; gap: 7px; }
    .detail-list li { padding: 8px; background: var(--panel-2); border-left: 2px solid var(--line-strong); font: 10px/1.4 var(--mono); overflow-wrap: anywhere; }
    .error-box { border-left-color: var(--coral) !important; color: #ffb3b3; }
    .source-chip { color: var(--mint); }
    .status-ok, .status-completed { color: var(--mint); }
    .status-error, .status-failed, .status-timeout, .status-budget_exhausted, .status-rejected { color: var(--coral); }
    .status-suspended { color: var(--amber); }
    .status-in_progress, .status-pending { color: var(--amber); }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
    @media (max-width: 940px) {
      body { overflow: auto; }
      .shell { min-height: 100vh; height: auto; grid-template-rows: auto auto auto auto; }
      .masthead { max-width: 100vw; }
      .masthead-primary { align-items: flex-start; flex-wrap: wrap; }
      .brand { flex: 1 1 260px; }
      .run-context { margin-left: auto; max-width: 440px; }
      .toolbar { align-items: center; flex-wrap: wrap; overflow: visible; }
      .tabs { height: 42px; width: 100%; }
      .control.search { min-width: 100%; max-width: none; }
      .control { min-width: calc(50% - 6px); flex: 1; }
      .result-count { width: 100%; margin: 0; }
      .workspace { grid-template-columns: 1fr; grid-template-rows: 600px auto; }
      .details { border-left: 0; border-top: 1px solid var(--line); min-height: 320px; max-height: none; }
    }
    @media (max-width: 520px) {
      .masthead-primary { padding: 12px 14px; gap: 14px; }
      .brand { min-width: 0; }
      .brand h1 { font-size: 20px; }
      .run-context { min-width: 0; max-width: none; width: 100%; margin-left: 0; grid-template-columns: 1fr; gap: 6px; }
      .toolbar { padding: 8px 10px; }
      .routing-summary.visible { grid-template-columns: 1fr; max-height: 220px; overflow: auto; }
      .routing-card { border-right: 0; border-bottom: 1px solid var(--line); }
      .routing-card:last-child { border-bottom: 0; }
      .tab { min-width: 0; flex: 1; }
      .workspace { grid-template-rows: 520px auto; }
      .detail-grid { grid-template-columns: 1fr; }
    }
    @media (prefers-reduced-motion: no-preference) {
      .dag-node, .wf-row { transition: border-color .16s ease, background-color .16s ease, transform .16s ease, box-shadow .16s ease; }
      .warning-strip.visible { animation: reveal .25s ease-out; }
      @keyframes reveal { from { opacity: 0; transform: translateY(-4px); } }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="masthead">
      <div class="masthead-primary">
        <div class="brand"><span class="eyebrow">Open Multi Agent / Post-run artifact</span><h1 id="viewerTitle">OMA Run Viewer</h1></div>
        <div class="run-context">
          <span class="metric-label run-id-label">Run ID</span>
          <div class="run-id-box"><span id="runId" class="run-id">No run ID</span><button id="copyRunId" class="icon-btn" type="button">Copy</button><span id="copyStatus" class="sr-only" aria-live="polite"></span></div>
        </div>
      </div>
      <div id="summaryGrid" class="summary-grid" aria-label="Run summary"></div>
    </header>
    <div id="warningStrip" class="warning-strip" role="status"></div>
    <section id="routingSummary" class="routing-summary" aria-label="Routing decision and actual execution"></section>
    <div class="toolbar">
      <div class="tabs" role="tablist" aria-label="Run views">
        <button id="dagTab" class="tab" type="button" role="tab" aria-controls="dagView">DAG</button>
        <button id="waterfallTab" class="tab" type="button" role="tab" aria-controls="waterfallView">Waterfall</button>
      </div>
      <label class="control search"><span class="control-label">Search</span><input id="searchInput" type="search" placeholder="task, agent, model, tool…"></label>
      <label class="control"><span class="control-label">Kind</span><select id="kindFilter"><option value="">All kinds</option></select></label>
      <label class="control"><span class="control-label">Status</span><select id="statusFilter"><option value="">All statuses</option></select></label>
      <label class="control"><span class="control-label">Agent</span><select id="agentFilter"><option value="">All agents</option></select></label>
      <label class="control"><span class="control-label">Task</span><select id="taskFilter"><option value="">All tasks</option></select></label>
      <button id="resetFilters" class="icon-btn" type="button">Reset</button>
      <span id="resultCount" class="result-count" aria-live="polite"></span>
    </div>
    <main class="workspace">
      <section class="stage" aria-label="Run visualization">
        <section id="dagView" class="view" role="tabpanel" aria-labelledby="dagTab">
          <div class="dag-tools"><button id="fitDag" class="fit-btn" type="button">Fit</button><button id="resetDag" class="fit-btn" type="button">100%</button></div>
          <div id="dagViewport" class="dag-viewport"><div id="dagCanvas" class="dag-canvas"><svg id="dagEdges" class="dag-edges" aria-hidden="true"></svg><div id="dagNodes" class="dag-nodes"></div></div></div>
        </section>
        <section id="waterfallView" class="view" role="tabpanel" aria-labelledby="waterfallTab" hidden>
          <div id="waterfall" class="waterfall"><div class="waterfall-head"><span>Operation hierarchy</span><span>Relative execution time</span><span>Duration</span></div><div id="waterfallBody"></div></div>
        </section>
      </section>
      <aside id="details" class="details" aria-label="Selected item details"><div class="detail-empty">Select a task or span to inspect its evidence.</div></aside>
    </main>
  </div>
  <script type="application/json" id="oma-data">${dataJson}</script>
  <script>
    (function () {
      'use strict';
      var payload = JSON.parse(document.getElementById('oma-data').textContent || '{}');
      var spansByKey = new Map((payload.spans || []).map(function (span) { return [span.key, span]; }));
      var tasksById = new Map((payload.tasks || []).map(function (task) { return [task.id, task]; }));
      var state = { view: payload.defaultView || 'dag', selectedKey: null, selectedTaskId: null, collapsed: new Set(), waterfallLimit: 500, scale: 1, tx: 0, ty: 0, lastFocus: null };
      var els = {};
      ['viewerTitle','summaryGrid','runId','copyRunId','copyStatus','warningStrip','routingSummary','dagTab','waterfallTab','dagView','waterfallView','searchInput','kindFilter','statusFilter','agentFilter','taskFilter','resetFilters','resultCount','dagViewport','dagCanvas','dagEdges','dagNodes','fitDag','resetDag','waterfallBody','details'].forEach(function (id) { els[id] = document.getElementById(id); });

      function text(tag, value, className) { var node = document.createElement(tag); if (className) node.className = className; node.textContent = value == null ? '' : String(value); return node; }
      function fmtDuration(ms) { if (typeof ms !== 'number') return 'Unknown'; if (ms < 1) return ms.toFixed(2) + ' ms'; if (ms < 1000) return Math.round(ms) + ' ms'; if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + ' s'; return (ms / 60000).toFixed(1) + ' min'; }
      function fmtNumber(value) { return Number(value || 0).toLocaleString('en-US'); }
      function fmtCosts(costs) { if (!costs || !costs.length) return 'Not recorded'; return costs.map(function (cost) { return cost.currency + ' ' + Number(cost.amount).toLocaleString('en-US',{ maximumFractionDigits: 6 }); }).join(' + '); }
      function fmtList(values) { return values && values.length ? values.join(', ') : 'Not recorded'; }
      function shortId(value) { if (value == null) return value; var s = String(value); return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ? s.slice(0, 8) : s; }
      function statusClass(status) { return 'status-' + String(status || 'unknown').replace(/[^a-z0-9_-]/gi, '_'); }
      function spanMatches(span) {
        var q = els.searchInput.value.trim().toLowerCase();
        var haystack = [span.name, span.kind, span.agent, span.taskId, span.taskTitle, span.model, span.provider, span.tool].filter(Boolean).join(' ').toLowerCase();
        return (!q || haystack.indexOf(q) !== -1)
          && (!els.kindFilter.value || span.kind === els.kindFilter.value)
          && (!els.statusFilter.value || span.status === els.statusFilter.value)
          && (!els.agentFilter.value || span.agent === els.agentFilter.value)
          && (!els.taskFilter.value || span.taskId === els.taskFilter.value);
      }
      function taskMatches(task) {
        var q = els.searchInput.value.trim().toLowerCase();
        var haystack = [task.id, task.title, task.assignee].filter(Boolean).join(' ').toLowerCase();
        return (!q || haystack.indexOf(q) !== -1)
          && (!els.statusFilter.value || task.status === els.statusFilter.value)
          && (!els.agentFilter.value || task.assignee === els.agentFilter.value)
          && (!els.taskFilter.value || task.id === els.taskFilter.value)
          && (!els.kindFilter.value || els.kindFilter.value === 'task');
      }
      function filteredSpanContext() {
        var matches = new Set(payload.spans.filter(spanMatches).map(function (span) { return span.key; }));
        var context = new Set(matches);
        matches.forEach(function (key) { var current = spansByKey.get(key); var guard = 0; while (current && current.parentKey && guard++ < payload.spans.length) { context.add(current.parentKey); current = spansByKey.get(current.parentKey); } });
        return { matches: matches, context: context };
      }
      function populateSelect(select, values) { (values || []).forEach(function (value) { var option = document.createElement('option'); option.value = value; option.textContent = value; select.appendChild(option); }); }
      function metric(label, value, cls) { var box = document.createElement('div'); box.className = 'metric'; var display = text('strong', value, 'metric-value ' + (cls || '')); display.title = String(value); box.appendChild(text('span', label, 'metric-label')); box.appendChild(display); return box; }
      function routingCard(label, value, meta) { var card = document.createElement('div'); card.className = 'routing-card'; card.appendChild(text('span',label,'metric-label')); card.appendChild(text('div',value,'routing-value')); if (meta) card.appendChild(text('div',meta,'routing-meta')); return card; }
      function renderRoutingSummary() {
        var routing = payload.routing; els.routingSummary.replaceChildren();
        if (!routing || !routing.decision) { els.routingSummary.classList.remove('visible'); return; }
        var decision = routing.decision; var receipt = routing.receipt;
        var decisionMeta = [decision.routerVersion ? 'router ' + decision.routerVersion : null, decision.confidence != null ? 'confidence ' + decision.confidence : null].filter(Boolean).join(' · ');
        var traceRoles = Array.from(new Set((payload.tasks || []).map(function (task) { return task.assignee; }).filter(Boolean)));
        var traceDependencyCount = (payload.tasks || []).reduce(function (count, task) { return count + (task.dependsOn || []).length; },0);
        var actual = receipt
          ? receipt.mode + (receipt.rolesExecuted && receipt.rolesExecuted.length ? ' · ' + receipt.rolesExecuted.join(' → ') : ' · no executed roles')
          : (traceRoles.length > 1 ? 'multi-agent' : 'single') + (traceRoles.length ? ' · ' + traceRoles.join(' → ') : ' · no executed roles');
        var actualMeta = receipt
          ? (receipt.dependencyEdges || []).length + ' dependency edge(s)' + (receipt.partial ? ' · partial evidence' : ' · complete evidence')
          : traceDependencyCount + ' task dependency edge(s) · trace-derived evidence; ExecutionReceipt unavailable';
        els.routingSummary.appendChild(routingCard('Decided',decision.mode + ' · ' + decision.source,decisionMeta));
        els.routingSummary.appendChild(routingCard('Why',(decision.reasons || []).join(' · ') || 'No reason recorded','decision ' + decision.decisionId));
        els.routingSummary.appendChild(routingCard('Actually ran',actual,actualMeta + (receipt && receipt.routingDecisionSpanId ? ' · span ' + receipt.routingDecisionSpanId : '')));
        els.routingSummary.classList.add('visible');
      }
      function renderSummary() {
        var summary = payload.summary || {};
        els.viewerTitle.textContent = payload.title || 'OMA Run Viewer';
        els.summaryGrid.replaceChildren(
          metric('Status', summary.status || 'unknown', statusClass(summary.status)),
          metric('Duration', fmtDuration(summary.durationMs)),
          metric('Input tokens', fmtNumber(summary.inputTokens)),
          metric('Output tokens', fmtNumber(summary.outputTokens)),
          metric('Cost', fmtCosts(summary.costs)),
          metric('Attempts', summary.attempts || 0),
          metric('Agents', (summary.agents || []).length),
          metric('Models', fmtList(summary.models)),
          metric('Providers', fmtList(summary.providers)),
          metric('Source', payload.sourceMode || 'unknown', 'source-chip')
        );
        els.runId.textContent = summary.runId || 'No run ID'; els.runId.title = summary.runId || '';
        els.copyRunId.disabled = !summary.runId;
        var warnings = (payload.warnings || []).map(function (warning) { return warning.message; });
        if (summary.incomplete) warnings.unshift('Run telemetry is incomplete.');
        if (payload.waterfall && payload.waterfall.issueCount) warnings.push(payload.waterfall.issueCount + ' hierarchy issue(s) were resolved for display.');
        els.warningStrip.replaceChildren();
        if (warnings.length) { els.warningStrip.classList.add('visible'); els.warningStrip.appendChild(text('strong', 'ATTN')); els.warningStrip.appendChild(text('span', warnings.join(' '))); }
      }
      function setView(view) {
        state.view = view;
        var dag = view === 'dag';
        els.dagView.hidden = !dag; els.waterfallView.hidden = dag;
        els.dagTab.setAttribute('aria-selected', String(dag)); els.waterfallTab.setAttribute('aria-selected', String(!dag));
        els.dagTab.tabIndex = dag ? 0 : -1; els.waterfallTab.tabIndex = dag ? -1 : 0;
        if (dag) { renderDag(); setTimeout(fitDag, 0); } else { renderWaterfall(); setTimeout(scrollSelectedWaterfall, 0); }
      }
      function clearNode(node) { while (node.firstChild) node.removeChild(node.firstChild); }
      function makeEdgePath(x1, y1, x2, y2) { return 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + 48) + ' ' + y1 + ', ' + (x2 - 48) + ' ' + y2 + ', ' + x2 + ' ' + y2; }
      function applyDagTransform() { els.dagCanvas.style.transform = 'translate(' + state.tx + 'px,' + state.ty + 'px) scale(' + state.scale + ')'; }
      function renderDag() {
        clearNode(els.dagNodes); clearNode(els.dagEdges);
        var tasks = (payload.tasks || []).filter(taskMatches);
        els.resultCount.textContent = state.view === 'dag' ? tasks.length + ' / ' + (payload.tasks || []).length + ' tasks' : els.resultCount.textContent;
        if (!tasks.length) { els.dagNodes.appendChild(text('div', 'No matching tasks. Reset filters or inspect the Waterfall.', 'empty')); return; }
        var positions = (payload.dag && payload.dag.positions) || {};
        var width = (payload.dag && payload.dag.width) || 1200; var height = (payload.dag && payload.dag.height) || 520;
        var nodeW = (payload.dag && payload.dag.nodeW) || ${DAG_NODE_WIDTH}; var nodeH = (payload.dag && payload.dag.nodeH) || ${DAG_NODE_HEIGHT};
        els.dagCanvas.style.width = width + 'px'; els.dagCanvas.style.height = height + 'px'; els.dagEdges.setAttribute('viewBox', '0 0 ' + width + ' ' + height); els.dagEdges.setAttribute('width', width); els.dagEdges.setAttribute('height', height);
        var ns = 'http://www.w3.org/2000/svg'; var defs = document.createElementNS(ns, 'defs'); var marker = document.createElementNS(ns, 'marker'); marker.setAttribute('id','dag-arrow'); marker.setAttribute('markerWidth','8'); marker.setAttribute('markerHeight','8'); marker.setAttribute('refX','7'); marker.setAttribute('refY','4'); marker.setAttribute('orient','auto'); var arrow = document.createElementNS(ns,'path'); arrow.setAttribute('d','M0 0 L8 4 L0 8 z'); arrow.setAttribute('fill','#3b495d'); marker.appendChild(arrow); defs.appendChild(marker); els.dagEdges.appendChild(defs);
        var visible = new Set(tasks.map(function (task) { return task.id; }));
        tasks.forEach(function (task) { var to = positions[task.id]; if (!to) return; (task.dependsOn || []).forEach(function (depId) { var from = positions[depId]; if (!from || !visible.has(depId)) return; var edge = document.createElementNS(ns,'path'); edge.setAttribute('d',makeEdgePath(from.x + nodeW, from.y + nodeH / 2, to.x, to.y + nodeH / 2)); edge.setAttribute('fill','none'); edge.setAttribute('stroke','#3b495d'); edge.setAttribute('stroke-width','1.5'); edge.setAttribute('marker-end','url(#dag-arrow)'); els.dagEdges.appendChild(edge); }); });
        tasks.forEach(function (task, index) { var pos = positions[task.id] || { x: 80, y: 64 + index * 160 }; var button = document.createElement('button'); button.type = 'button'; button.className = 'dag-node ' + statusClass(task.status) + (state.selectedTaskId === task.id ? ' selected' : ''); button.style.left = pos.x + 'px'; button.style.top = pos.y + 'px'; button.dataset.taskId = task.id; button.setAttribute('aria-label', task.title + ', ' + task.status); var top = document.createElement('div'); top.className = 'node-top'; var idEl = text('span', shortId(task.id), 'node-id'); idEl.title = task.id; top.appendChild(idEl); top.appendChild(text('span', task.status, 'status-pill ' + statusClass(task.status))); button.appendChild(top); button.appendChild(text('div', task.title, 'node-title')); var meta = document.createElement('div'); meta.className = 'node-meta'; meta.appendChild(text('span', task.assignee || 'Unassigned')); meta.appendChild(text('span', fmtDuration(task.durationMs))); button.appendChild(meta); button.addEventListener('click', function () { selectTask(task.id); }); els.dagNodes.appendChild(button); });
        applyDagTransform();
      }
      function expandAncestors(key) { var current = spansByKey.get(key); var guard = 0; while (current && current.parentKey && guard++ < payload.spans.length) { state.collapsed.delete(current.parentKey); current = spansByKey.get(current.parentKey); } }
      function isHiddenByCollapse(row) { var current = spansByKey.get(row.key); var guard = 0; while (current && current.parentKey && guard++ < payload.spans.length) { if (state.collapsed.has(current.parentKey)) return true; current = spansByKey.get(current.parentKey); } return false; }
      function renderWaterfall() {
        clearNode(els.waterfallBody);
        if (!(payload.spans || []).length) { els.waterfallBody.appendChild(text('div','No span trace was recorded. Result-only mode still provides the task DAG.','empty')); els.resultCount.textContent = '0 spans'; return; }
        var filtered = filteredSpanContext(); var rendered = 0; var totalMatches = filtered.matches.size; var maxRows = state.waterfallLimit;
        if (!totalMatches) { els.waterfallBody.appendChild(text('div','No spans match the current search and filters.','empty')); els.resultCount.textContent = '0 / ' + payload.spans.length + ' spans'; return; }
        (payload.waterfall.attempts || []).forEach(function (attempt) {
          var section = document.createElement('section'); section.className = 'attempt'; var header = document.createElement('div'); header.className = 'attempt-header'; header.appendChild(text('span','Attempt ' + attempt.attempt,'attempt-label')); header.appendChild(text('span',fmtDuration(attempt.durationMs),'attempt-range')); section.appendChild(header);
          attempt.rows.forEach(function (row) {
            if (!filtered.context.has(row.key) || isHiddenByCollapse(row) || rendered >= maxRows) return;
            var span = spansByKey.get(row.key); if (!span) return; rendered++;
            var line = document.createElement('div'); line.className = 'wf-row' + (state.selectedKey === span.key ? ' selected' : ''); line.dataset.spanKey = span.key; line.dataset.match = filtered.matches.has(span.key) ? 'true' : 'context';
            var label = document.createElement('div'); label.className = 'wf-label'; label.style.paddingLeft = (7 + row.depth * 18) + 'px'; if (row.hasChildren) { var disclosure = text('button',state.collapsed.has(span.key) ? '›' : '⌄','disclosure'); disclosure.type = 'button'; disclosure.setAttribute('aria-label',(state.collapsed.has(span.key) ? 'Expand ' : 'Collapse ') + span.name); disclosure.setAttribute('aria-expanded',String(!state.collapsed.has(span.key))); disclosure.addEventListener('click',function () { state.lastFocus = disclosure; state.collapsed.has(span.key) ? state.collapsed.delete(span.key) : state.collapsed.add(span.key); renderWaterfall(); }); label.appendChild(disclosure); } else { var spacer = text('span','·','disclosure disclosure-spacer'); spacer.setAttribute('aria-hidden','true'); label.appendChild(spacer); } var select = document.createElement('button'); select.type = 'button'; select.className = 'wf-select'; select.setAttribute('aria-label',span.name + ', ' + span.kind + ', ' + span.status); var dot = text('span','', 'kind-dot ' + span.kind); dot.setAttribute('aria-hidden','true'); select.appendChild(dot); var nameWrap = document.createElement('span'); nameWrap.style.minWidth = '0'; nameWrap.appendChild(text('span',span.name,'wf-name')); nameWrap.appendChild(text('span',' ' + span.kind + (row.hierarchyIssue ? ' / ' + row.hierarchyIssue : ''),'wf-kind')); select.appendChild(nameWrap); select.addEventListener('click',function () { selectSpan(span.key); }); label.appendChild(select);
            var track = document.createElement('div'); track.className = 'wf-track'; if (row.timingKnown && row.offsetPercent != null && row.widthPercent != null) { var bar = document.createElement('span'); bar.className = 'wf-bar kind-' + span.kind + (span.incomplete ? ' incomplete' : '') + ((span.status === 'error' || span.status === 'failed' || span.status === 'timeout' || span.status === 'budget_exhausted') ? ' failed' : ''); bar.style.left = row.offsetPercent + '%'; bar.style.width = row.widthPercent + '%'; bar.title = fmtDuration(span.durationMs); track.appendChild(bar); } else track.appendChild(text('span','Unknown timing','wf-unknown'));
            line.appendChild(label); line.appendChild(track); line.appendChild(text('span',fmtDuration(span.durationMs),'wf-duration')); section.appendChild(line);
          });
          els.waterfallBody.appendChild(section);
        });
        els.resultCount.textContent = totalMatches + ' / ' + payload.spans.length + ' spans';
        if (rendered >= maxRows && rendered < filtered.context.size) { var wrap = document.createElement('div'); wrap.className = 'load-more-wrap'; var more = text('button','Load ' + Math.min(500, filtered.context.size - rendered) + ' more','load-more'); more.type = 'button'; more.addEventListener('click', function () { state.waterfallLimit += 500; renderWaterfall(); }); wrap.appendChild(more); els.waterfallBody.appendChild(wrap); }
      }
      function detailPair(label, value) { var box = document.createElement('div'); box.appendChild(text('span',label,'detail-label')); box.appendChild(text('span',value == null ? 'Not recorded' : value,'detail-value')); return box; }
      function renderDetails(item, type) {
        if (!item) { els.details.replaceChildren(text('div','Select a task or span to inspect its evidence.','detail-empty')); return; }
        var root = document.createElement('div'); root.className = 'detail-content'; var head = document.createElement('div'); head.className = 'detail-head'; var names = document.createElement('div'); names.appendChild(text('span',type + ' evidence','eyebrow')); names.appendChild(text('h2',item.title || item.name || item.id,'detail-title')); head.appendChild(names); head.appendChild(text('span',item.status || 'unknown','status-pill ' + statusClass(item.status))); root.appendChild(head);
        var overview = document.createElement('section'); overview.className = 'detail-section detail-grid'; overview.appendChild(detailPair('Kind', item.kind || type)); overview.appendChild(detailPair('Duration',fmtDuration(item.durationMs))); overview.appendChild(detailPair('Task',shortId(item.taskId || item.id))); overview.appendChild(detailPair('Agent',item.agent || item.assignee)); overview.appendChild(detailPair('Model',item.model)); overview.appendChild(detailPair('Provider',item.provider)); overview.appendChild(type === 'Task' ? detailPair('Tool calls',item.toolCallCount) : detailPair('Tool',item.tool)); overview.appendChild(detailPair('Retries',item.retries)); root.appendChild(overview);
        var usage = document.createElement('section'); usage.className = 'detail-section detail-grid'; usage.appendChild(detailPair('Input tokens',fmtNumber(item.tokens ? item.tokens.input_tokens : item.inputTokens))); usage.appendChild(detailPair('Output tokens',fmtNumber(item.tokens ? item.tokens.output_tokens : item.outputTokens))); usage.appendChild(detailPair('Cost',fmtCosts(item.costs))); usage.appendChild(detailPair('Start',item.startUnixMs != null ? new Date(item.startUnixMs).toISOString() : null)); usage.appendChild(detailPair('End',item.endUnixMs != null ? new Date(item.endUnixMs).toISOString() : null)); root.appendChild(usage);
        if (item.error) { var errorSection = document.createElement('section'); errorSection.className = 'detail-section'; errorSection.appendChild(text('span','Error','detail-label')); var errors = document.createElement('ul'); errors.className = 'detail-list'; var errorText = [item.error.name,item.error.code,item.error.message].filter(Boolean).join(' / ') || 'Structured error recorded'; errors.appendChild(text('li',errorText,'error-box')); errorSection.appendChild(errors); root.appendChild(errorSection); }
        if (item.events && item.events.length) { var eventSection = document.createElement('section'); eventSection.className = 'detail-section'; eventSection.appendChild(text('span','Events','detail-label')); var eventList = document.createElement('ul'); eventList.className = 'detail-list'; item.events.forEach(function (evt) { eventList.appendChild(text('li',new Date(evt.timestampUnixMs).toISOString() + ' · ' + evt.name + (evt.facts.length ? ' · ' + evt.facts.map(function (fact) { return fact.label + ': ' + fact.value; }).join(', ') : ''))); }); eventSection.appendChild(eventList); root.appendChild(eventSection); }
        if (item.links && item.links.length) { var linkSection = document.createElement('section'); linkSection.className = 'detail-section'; linkSection.appendChild(text('span','Causal links','detail-label')); var links = document.createElement('ul'); links.className = 'detail-list'; item.links.forEach(function (link) { links.appendChild(text('li',link.relation + ' → ' + link.spanId)); }); linkSection.appendChild(links); root.appendChild(linkSection); }
        if (item.facts && item.facts.length) { var factSection = document.createElement('section'); factSection.className = 'detail-section'; factSection.appendChild(text('span','Safe attributes','detail-label')); var facts = document.createElement('ul'); facts.className = 'detail-list'; item.facts.forEach(function (fact) { facts.appendChild(text('li',fact.label + ': ' + fact.value)); }); factSection.appendChild(facts); root.appendChild(factSection); }
        els.details.replaceChildren(root);
      }
      function selectTask(taskId) { var task = tasksById.get(taskId); if (!task) return; state.lastFocus = document.activeElement; state.selectedTaskId = taskId; state.selectedKey = task.spanKey || null; if (state.selectedKey) expandAncestors(state.selectedKey); renderDetails(task,'Task'); if (state.view === 'dag') renderDag(); else { renderWaterfall(); scrollSelectedWaterfall(); } }
      function selectSpan(key) { var span = spansByKey.get(key); if (!span) return; state.lastFocus = document.activeElement; state.selectedKey = key; state.selectedTaskId = span.taskId || null; expandAncestors(key); renderDetails(span,'Span'); if (state.view === 'waterfall') renderWaterfall(); else renderDag(); }
      function scrollSelectedWaterfall() { if (!state.selectedKey) return; var row = els.waterfallBody.querySelector('[data-span-key="' + CSS.escape(state.selectedKey) + '"]'); if (row) row.scrollIntoView({ block: 'center' }); }
      function fitDag() { var width = (payload.dag && payload.dag.width) || 1200; var height = (payload.dag && payload.dag.height) || 520; var rect = els.dagViewport.getBoundingClientRect(); state.scale = Math.max(.2, Math.min(1.25, Math.min((rect.width - 60) / width, (rect.height - 60) / height))); state.tx = (rect.width - width * state.scale) / 2; state.ty = (rect.height - height * state.scale) / 2; applyDagTransform(); }
      function updateFilters() { state.waterfallLimit = 500; if (state.view === 'dag') renderDag(); else renderWaterfall(); }
      function resetFilters() { els.searchInput.value = ''; els.kindFilter.value = ''; els.statusFilter.value = ''; els.agentFilter.value = ''; els.taskFilter.value = ''; updateFilters(); }
      function navigateTabs(event) { var next = null; if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') next = state.view === 'dag' ? 'waterfall' : 'dag'; else if (event.key === 'Home') next = 'dag'; else if (event.key === 'End') next = 'waterfall'; if (!next) return; event.preventDefault(); setView(next); (next === 'dag' ? els.dagTab : els.waterfallTab).focus(); }

      populateSelect(els.kindFilter,payload.filters.kinds); populateSelect(els.statusFilter,payload.filters.statuses); populateSelect(els.agentFilter,payload.filters.agents); populateSelect(els.taskFilter,payload.filters.tasks);
      [els.searchInput,els.kindFilter,els.statusFilter,els.agentFilter,els.taskFilter].forEach(function (control) { control.addEventListener(control.tagName === 'INPUT' ? 'input' : 'change',updateFilters); });
      els.resetFilters.addEventListener('click',resetFilters); els.dagTab.addEventListener('click',function () { setView('dag'); }); els.waterfallTab.addEventListener('click',function () { setView('waterfall'); }); els.fitDag.addEventListener('click',fitDag); els.resetDag.addEventListener('click',function () { state.scale = 1; state.tx = 0; state.ty = 0; applyDagTransform(); });
      els.dagTab.addEventListener('keydown',navigateTabs); els.waterfallTab.addEventListener('keydown',navigateTabs);
      els.copyRunId.addEventListener('click',async function () { try { await navigator.clipboard.writeText(payload.summary.runId); els.copyStatus.textContent = 'Run ID copied'; els.copyRunId.textContent = 'Copied'; setTimeout(function () { els.copyRunId.textContent = 'Copy'; },1000); } catch (_) { els.copyStatus.textContent = 'Copy failed; select the run ID manually'; els.copyRunId.textContent = 'Failed'; } });
      els.dagViewport.addEventListener('wheel',function (event) { event.preventDefault(); var next = Math.max(.2,Math.min(2.5,state.scale - event.deltaY * .0012)); var rect = els.dagViewport.getBoundingClientRect(); var x = event.clientX - rect.left; var y = event.clientY - rect.top; state.tx = x - (x - state.tx) * next / state.scale; state.ty = y - (y - state.ty) * next / state.scale; state.scale = next; applyDagTransform(); },{ passive:false });
      var dragging = false, lastX = 0, lastY = 0; els.dagViewport.addEventListener('pointerdown',function (event) { if (event.target.closest('.dag-node')) return; dragging = true; lastX = event.clientX; lastY = event.clientY; els.dagViewport.classList.add('dragging'); els.dagViewport.setPointerCapture(event.pointerId); }); els.dagViewport.addEventListener('pointermove',function (event) { if (!dragging) return; state.tx += event.clientX - lastX; state.ty += event.clientY - lastY; lastX = event.clientX; lastY = event.clientY; applyDagTransform(); }); els.dagViewport.addEventListener('pointerup',function () { dragging = false; els.dagViewport.classList.remove('dragging'); });
      document.addEventListener('keydown',function (event) { if (event.key === 'Escape') { var returnFocus = state.lastFocus; state.selectedKey = null; state.selectedTaskId = null; renderDetails(null); if (state.view === 'dag') renderDag(); else renderWaterfall(); if (returnFocus && returnFocus.isConnected && typeof returnFocus.focus === 'function') returnFocus.focus(); } });
      renderSummary();
      renderRoutingSummary();
      var initialSpan = (payload.spans || []).find(function (span) { return ['error','failed','timeout','budget_exhausted','rejected'].indexOf(span.status) !== -1; }) || (payload.spans || []).find(function (span) { return span.kind === 'run'; });
      if (initialSpan) selectSpan(initialSpan.key); else if ((payload.tasks || [])[0]) selectTask(payload.tasks[0].id);
      setView(state.view);
    })();
  </script>
</body>
</html>`
}
