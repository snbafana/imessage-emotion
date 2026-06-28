# Emotion Method Experiments

Isolated research harness for the `imessage-emotion` take-home. This folder does not implement app UI or iMessage ingest. It reads private iMessage data at runtime through the local Cued CLI when a private config is used.

## Current Decision

Use RoBERTa/Ekman-style emotion dimensions everywhere in the TypeScript harness and graphs:

- `anger`
- `disgust`
- `fear`
- `joy`
- `neutral`
- `sadness`
- `surprise`

VADER and other polarity baselines remain only in older survey scripts for comparison. They are not the recommended TypeScript harness path.

## Primary Harness

The primary reproducible experiment is [harness_ax.ts](./harness_ax.ts). It:

- loads synthetic or private iMessage conversations,
- scores every rolling window locally with a Transformers.js RoBERTa emotion classifier,
- computes rolling baseline deltas and top-shift windows,
- optionally calls Ax structured LLM scorers through OpenAI or OpenRouter,
- writes generated output under ignored `out/`.

The local RoBERTa model is `nicky48/emotion-english-distilroberta-base-ONNX`, used because it exposes ONNX files compatible with Transformers.js.

## Setup

```bash
cd experiments/emotion-methods
npm install
uv sync
npm run typecheck
```

Provider-backed runs read API keys from the repository `.env` or local shell environment:

- `OPENAI_API_KEY`
- `OPENROUTER_API_KEY`

Do not commit `.env` or generated `out/` files.

## Useful Commands

Fast provider smoke over recent private conversations:

```bash
npm run harness:ax
```

Slow/fast context sweep:

```bash
npm run harness:ax:sweep
```

Larger private benchmark:

```bash
npm run harness:ax:large
npm run graphs:ax
```

Top-five-longest private conversation review run:

```bash
npm run harness:ax:top5
npm run graphs:top5
```

Single-conversation line or heatmap graph:

```bash
npm run graph:conversation
npm run graph:conversation:heatmap
```

## Configs

- [harness.ax.json](./harness.ax.json): small private provider smoke.
- [harness.ax.sweep.json](./harness.ax.sweep.json): window/context/mode sweep.
- [harness.ax.large.json](./harness.ax.large.json): larger private benchmark and graph source.
- [harness.ax.conversation.json](./harness.ax.conversation.json): all-window LLM scoring for one conversation.
- [harness.ax.top5.json](./harness.ax.top5.json): top-five-longest DM review run. This intentionally writes local raw window text to ignored `out/` review artifacts for manual inspection.

Dataset config knobs:

- `privateConversationLimit`: number of private DM conversations.
- `privateConversationOrder`: `recent` or `longest`.
- `maxMessagesPerConversation`: chronological message cap per conversation.
- `includeWindowTextInOutput`: local review mode; keep output ignored and uncommitted.

LLM config knobs:

- `provider`: `openai` or `openrouter`.
- `model`: provider model id.
- `runMode`: `selected_windows`, `all_windows`, or `whole_conversation`.
- `contextMode`: `window_only`, `prior_summary`, `prior_messages`, or `full_conversation`.
- `concurrency`, `maxWindows`, `maxTokens`.

## Artifacts

Committed artifacts under [results](./results) are aggregate-only and safe for PR review. They do not contain raw private message text.

Ignored local artifacts under `out/` can include private text when `includeWindowTextInOutput` is enabled. The useful local inspection files from the top-five run are:

- `out/top5-window-review-16x8.jsonl`: 16-message chunks with RoBERTa, Qwen, Mistral, and OpenAI side by side.
- `out/top5-window-review-8x4-qwen.jsonl`: 8-message chunks with RoBERTa and Qwen.

## Latest Top-Five Benchmark

Ran on the five longest iMessage DM conversations by message count, capped at 2,000 chronological messages per conversation.

Local deterministic RoBERTa:

| Window | Windows | Avg ms/window | Dominant spread |
|---|---:|---:|---|
| `8/4` | 2,500 | 27.1 | 1,094 surprise, 762 neutral, 360 joy, 125 sadness, 112 anger, 40 fear, 7 disgust |
| `16/8` | 1,250 | 54.4 | 558 surprise, 373 neutral, 172 joy, 63 anger, 55 sadness, 26 fear, 3 disgust |
| `32/16` | 625 | 62.0 | 269 surprise, 202 neutral, 78 joy, 28 anger, 25 sadness, 22 fear, 1 disgust |

Selected-window LLM runs:

| Run | Windows | Valid | Wall | Avg latency | Avg confidence |
|---|---:|---:|---:|---:|---:|
| Qwen `16/8` prior summary | 50 | 50 | 11.6s | 1.8s | 0.9 |
| Mistral `16/8` prior summary | 50 | 50 | 12.7s | 1.9s | 0.8 |
| OpenAI `gpt-4.1-nano` `16/8` prior summary | 50 | 50 | 13.6s | 2.0s | 0.7 |
| Qwen `8/4` prior messages | 50 | 50 | 9.8s | 1.5s | 0.9 |

Read: RoBERTa is useful as a deterministic sweep/scout model, but it over-calls `surprise` on private-message windows. The LLM scorers are more calibrated for conversation state. Qwen gave the most varied selected-window labels; OpenAI was more neutral-heavy; `8/4 prior_messages` gave the best granular tension/anger variation.

## Older Survey Scripts

The Python and legacy Node scripts remain because they document the broader method survey:

- [run_python_methods.py](./run_python_methods.py): VADER, TextBlob, AFINN, NRC, GoEmotions-style HF models, j-hartmann/Ekman, Cardiff Twitter models, DAIR-style emotion, pysentimiento, change detection, and keyphrase experiments.
- [run_llm_methods.py](./run_llm_methods.py): OpenAI structured outputs, DSPy/RLM-style experiments, agent trajectory and pivotal-span experiments.
- [harness.py](./harness.py): earlier config-driven Python harness.
- [run.mjs](./run.mjs): original VADER/lexicon smoke; retained as legacy context only.

These scripts are not the recommended V1 implementation path.

## Privacy

Private messages are authorized for local experiments, but raw private text should stay in ignored local outputs. Provider runs send only the configured bounded windows or context summaries to OpenAI/OpenRouter. Committed results should be aggregate summaries, score distributions, graphs, configs, and scripts only.
