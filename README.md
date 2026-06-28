# iMessage Emotion

Next.js app foundation for analyzing emotion changes over time in local iMessage conversations.

## Data Foundation

The app keeps its own SQLite database under `~/Library/Application Support/imessage-emotion` instead of repeatedly querying Apple's `chat.db` throughout the UI and analysis layers. The local tables dedupe contacts, conversations, and messages so analysis can use deterministic conversation history positions.

Every imported message has a `conversation_ordinal` scoped to its conversation. Ordinals are assigned by normalized chronological order using `sent_at`, source rowid, and guid as deterministic tie-breakers. Windows use ordinal boundaries first, plus start/end message IDs for evidence joins.

Windows are reusable context slices owned by analysis runs, so the same local message history can be scored by many methods without changing the underlying context.

## Included

- Local iMessage reader for `chat.db` access, Apple timestamp conversion, attributed-body text fallback, and handle normalization.
- Local Contacts resolver for display names, company/card IDs, and avatar URLs when available from macOS Contacts.
- App-owned SQLite schema for contacts, conversations, messages, import state, windows, and analysis runs.
- Next/tRPC sync mutations that import local iMessage rows and refresh local contact resolution into the app-owned SQLite database.
- Focused tests for ordinal assignment, contact resolution, sync controllers, windows, and run summaries.

## Not Included

- Emotion scoring.
- A full sync daemon or queue runtime.
- Raw local databases or private message fixtures.
