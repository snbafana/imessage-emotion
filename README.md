# Undercurrent — iMessage Emotion Timeline

A **local-first** macOS app that visualizes how the emotional tone of your
iMessage conversations shifts over time — and lets you ask *why* a shift
happened.

Everything runs on your Mac: a Next.js server reads your local Messages
database, scores conversation windows with an LLM, and serves a dashboard.
Message content never leaves the machine.

## Stack

- **Next.js 14 (App Router)** + **React 18** — UI and server, on system Node.
- **tRPC** — the typed boundary between the dashboard and the backend; inputs
  and outputs are inferred from the router, so there's no hand-written contract.
- **Drizzle + better-sqlite3** — the app's own SQLite database
  (`src/lib/db/connection.ts`, `schema.ts`).
- **Base UI** (`@base-ui/react`) — all interactive UI primitives.
- **Ax** (`@ax-llm/ax`) — the structured LLM scorer used for analysis runs.
- **eve** — the agent runtime behind the "Ask the timeline" chat.
- **Swift `ContactsHelper`** (`native/macos/`) — reads macOS Contacts to resolve
  handles to names; built via `pnpm build:native`.
- **@huggingface/transformers** (dev) — local distilroberta model for the
  experimental fast triage tier (dynamically imported).

## How it works

1. **Import** — reads Apple's local `~/Library/Messages/chat.db` (requires Full
   Disk Access) and syncs new rows into the app's own SQLite DB, deduping
   contacts, conversations, and messages. Each message gets a deterministic
   `conversation_ordinal` (chronological, with rowid/guid tie-breakers).
   Contacts are resolved to display names via the native Swift helper.
   _(`src/lib/imessage`, `src/lib/import`, `src/lib/sync`, `src/lib/contacts`.)_
2. **Analyze** — an analysis *run* slices a conversation into run-owned
   *windows* (a `context` slice of older messages + a `focal` slice of newer
   ones) and scores each window on the **Ekman-7** anchors — `anger`, `disgust`,
   `fear`, `joy`, `neutral`, `sadness`, `surprise`. The live path is the real Ax
   LLM scorer (one model call per window); there is no lexical fallback —
   missing credentials or model errors fail visibly.
   _(`src/lib/windows`, `src/lib/emotion/run-analysis.ts`, `ax-scorer.ts`,
   `anchors.ts`.)_
3. **Detect shifts** — each window is compared against the prior conversation
   state to flag sharp emotional moves and surface the strongest drivers.
   _(`src/lib/emotion/shifts.ts`.)_
4. **Explore** — the dashboard renders the emotion timeline (per-window
   composition blocks + a valence line over a message-ordinal axis), a window
   inspector, a run dropdown to switch between analysis runs, and an **"Ask the
   timeline"** chat that answers questions about a window or the whole timeline,
   grounded in the actual messages with citations.
   _(`src/dashboard`, `src/lib/chat`, `agent/`.)_

### Scoring paths

| Path | Where | Status |
|---|---|---|
| **Ax per-window LLM** | `run-analysis.ts` + `ax-scorer.ts` | **Live** — what the dashboard's **Recompute (ax)** runs. `createAxRun` plans windows, `finishAxRun`/`scoreAxRun` score them (concurrently), `completeAxRun` computes shifts + a summary. |
| **RoBERTa triage** | `roberta-triage.ts` | Experimental Tier 1 — local distilroberta scores every window in one fast batched pass and ranks by shift magnitude. |
| **Two-tier** | `two-tier-scorer.ts`, `src/app/api/two-tier/route.ts`, `TwoTierRoom.tsx` | Experimental — RoBERTa triage → LLM **deep-read** of only the top-K highest-shift windows, streamed to the UI over SSE. |
| **RLM** | `rlm-scorer.ts` | Experimental — a single Ax RLM agent pages through windows and fans out sub-LLM scoring calls; for large runs. |

The default window planner targets at most **200 windows** per conversation with
**25% overlap** (rejecting overlap outside 10–40%), so long relationships stay
high-fidelity without becoming unreadable thousand-window timelines.

### The eve chat agent

`agent/agent.ts` defines **eve** (Claude Sonnet 4.6 via the Vercel AI Gateway;
override with `EVE_MODEL`). It backs the "Ask the timeline" chat and works
window-by-window, narrating *why* tone moved. Its tools (`agent/tools/`):

