# Harbor eval flywheel

A data flywheel for the emotion scorer: **human labels → Harbor eval tasks →
LLM-as-a-judge grading → metrics → improve the scorer → re-run.**

## How it works

1. **Label.** In the app, open `/labeling`, pick analyzed windows, and record a
   gold label (dominant emotion, acceptable alternatives, sarcasm/subtext,
   ambiguity, notes).
2. **Export.** Click **Export Harbor task** on a labeled window, or **Export all
   labeled → Harbor**. Each labeled window becomes a
   [Harbor](https://www.harborframework.com) task under
   `evals/harbor/tasks/window-<id>/`.
3. **Run.** Point an agent (the emotion scorer under test) at a task. The agent
   reads the window's messages and writes `/app/result.json` (Ekman-7 scores +
   dominant). The verifier grades that output against the gold label.
4. **Improve.** Read the rewards, find where the scorer disagrees with humans,
   tighten the scorer prompt/model, and re-run the same tasks to confirm.

Each new labeling session grows the eval set, so the suite gets stronger over
time — the flywheel.

## Task layout

```
window-<id>/
├── instruction.md        # the conversation window + the scoring instruction
├── task.toml             # verifier timeout + judge env (OPENAI_API_KEY, JUDGE_MODEL)
├── environment/Dockerfile
├── solution/solve.sh     # oracle: writes the gold label as result.json (should score ~1.0)
└── tests/
    ├── test.sh           # runs the judge
    ├── gold.json         # the human label + focal text (verifier-only; hidden from the agent)
    └── llm_judge.py      # deterministic metrics + LLM-as-a-judge → /logs/verifier/reward.json
```

## Grading

`tests/llm_judge.py` writes named metrics to `/logs/verifier/reward.json`:

- `dominant_exact` — model's dominant equals the gold dominant.
- `dominant_acceptable` — model's dominant is in the gold dominant ∪ acceptable set.
- `score_agreement` — `1 − mean|pred − gold|` over anchors the human scored (omitted if none).
- `judge_*` — an LLM judge's `dominant_correctness`, `calibration`,
  `rationale_quality`, and `overall` (only when `OPENAI_API_KEY` is set).
- `reward` — primary metric: the judge `overall` if available, else `dominant_acceptable`.

## Running

Export `OPENAI_API_KEY` (and optionally `OPENAI_BASE_URL` / `JUDGE_MODEL`), then:

```bash
# sanity-check a task with the oracle (should score ~1.0)
harbor run -p evals/harbor/tasks/window-123 -a oracle

# evaluate a real agent
harbor run -p evals/harbor/tasks/window-123 -a claude-code -m anthropic/claude-sonnet-4-5
```

Generated tasks are gitignored (`evals/harbor/tasks/`) because they contain real
message text — keep them local.
