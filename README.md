# Undercurrent — iMessage Emotion Timeline

A **local-first** app that visualizes how the emotional tone of your iMessage
conversations shifts over time, and lets you ask *why* a shift happened.

It runs entirely on your Mac: a Next.js server reads your local Messages
database, scores conversation windows, and serves a dashboard — nothing leaves
the machine.

## Stack

- **Next.js (App Router)** — UI + server, runs on system Node.
- **tRPC** — the typed boundary between the dashboard and the backend. Procedure
  inputs/outputs are inferred from the router, so there is no hand-maintained
  client/server contract.
- **Drizzle + better-sqlite3** — Drizzle owns the connection to the app's own
  SQLite database (`src/lib/db/connection.ts`).

## How it works

1. **Import** — the importer reads Apple's local `~/Library/Messages/chat.db`
   (requires Full Disk Access) and syncs new rows into the app's own SQLite DB,
   deduping contacts/conversations/messages. Each message gets a deterministic
   `conversation_ordinal` (chronological, with rowid/guid tie-breakers).
2. **Analyze** — an analysis *run* slices a conversation into run-owned
   *windows* (context + focal message ranges) and scores each with the real Ax
   LLM scorer on the Ekman anchors: anger / disgust / fear / joy / neutral /
   sadness / surprise. There is no lexical fallback for analysis runs; missing
   credentials or model errors fail visibly.
3. **Detect shifts** — windows are compared against the prior conversation state
   to flag sharp emotional moves and surface the strongest drivers.
4. **Explore** — the dashboard opens on a cross-conversation **Overview** that
   charts the net-valence arc of every analyzed conversation side by side (with
   sharp-shift markers), so you can compare 3-5 relationships at a glance. Select
   one to drop into its **Detail** view: the full emotion timeline (colored
   composition blocks + per-emotion lines) plus a chat panel that answers
   questions about a selected window, grounded in its messages.

## Run it

```bash
pnpm install
pnpm dev            # http://localhost:3000
```

The app stores its DB at
`~/Library/Application Support/imessage-emotion/imessage-emotion.sqlite`
(override with `IMESSAGE_EMOTION_DB_PATH`). Sync your messages, then recompute a
conversation (the **Recompute (ax)** button) to analyze it — the sidebar shows
only conversations that have been analyzed.

For high-fidelity local analysis of the five largest one-on-one conversations:

```bash
pnpm runs:top-ax -- --delete-existing --limit 5 --max-windows 200 --overlap 25 --model google/gemini-2.5-flash
```

The default run planner targets at most 200 windows per conversation with 25%
overlap, and rejects overlap outside 10-40%. That keeps the analysis high
fidelity without turning long relationships into unreadable thousand-window
timelines. It still does one real model call per window and stores the model's
per-window rationale plus per-emotion rationales in the run result.

## Commands

| Command | Description |
|---|---|
| `pnpm dev` | Run the app locally |
| `pnpm build` / `pnpm start` | Production build / serve |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint |
| `pnpm test` | Vitest (data-foundation unit tests) |

## Layout

- `app/` — Next.js routes; `app/api/trpc/[trpc]` exposes the tRPC router.
- `src/server/` — tRPC router + procedures.
- `src/lib/` — framework-agnostic core: `imessage` parsing, `db` schema +
  connection, `import`, `windows`, `emotion` (Ax scoring + shifts), `chat`.
- `src/dashboard/` — the React dashboard and its tRPC-backed data client.

## Privacy

Everything is local. The app reads `chat.db` read-only and never transmits
message content.