- `list_run_windows` — every window in a run with scores, shift deltas, strongest shifts, and recurrence hints.
- `get_window_messages` — the focal/context/all messages in a window.
- `score_window` / `recompute_conversation` — (re)build and score a run's windows.

Window-scoped questions go through a lightweight RAG path
(`src/lib/chat/retrieve.ts` + `answer.ts`) that returns answers with citations
(`W{ordinal}`, `msg #{n}`, `run #{id}`).

## Run it

```bash
pnpm install
pnpm dev            # http://localhost:3000
```

On first launch you'll see the **setup** screen. Granting **Full Disk Access**
(to read `chat.db`) and **Contacts** access enables real syncing — but
**Continue** is a passthrough: it always proceeds to the dashboard. To explore
the full UI without granting permissions, seed mock data first:

```bash
pnpm seed:mock      # writes sample conversations into the app DB
pnpm dev            # then click "Continue" to enter the dashboard
```

With real data: sync your messages, then **Recompute (ax)** a conversation to
analyze it. For batch high-fidelity analysis of the largest one-on-one
conversations:

```bash
pnpm runs:top-ax -- --delete-existing --limit 5 --max-windows 200 --overlap 25 --model google/gemini-2.5-flash
```

### Environment

Copy `.env.example` to `.env.local`. Keys (all optional for `seed:mock` browsing):

| Variable | Purpose |
|---|---|
| `AI_GATEWAY_API_KEY` | eve chat (Vercel AI Gateway). Auto via OIDC when deployed on Vercel. |
| `EVE_MODEL` | eve model override (default `anthropic/claude-sonnet-4.6`). |
| `OPENAI_API_KEY` / `OPENROUTER_API_KEY` | provider for the Ax analysis scorer. |
| `IMESSAGE_EMOTION_DB_PATH` | app DB location (default `~/Library/Application Support/imessage-emotion/imessage-emotion.sqlite`). |
| `IMESSAGE_CHAT_DB_PATH` | override Apple's `chat.db` path (testing). |

## Labeling & evals

A `/labeling` route lets a human annotate analysis windows — pick the dominant
emotion (and acceptable alternatives), flag sarcasm/subtext, context-dependence,
and ambiguity, and leave notes. Labels are saved to the `window_labels` table
(`src/lib/api/labels.ts`). Labeled windows export to **Harbor** eval tasks under
`evals/harbor/tasks/` (`src/lib/eval/harbor-export.ts`), forming an eval
flywheel: label → export → run a scorer against the task → grade against the
human gold label. Exports contain real message text and are gitignored.

## Commands

| Command | Description |
|---|---|
| `pnpm dev` | Run the app locally |
| `pnpm build` / `pnpm start` | Production build (Swift helper + Next) / serve |
| `pnpm build:native` | Build the Swift Contacts helper only |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint |
| `pnpm test` | Vitest |
| `pnpm seed:mock` | Seed sample conversations into the app DB |
| `pnpm runs:top-ax` | Batch-analyze the largest conversations with the Ax scorer |
| `pnpm db:generate` | Drizzle migration generation |
| `pnpm smoke:*` | Local smoke checks (onboarding status, app DB, ax/native DB, privacy) |

## Layout

- `src/app/` — Next.js routes: dashboard (`page.tsx`), `labeling/`, and APIs
  (`api/trpc/[trpc]`, `api/two-tier`).
- `src/server/` — the tRPC router + procedures.
- `src/lib/` — framework-agnostic core:
  - `imessage` (chat.db parsing), `import`, `sync`, `contacts` (resolution +
    FTS search), `db` (schema + connection),
  - `windows` (window planning), `emotion` (Ax / RLM / two-tier scorers, shifts,
    anchors), `chat` (RAG), `onboarding` (permission status), `eval` (Harbor).
- `src/dashboard/` — the React dashboard and its tRPC-backed data client.
- `src/labeling/` — the labeling UI.
- `agent/` — the eve agent definition, instructions, and tools.
- `native/macos/ContactsHelper/` — the Swift Contacts reader.
- `experiments/` — isolated research with their own toolchains: `rlm` (scorer
  benchmarks), `emotion-methods` (scoring-method comparisons), `sqlite-latency`.

## Privacy

Everything is local. The app reads `chat.db` read-only and never transmits
message content. The only outbound calls are the LLM requests you configure for
scoring and chat (the window text you choose to analyze).
