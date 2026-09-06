# create-oma-app

Scaffold a production-oriented multi-agent starter on [`@open-multi-agent/core`](https://www.npmjs.com/package/@open-multi-agent/core).

Requires Node.js 20 or newer; Node.js 22 or 24 is recommended. Generated
projects declare the same runtime floor. Node.js 20 is upstream-EOL and retained
only as a migration compatibility window; OMA will remove it in the next major
release, no earlier than 2026-10-31.

```bash
npm create oma-app@latest my-oma
```

Interactive use asks for a starter and runtime, installs dependencies, then runs a deterministic local demo. The demo needs no API key and makes no model request: scripted model responses exercise the real OMA scheduler, aggregation, reports, and dashboard. Non-interactive calls retain the original scaffold-only `demo + cloud` behavior.

## Starters

- **PR Review Agent** — reviews a local Git diff or a GitHub PR using parallel correctness, security, and quality reviewers.
- **Security Analysis Agent** — read-only repository analysis with secret redaction and opt-in `npm audit`.
- **Multi-agent DAG Demo** — the original pure-reasoning onboarding-plan example.

All starters support cloud/OpenAI-compatible endpoints and local Ollama. Production agents receive no shell or write tools; their host process collects bounded evidence and writes Markdown, JSON, and HTML reports under `reports/`.

## No-key demo

```bash
npm create oma-app@latest my-reviewer -- --template pr-review --provider cloud
```

The interactive command installs and runs `npm run demo` automatically. Re-run it later with `cd my-reviewer && npm run demo`. The generated Markdown, JSON, and HTML clearly identify the scripted model responses as simulated; no provider credential is read.

Use `--no-install` to scaffold files only, or `--no-run` to install dependencies without running the demo. Installing still downloads packages from the npm registry; the demo run itself makes no model-network request.

## Real model run

For a Cloud/OpenAI-compatible scaffold:

```bash
cd my-reviewer
cp .env.example .env   # add your key and model configuration
npm run dev -- --repo ../your-repo --base origin/main
```

For an Ollama scaffold, start Ollama and an installed model before `npm run dev`; no cloud API key is needed.

Other combinations:

```bash
npm create oma-app@latest my-auditor -- --template security --provider ollama
npm create oma-app@latest my-demo -- --template demo --provider cloud
```

Ollama projects select `OMA_MODEL` when set, otherwise the first installed model. The scaffolder never downloads a model or makes a real model call automatically.

## License

MIT

Maintained by [YuanASI (Shenzhen YuanASI Technology Co., Ltd.)](https://yuanasi.com/en?utm_source=npm&utm_medium=package_readme&utm_campaign=open_multi_agent).
