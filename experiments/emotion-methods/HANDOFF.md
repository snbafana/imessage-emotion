# Emotion Method Experiments Handoff

## Scope

This experiment folder evaluates emotion-scoring methods for `imessage-emotion`. It is intentionally isolated from app UI and ingest. Private iMessage data was used through the local Cued CLI; raw private text remains in ignored `out/` artifacts only.

## Files

Primary reproducible path:

- [harness_ax.ts](./harness_ax.ts): TypeScript Ax/Transformers.js harness.
- [harness.ax.top5.json](./harness.ax.top5.json): top-five-longest private DM benchmark config.
- [plot_ax_results.py](./plot_ax_results.py): aggregate benchmark charts.
- [plot_conversation_heatmap.py](./plot_conversation_heatmap.py): per-conversation line/heatmap chart.
- [results](./results): committed aggregate summaries and graphs, no raw messages.

Older survey path:

- [run_python_methods.py](./run_python_methods.py): classic NLP, HF classifiers, change detection.
- [run_llm_methods.py](./run_llm_methods.py): OpenAI structured outputs, DSPy/RLM, trajectory and pivotal-span experiments.
- [run.mjs](./run.mjs): original VADER/lexicon smoke, retained as legacy context only.

## Commands Run

```bash
cued status
cued doctor
cued integrations status
npm install
uv sync
npm run typecheck
npm run harness:ax:top5
npm run graphs:top5
uv run python plot_conversation_heatmap.py --input out/harness-ax-top5-results.json --conversation private_c01 --source deterministic --method roberta_emotion --window-size 16 --stride 8 --chart line --out out/graphs/top5/private_c01_roberta_16x8_line.png
uv run python plot_conversation_heatmap.py --input out/harness-ax-top5-results.json --conversation private_c01 --source deterministic --method roberta_emotion --window-size 16 --stride 8 --chart heatmap --out out/graphs/top5/private_c01_roberta_16x8_heatmap.png
```

Cued was healthy enough for this task: iMessage authorized, readable, and projected. Contacts/Signal/WhatsApp warnings were unrelated.

## Methods Tried Or Evaluated

Fast deterministic:

- VADER, TextBlob, AFINN, Node `sentiment`.
- NRC emotion lexicon and VAD-style proxies.
- Emoji, keyword, tapback-style relationship features.

Classifier models:

- GoEmotions-style models.
- j-hartmann/Ekman emotion classifier.
- Cardiff Twitter sentiment/emotion models.
- DAIR-style six-label emotion models.
- EmpatheticDialogues/conv-emotion style models.
- Transformers.js RoBERTa-compatible ONNX model for the TS harness.

LLM methods:

- Ax structured window scorer.
- Comparative scoring with prior baseline plus current window.
- Context variations: window only, prior summary, prior messages, whole conversation.
- OpenAI and OpenRouter providers.
- DSPy/RLM-style experiments in the Python survey script.

Shift/explanation tools:

- Rolling baseline deltas and z-score-like shift magnitude.
- `ruptures` offline change points.
- River ADWIN drift detection.
- TF-IDF/keyphrase and RECCON-style cause-extraction patterns.

## Current Standard Labels

Use RoBERTa/Ekman dimensions:

- `anger`
- `disgust`
- `fear`
- `joy`
- `neutral`
- `sadness`
- `surprise`

Earlier six relationship anchors were useful for product framing but created too much mapping ambiguity. VADER-style polarity scoring is not useful as the TS harness baseline.

## Top-Five Private Benchmark

Data: five longest iMessage DM conversations by message count, capped at 2,000 chronological messages per conversation.

Conversation sizes:

- `private_c01`: 8,455 total, 2,000 loaded.
- `private_c02`: 4,233 total, 2,000 loaded.
- `private_c03`: 3,019 total, 2,000 loaded.
- `private_c04`: 2,238 total, 2,000 loaded.
- `private_c05`: 2,010 total, 2,000 loaded.

Local RoBERTa deterministic sweep:

