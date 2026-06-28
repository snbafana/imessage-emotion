# iMessage Emotion

Electron app foundation for analyzing emotion changes over time in local iMessage conversations.

## Data Foundation

The app keeps its own SQLite database under Electron `userData` instead of repeatedly querying Apple's `chat.db` throughout the UI and analysis layers. The local tables dedupe contacts, conversations, and messages so analysis can use deterministic conversation history positions.

Every imported message has a `conversation_ordinal` scoped to its conversation. Ordinals are assigned by normalized chronological order using `sent_at`, source rowid, and guid as deterministic tie-breakers. Windows use ordinal boundaries first, plus start/end message IDs for evidence joins.

Windows are reusable context slices. A scoring run points at existing windows through `run_windows`, so the same window can be scored by many methods without changing the underlying context.

## Included

- Local iMessage reader for `chat.db` access, Apple timestamp conversion, attributed-body text fallback, and handle normalization.
- App-owned SQLite schema for contacts, conversations, messages, import state, windows, scorer configs, runs, results, and shifts.
- Main-process sync loop that imports new local iMessage rows while the Electron app is open.
- Focused tests for ordinal assignment, overlapping windows, tail handling, and run-to-window relationships.

## Not Included

- Emotion scoring.
- A full sync daemon or queue runtime.
- Electron UI for browsing imported messages or analysis results.
- Raw local databases or private message fixtures.
