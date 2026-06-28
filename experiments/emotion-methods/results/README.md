# Results Artifacts

Committed artifacts in this directory are aggregate-only outputs from private-message experiments. They do not include raw private message text, source conversation IDs, or message excerpts.

## Included

- [top5-summary.json](./top5-summary.json): aggregate top-five-longest benchmark summary.
- [graphs/top5/summary.json](./graphs/top5/summary.json): graph-generation summary.
- [graphs/top5](./graphs/top5): aggregate PNG charts for deterministic and LLM score distributions, latency, confidence, and one anonymized conversation trajectory.

## Not Included

The local files below are useful for manual inspection but intentionally remain ignored under `out/` because they include raw private message windows:

- `out/top5-window-review-16x8.jsonl`
- `out/top5-window-review-8x4-qwen.jsonl`
- `out/harness-ax-top5-results.json`