| Window | Windows | Avg ms/window | Dominant counts |
|---|---:|---:|---|
| `8/4` | 2,500 | 27.1 | surprise 1,094; neutral 762; joy 360; sadness 125; anger 112; fear 40; disgust 7 |
| `16/8` | 1,250 | 54.4 | surprise 558; neutral 373; joy 172; anger 63; sadness 55; fear 26; disgust 3 |
| `32/16` | 625 | 62.0 | surprise 269; neutral 202; joy 78; anger 28; sadness 25; fear 22; disgust 1 |

Selected-window LLM runs:

| Run | Windows | Valid | Wall | Avg latency | Avg confidence | Dominant counts |
|---|---:|---:|---:|---:|---:|---|
| Qwen `16/8` prior summary | 50 | 50 | 11.6s | 1.8s | 0.9 | joy 21; surprise 12; neutral 11; anger 3; sadness 2; fear 1 |
| Mistral `16/8` prior summary | 50 | 50 | 12.7s | 1.9s | 0.8 | neutral 19; joy 17; surprise 8; anger 3; sadness 2; disgust 1 |
| OpenAI `gpt-4.1-nano` `16/8` prior summary | 50 | 50 | 13.6s | 2.0s | 0.7 | neutral 33; joy 9; surprise 6; fear 2 |
| Qwen `8/4` prior messages | 50 | 50 | 9.8s | 1.5s | 0.9 | joy 18; anger 10; neutral 9; surprise 6; fear 4; disgust 2; sadness 1 |

## Result Read

RoBERTa is the right deterministic scout for the TS harness. It is cheap enough for full-conversation local sweeps and gives a stable seven-label score vector. Its main calibration issue on these texts is an over-call of `surprise`.

LLMs are better calibrated for conversation state than local classifiers. Qwen produced the most useful selected-window variety; OpenAI `gpt-4.1-nano` was more conservative and neutral-heavy; Mistral was between them. The `8/4 prior_messages` Qwen run found more granular anger/fear/surprise shifts than `16/8 prior_summary`.

Whole-conversation scoring should be used only for a coarse baseline. It tends to flatten the temporal story and is less useful for pivotal-message detection.

## Recommended V1 Method

1. Run local RoBERTa over all windows.
2. Use rolling conversation-specific baseline deltas to find candidate shift windows.
3. Score selected windows with an LLM structured scorer.
4. For slow/deep analysis, zoom from `16/8` candidates down to `8/4` or smaller windows with prior message context.
5. Use the LLM explanation/chat path only around retrieved shift windows and evidence refs.

Recommended defaults:

- Anchors: `anger`, `disgust`, `fear`, `joy`, `neutral`, `sadness`, `surprise`.
- Fast local windows: `16` messages, stride `8`, plus optional `8/4` for spiky spans.
- Candidate selection: first window, last window, and top rolling-delta windows per conversation.
- LLM context: `prior_summary` for broad selected-window runs; `prior_messages` when zooming into pivotal spans.
- Cache key: `{conversationId, messageIdRange, windowSize, stride, scorerName, scorerVersion, model, promptVersion, contextMode}`.
- Recalculation: recompute local RoBERTa windows synchronously; enqueue provider scoring only for stale/new selected windows.

## Deferred

- Keep GoEmotions/j-hartmann as offline comparators, not V1 runtime dependencies.
- Keep `ruptures` for offline diagnostics only.
- Do not use ADWIN for V1.
- Do not use VADER/TextBlob/AFINN as product-visible scorers.
- Defer provider abstraction beyond OpenAI/OpenRouter until swapping providers becomes an actual product requirement.

## Exact Next Implementation Step

Implement the app scoring service from the TypeScript harness shape:

1. Window conversation messages into `16/8`.
2. Run local RoBERTa score vectors.
3. Store per-window scores and rolling deltas.
4. Pick top shift windows.
5. Call the structured LLM scorer for those windows only.
6. Render line/heatmap trajectories from the stored score vectors.
