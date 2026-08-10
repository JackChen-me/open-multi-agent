# Paper Replication Triage Fixtures

These fixtures are mocked API snapshots for a cookbook example. They are not
claims about a real paper.

Each file is shaped after a different production evidence source:

- `scholarly-metadata.json`: Asta / Semantic Scholar style paper metadata.
- `code-artifacts.json`: GitHub Search style code discovery.
- `dataset-artifacts.json`: dataset catalog style access, split, and metric-policy evidence.
- `citation-feedback.json`: Asta citation/snippet-search reproduction evidence.
- `source-index.json`: discovery status for found, missing, and ambiguous artifacts.

The demo deliberately includes conflicting evidence:

- The paper claims official code is available, but discovery finds only an
  unofficial repository and a missing official URL.
- The paper claims all data splits are public, but the benchmark holdout split
  requires application approval.
- The paper reports macro-F1, while reproduction feedback says micro-F1 is the
  metric that gets close to the paper's score.
- The paper implies single-GPU reproduction, but the discovered training command
  defaults to a multi-GPU launch.

The live path intentionally keeps API requirements small:

- `ASTA_API_KEY` for scholarly metadata, citation traversal, and snippet search.
- `GITHUB_TOKEN` is optional but recommended for code repository discovery.

Live mode also prints a deterministic source-discovery snapshot before the
agents run. The final planner report includes an `artifact_inventory` with
paper metadata, candidate code repositories, discovered dataset clues, and
follow-up reproduction signals so the output is useful beyond a yes/no
replication decision.

Production systems can add Papers With Code, arXiv, publisher pages, and
dataset catalogs later. The example keeps mocked snapshots as the default path
so the orchestration can be run offline and reviewed deterministically.
