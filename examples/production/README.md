# Production Examples

End-to-end examples that demonstrate `open-multi-agent` running on real-world use cases — not toy demos.

The other example categories (`basics/`, `providers/`, `patterns/`, `integrations/`) optimize for clarity and small surface area. This directory optimizes for **showing the framework solving an actual problem**, with the operational concerns that come with it.

## Acceptance criteria

A submission belongs in `production/` if it meets all of:

1. **Real use case.** Solves a concrete problem someone would actually pay for or use daily — not "build me a TODO API".
2. **Error handling.** Handles LLM failures, tool failures, and partial team failures gracefully. No bare `await` chains that crash on the first error.
3. **Documentation.** Each example lives in its own subdirectory with a `README.md` covering:
   - What problem it solves
   - Architecture diagram or task DAG description
   - Required env vars / external services
   - How to run locally
   - Expected runtime and approximate token cost
4. **Reproducible.** Pinned model versions; no reliance on private datasets or unpublished APIs.
5. **Tested.** At least one test or smoke check that verifies the example still runs after framework updates.

If a submission falls short on (2)–(5), it probably belongs in `patterns/` or `integrations/` instead.

## Layout

```
production/
└── <use-case>/
    ├── README.md          # required
    ├── index.ts           # entry point
    ├── agents/            # AgentConfig definitions
    ├── tools/             # custom tools, if any
    └── tests/             # smoke test or e2e test
```

## Submitting

Open a PR. In the PR description, address each of the five acceptance criteria above.
