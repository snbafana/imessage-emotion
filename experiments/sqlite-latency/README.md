# SQLite Latency Benchmark

Benchmarks TypeScript `better-sqlite3` against Rust `rusqlite` for the local data operations expected by the iMessage emotion-over-time app. Synthetic runs use generated data for reproducibility; the optional real-device run uses the app-owned imported SQLite DB only and prints privacy-safe aggregates.

## Recommendation

Use TypeScript plus `better-sqlite3` for V1.

The mandatory message range index is far more important than the app-language/runtime boundary for this workload. With `messages(conversation_id, ordinal)`, both practical package stacks fetched 1,000 random windows in roughly 54-57 ms p50 on 100k messages. Rust was faster for analysis writes, but the absolute difference is single-digit milliseconds at this data size.

Defer Rust until after V1 unless later profiling shows CPU-heavy import normalization, scoring orchestration, or much larger local datasets are bottlenecking the Electron main process.

## Environment

- OS: macOS 26.2, arm64
- Node: v24.4.0
- npm: 11.4.2
- `better-sqlite3`: 12.11.1
- `better-sqlite3` SQLite: 3.53.2
- Rust: `rustc 1.91.0 (f8297e351 2025-10-28)`
- Cargo: `cargo 1.91.0 (ea2d97820 2025-10-10)`
- `rusqlite`: 0.32.1 with bundled SQLite 3.46.0 through `libsqlite3-sys` 0.30.1

## Commands Run

```bash
cd experiments/sqlite-latency
npm install
npx tsc --noEmit
npm run bench
npm run bench:real
cargo check -p sqlite-latency-rust
cargo run --release -p sqlite-latency-rust
```

Generated DBs and raw JSON results are ignored under `tmp/` and `results/`.

`npm run bench:real` opens the app-owned imported SQLite DB, makes an ignored temp backup, and benchmarks against that temp copy. It never reads or falls back to `~/Library/Messages/chat.db`.

Default app DB path:

```text
~/Library/Application Support/imessage-emotion/imessage-emotion.sqlite
```

Set `IMESSAGE_APP_DB=/absolute/path/to/imessage-emotion.sqlite` to benchmark a different app-owned imported DB. If the DB is missing or has no imported messages/conversations, the command fails with setup guidance to run the app sync/import first.

The real benchmark output does not include message text, phone numbers, emails, private names, handles, GUIDs, source chat ids, or source row ids. It prints only:

- aggregate table counts
- benchmark row counts
- timing percentiles
- index names
- query-plan details

Optional limits:

- `REAL_MESSAGE_LIMIT`, default `100000`
- `REAL_CONVERSATION_LIMIT`, default `5`

## Data

- 100,000 synthetic messages
- 5 conversations
- 50 contacts
- 10 participants per conversation
- Deterministic timestamps and per-conversation ordinal assignment
- Mostly short text payloads, with every 10th message longer and every 100th message much longer
- Windows:
  - size 100, stride 50
  - size 250, stride 125
- Generated rows:
  - 100,000 `messages`
  - 501 `analysis_runs`
  - 2,790 `windows`
  - 2,790 `run_windows`
  - 2,790 `window_results`
  - 1,990 `shifts`

## Schema

Tables:

- `contacts`
- `conversations`
- `conversation_participants`
- `raw_messages`
- `messages`
- `import_state`
- `window_configs`
- `windows`
- `analysis_runs`
- `run_windows`
- `window_results`
- `shifts`

Important modeled constraints:

- App variants enforce `UNIQUE INDEX messages(conversation_id, ordinal)`.
- Windows are stored as deterministic ordinal ranges: `conversation_id`, `window_config_id`, `start_ordinal`, `end_ordinal`.
- Analysis rows are linked through `analysis_runs -> run_windows -> window_results`; shifts reference adjacent windows.

## Index Variants

- `pk_only`: primary keys only. This intentionally omits the required `(conversation_id, ordinal)` uniqueness so it can serve as a baseline with no useful message range index.
- `message_ordinal`: adds `UNIQUE INDEX messages(conversation_id, ordinal)`.
- `app_indexes`: adds the message ordinal unique index plus:
  - `windows(conversation_id, window_config_id, start_ordinal, end_ordinal)`
  - `run_windows(run_id, window_id)`
  - `window_results(run_window_id)`
  - `shifts(conversation_id, run_id)`
  - `analysis_runs(status, completed_at_ms DESC, id DESC)`

## Results

Times are milliseconds across 5 measured iterations after 1 warmup. `p95` is coarse because the sample size is intentionally small.

This compares practical package defaults, not a pure language-only boundary: `better-sqlite3` used bundled SQLite 3.53.2, while `rusqlite` used bundled SQLite 3.46.0.

