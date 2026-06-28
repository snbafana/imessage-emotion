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
   *windows* (context + focal message ranges) and scores each with a baseline
   lexical scorer (warmth / joy / trust / stress / friction / sadness).
3. **Detect shifts** — windows are compared against a rolling baseline to flag
   warmer/tenser shifts and surface the strongest drivers.
4. **Explore** — the dashboard shows the emotion timeline (colored composition
   blocks + a valence line); the chat panel answers questions about a selected
   window, grounded in its messages.

## Run it

```bash
pnpm install
pnpm dev            # http://localhost:3000
```

The app stores its DB at
`~/Library/Application Support/imessage-emotion/imessage-emotion.sqlite`
(override with `IMESSAGE_EMOTION_DB_PATH`).

### Try it with fake data (no Full Disk Access needed)

```bash
pnpm seed           # populates the DB with synthetic conversations + a scored run
pnpm dev
```

## Commands

| Command | Description |
|---|---|
| `pnpm dev` | Run the app locally |
| `pnpm build` / `pnpm start` | Production build / serve |
| `pnpm seed` | Seed the DB with synthetic data |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint |
| `pnpm test` | Vitest (data-foundation unit tests) |

## Layout

- `app/` — Next.js routes; `app/api/trpc/[trpc]` exposes the tRPC router.
- `src/server/` — tRPC router + procedures.
- `src/lib/` — framework-agnostic core: `imessage` parsing, `db` schema +
  connection, `import`, `windows`, `emotion` (baseline + shifts), `chat`.
- `src/dashboard/` — the React dashboard and its tRPC-backed data client.

## Privacy

Everything is local. The app reads `chat.db` read-only and never transmits
message content.