### TypeScript `better-sqlite3`

| Variant | Operation | p50 | p95 | Mean |
| --- | --- | ---: | ---: | ---: |
| `pk_only` | schema bootstrap | 0.96 | 1.52 | 1.06 |
| `pk_only` | bulk insert raw | 169.16 | 260.84 | 189.83 |
| `pk_only` | assign ordinals | 143.73 | 271.00 | 169.63 |
| `pk_only` | create windows | 14.50 | 14.75 | 14.48 |
| `pk_only` | fetch one window | 2.19 | 2.53 | 2.27 |
| `pk_only` | fetch 1k windows | 2126.16 | 2145.68 | 2110.85 |
| `pk_only` | insert analysis rows | 6.68 | 6.91 | 6.73 |
| `pk_only` | query latest run | 0.42 | 0.43 | 0.41 |
| `message_ordinal` | schema bootstrap | 1.16 | 1.39 | 1.11 |
| `message_ordinal` | bulk insert raw | 161.43 | 194.26 | 168.57 |
| `message_ordinal` | assign ordinals | 180.17 | 194.22 | 178.87 |
| `message_ordinal` | create windows | 4.12 | 4.21 | 4.12 |
| `message_ordinal` | fetch one window | 0.15 | 0.26 | 0.17 |
| `message_ordinal` | fetch 1k windows | 55.10 | 76.36 | 59.18 |
| `message_ordinal` | insert analysis rows | 6.93 | 11.08 | 7.77 |
| `message_ordinal` | query latest run | 0.45 | 1.10 | 0.57 |
| `app_indexes` | schema bootstrap | 1.46 | 50.84 | 11.35 |
| `app_indexes` | bulk insert raw | 299.82 | 347.34 | 277.97 |
| `app_indexes` | assign ordinals | 222.64 | 351.93 | 243.80 |
| `app_indexes` | create windows | 4.56 | 6.31 | 4.92 |
| `app_indexes` | fetch one window | 0.15 | 0.18 | 0.16 |
| `app_indexes` | fetch 1k windows | 53.63 | 56.28 | 54.15 |
| `app_indexes` | insert analysis rows | 8.27 | 9.28 | 8.39 |
| `app_indexes` | query latest run | 0.57 | 0.61 | 0.58 |

### Rust `rusqlite`

| Variant | Operation | p50 | p95 | Mean |
| --- | --- | ---: | ---: | ---: |
| `pk_only` | schema bootstrap | 1.18 | 2.97 | 1.44 |
| `pk_only` | bulk insert raw | 227.38 | 582.73 | 277.08 |
| `pk_only` | assign ordinals | 187.24 | 384.45 | 237.32 |
| `pk_only` | create windows | 20.11 | 25.11 | 20.14 |
| `pk_only` | fetch one window | 3.63 | 6.59 | 4.32 |
| `pk_only` | fetch 1k windows | 3311.65 | 4314.41 | 3486.87 |
| `pk_only` | insert analysis rows | 4.00 | 4.71 | 4.08 |
| `pk_only` | query latest run | 0.36 | 0.37 | 0.36 |
| `message_ordinal` | schema bootstrap | 1.06 | 3.00 | 1.41 |
| `message_ordinal` | bulk insert raw | 248.10 | 414.90 | 248.80 |
| `message_ordinal` | assign ordinals | 190.96 | 313.31 | 215.39 |
| `message_ordinal` | create windows | 3.93 | 8.10 | 4.73 |
| `message_ordinal` | fetch one window | 0.16 | 0.16 | 0.15 |
| `message_ordinal` | fetch 1k windows | 55.77 | 61.82 | 57.55 |
| `message_ordinal` | insert analysis rows | 3.88 | 4.02 | 3.83 |
| `message_ordinal` | query latest run | 0.36 | 0.37 | 0.36 |
| `app_indexes` | schema bootstrap | 1.73 | 2.47 | 1.83 |
| `app_indexes` | bulk insert raw | 165.29 | 201.58 | 169.67 |
| `app_indexes` | assign ordinals | 231.44 | 1970.09 | 607.71 |
| `app_indexes` | create windows | 4.60 | 19.71 | 7.64 |
| `app_indexes` | fetch one window | 0.15 | 0.32 | 0.18 |
| `app_indexes` | fetch 1k windows | 56.39 | 95.80 | 64.20 |
| `app_indexes` | insert analysis rows | 5.66 | 6.46 | 5.80 |
| `app_indexes` | query latest run | 0.52 | 0.60 | 0.53 |

## Real-Device App-DB Validation

Command:

```bash
cd experiments/sqlite-latency
npm run bench:real
```

Latest local run:

```json
{
  "source": {
    "kind": "app-owned-imported-db",
    "path": "~/Library/Application Support/imessage-emotion/imessage-emotion.sqlite",
    "sourceCounts": {
      "contacts": 223,
      "conversations": 191,
      "messages": 7177,
      "window_configs": 1,
      "windows": 24,
      "scorer_configs": 1,
      "analysis_runs": 1,
      "run_windows": 0,
      "window_results": 0,
      "shifts": 0,
      "import_state": 0
    }
  },
  "tempCopy": {
    "path": "experiments/sqlite-latency/tmp/real/app-db-copy.sqlite",
    "backup_ms": 0.06
  },
  "limits": {
    "messageLimit": 100000,
    "conversationLimit": 5
  },
  "setupTimingsMs": {
    "ensure_windows": 2.35,
    "insert_analysis": 0.56
  },
  "timingPercentilesMs": {
    "fetch_one_window": {
      "p50_ms": 0.07,
      "p95_ms": 0.08,
      "mean_ms": 0.07,
      "iterations": 5,
      "result": 250
    },
    "fetch_1k_windows": {
      "p50_ms": 24.26,
      "p95_ms": 25.21,
      "mean_ms": 24.05,
      "iterations": 5,
      "result": 103790
    },
    "query_latest_run": {
      "p50_ms": 0.17,
      "p95_ms": 0.19,
      "mean_ms": 0.17,
      "iterations": 5,
      "result": 40
    }
  },
  "resultRows": {
    "ensured_windows": 47,
    "analysis_windows": 71,
    "fetch_one_window_rows": 250,
    "fetch_1k_window_rows": 103790,
    "latest_run_rows": 40
  },
  "finalCounts": {
    "contacts": 223,
    "conversations": 191,
    "messages": 7177,
    "window_configs": 3,
    "windows": 71,
    "scorer_configs": 2,
    "analysis_runs": 2,
    "run_windows": 71,
    "window_results": 71,
    "shifts": 23,
    "import_state": 0
  },
  "indexes": [
    "messages_conversation_order_idx",
    "messages_conversation_time_idx",
    "windows_conversation_order_idx"
  ],
  "queryPlans": {
    "fetchWindow": [
      "SEARCH messages USING INDEX messages_conversation_order_idx (conversation_id=? AND conversation_ordinal>? AND conversation_ordinal<?)"
    ],
    "latestRun": [
      "CO-ROUTINE latest_run",
      "SCAN analysis_runs",
      "USE TEMP B-TREE FOR ORDER BY",
      "SCAN lr",
      "SEARCH rw USING COVERING INDEX sqlite_autoindex_run_windows_1 (run_id=?)",
      "SEARCH w USING INTEGER PRIMARY KEY (rowid=?)",
      "SEARCH wr USING INDEX sqlite_autoindex_window_results_1 (run_id=? AND window_id=?)",
      "USE TEMP B-TREE FOR ORDER BY"
    ]
  }
}
```

The run wrote only ignored artifacts under `tmp/real/` and `results/real-app-db.json`.

## Interpretation

Mandatory schema/index choices:

- Keep a per-conversation monotonic ordinal and enforce `UNIQUE INDEX messages(conversation_id, ordinal)`.
- Use ordinal range windows; do not window by timestamp for the hot context-fetch path.
- Add `windows(conversation_id, window_config_id, start_ordinal, end_ordinal)` for conversation/config-specific result views and deterministic window lookup.
- Add `run_windows(run_id, window_id)`, `window_results(run_window_id)`, and `analysis_runs(status, completed_at_ms DESC, id DESC)` for latest-run hydration.

What to optimize first:

1. Message range indexing and query shape. Without the ordinal index, 1,000 random window context fetches were seconds instead of tens of milliseconds.
2. Batched writes in explicit transactions. Both runners insert 100k messages and thousands of analysis rows comfortably when writes are batched.
3. Avoid creating overlapping windows on demand in the UI path. Precompute windows by config and query them by ordinal range.
4. Keep scoring/analysis writes append-oriented. The modeled `analysis_runs -> run_windows -> window_results` path is not a bottleneck at this scale.

Where Rust is materially better:

- Rust is consistently faster for analysis row writes in this benchmark, around 6 ms p50 vs 8 ms p50 for `better-sqlite3` with app indexes.
- Rust is not materially faster for indexed window context fetches once both runners materialize the selected text/display-name rows.
- These differences do not justify a Rust sidecar for V1 by themselves.

Benchmark caveats:

- This is a local wall-clock microbenchmark, not a full app profile.
- It does not include Electron IPC, UI rendering, iMessage import parsing, or emotion model latency.
- `p95` uses only 5 measured samples, so treat it as an outlier flag rather than a distribution guarantee.
- The `pk_only` variant is intentionally not the app schema because it omits required message ordinal uniqueness.
