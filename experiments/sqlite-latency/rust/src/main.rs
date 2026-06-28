use rusqlite::{params, Connection};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

const MESSAGE_COUNT: i64 = 100_000;
const CONVERSATION_COUNT: i64 = 5;
const CONTACT_COUNT: i64 = 50;
const HISTORICAL_RUN_COUNT: i64 = 500;
const WARMUP_ITERATIONS: i32 = 1;
const MEASURED_ITERATIONS: i32 = 5;
const BASE_TIME_MS: i64 = 1_767_225_600_000;
const VARIANTS: [&str; 3] = ["pk_only", "message_ordinal", "app_indexes"];

#[derive(Clone)]
struct IterationResult {
    variant: String,
    iteration: i32,
    timings: Vec<(&'static str, f64)>,
    counts: Vec<(&'static str, i64)>,
}

#[derive(Clone)]
struct WindowRow {
    id: i64,
    conversation_id: i64,
    window_config_id: i64,
}

struct Lcg {
    state: u32,
}

impl Lcg {
    fn new(seed: u32) -> Self {
        Self { state: seed }
    }

    fn next_int(&mut self, max_exclusive: usize) -> usize {
        self.state = self
            .state
            .wrapping_mul(1_664_525)
            .wrapping_add(1_013_904_223);
        self.state as usize % max_exclusive
    }
}

fn main() -> rusqlite::Result<()> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("rust crate should sit below experiment root")
        .to_path_buf();
    let tmp_dir = root.join("tmp").join("rust");
    let results_dir = root.join("results");
    fs::create_dir_all(&tmp_dir).expect("create tmp dir");
    fs::create_dir_all(&results_dir).expect("create results dir");

    let mut measured = Vec::new();
    let mut all = Vec::new();
    for variant in VARIANTS {
        for iteration in -WARMUP_ITERATIONS..MEASURED_ITERATIONS {
            let result = run_iteration(variant, iteration, &tmp_dir)?;
            let total_ms: f64 = result.timings.iter().map(|(_, value)| value).sum();
            println!(
                "rust-rusqlite {} iteration {}: {:.2}ms",
                variant, iteration, total_ms
            );
            if iteration >= 0 {
                measured.push(result.clone());
            }
            all.push(result);
        }
    }

    fs::write(results_dir.join("rust-rusqlite.json"), to_json(&all)).expect("write rust results");
    summarize(&measured);
    Ok(())
}

fn run_iteration(variant: &str, iteration: i32, tmp_dir: &Path) -> rusqlite::Result<IterationResult> {
    let db_path = tmp_dir.join(format!("{}-{}.db", variant, iteration));
    let _ = fs::remove_file(&db_path);
    let _ = fs::remove_file(db_path.with_extension("db-wal"));
    let _ = fs::remove_file(db_path.with_extension("db-shm"));
    let conn = Connection::open(&db_path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;

    let mut timings = Vec::new();
    measure(&mut timings, "schema_bootstrap", || create_schema(&conn, variant))?;
    measure(&mut timings, "bulk_insert_raw", || bulk_insert_raw(&conn))?;
    measure(&mut timings, "assign_ordinals", || assign_ordinals(&conn))?;
    measure(&mut timings, "create_windows", || create_windows(&conn))?;
    let fetch_one_rows = measure(&mut timings, "fetch_one_window", || fetch_one_window(&conn))?;
    let fetch_many_rows = measure(&mut timings, "fetch_1k_windows", || fetch_random_windows(&conn))?;
    let analysis_windows = measure(&mut timings, "insert_analysis", || insert_analysis(&conn))?;
    let latest_rows = measure(&mut timings, "query_latest_run", || query_latest_run(&conn))?;

    let counts = vec![
        ("fetch_one_window_rows", fetch_one_rows),
        ("fetch_1k_window_rows", fetch_many_rows),
        ("analysis_windows", analysis_windows),
        ("latest_run_rows", latest_rows),
        ("contacts", count_rows(&conn, "contacts")?),
        ("conversations", count_rows(&conn, "conversations")?),
        ("raw_messages", count_rows(&conn, "raw_messages")?),
        ("messages", count_rows(&conn, "messages")?),
        ("analysis_runs", count_rows(&conn, "analysis_runs")?),
        ("windows", count_rows(&conn, "windows")?),
        ("run_windows", count_rows(&conn, "run_windows")?),
        ("window_results", count_rows(&conn, "window_results")?),
        ("shifts", count_rows(&conn, "shifts")?),
    ];

    Ok(IterationResult {
        variant: variant.to_string(),
        iteration,
        timings,
        counts,
    })
}

fn measure<T, F>(timings: &mut Vec<(&'static str, f64)>, name: &'static str, run: F) -> rusqlite::Result<T>
where
    F: FnOnce() -> rusqlite::Result<T>,
{
    let start = Instant::now();
    let result = run()?;
    timings.push((name, start.elapsed().as_secs_f64() * 1_000.0));
    Ok(result)
}

fn create_schema(conn: &Connection, variant: &str) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE contacts (
          id INTEGER PRIMARY KEY,
          display_name TEXT NOT NULL,
          handle TEXT NOT NULL UNIQUE
        );

        CREATE TABLE conversations (
          id INTEGER PRIMARY KEY,
          external_id TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL
        );

        CREATE TABLE conversation_participants (
          conversation_id INTEGER NOT NULL REFERENCES conversations(id),
          contact_id INTEGER NOT NULL REFERENCES contacts(id),
          PRIMARY KEY (conversation_id, contact_id)
        );

        CREATE TABLE raw_messages (
          id INTEGER PRIMARY KEY,
          conversation_id INTEGER NOT NULL REFERENCES conversations(id),
          contact_id INTEGER NOT NULL REFERENCES contacts(id),
          sent_at_ms INTEGER NOT NULL,
          text TEXT NOT NULL
        );

        CREATE TABLE messages (
          id INTEGER PRIMARY KEY,
          conversation_id INTEGER NOT NULL REFERENCES conversations(id),
          ordinal INTEGER NOT NULL,
          contact_id INTEGER NOT NULL REFERENCES contacts(id),
          sent_at_ms INTEGER NOT NULL,
          text TEXT NOT NULL
        );

        CREATE TABLE import_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          last_raw_message_id INTEGER NOT NULL,
          imported_at_ms INTEGER NOT NULL
        );

        CREATE TABLE window_configs (
          id INTEGER PRIMARY KEY,
          size INTEGER NOT NULL,
          stride INTEGER NOT NULL,
          label TEXT NOT NULL UNIQUE
        );

        CREATE TABLE windows (
          id INTEGER PRIMARY KEY,
          conversation_id INTEGER NOT NULL REFERENCES conversations(id),
          window_config_id INTEGER NOT NULL REFERENCES window_configs(id),
          start_ordinal INTEGER NOT NULL,
          end_ordinal INTEGER NOT NULL
        );

        CREATE TABLE analysis_runs (
          id INTEGER PRIMARY KEY,
          started_at_ms INTEGER NOT NULL,
          completed_at_ms INTEGER,
          model TEXT NOT NULL,
          status TEXT NOT NULL
        );

        CREATE TABLE run_windows (
          id INTEGER PRIMARY KEY,
          run_id INTEGER NOT NULL REFERENCES analysis_runs(id),
          window_id INTEGER NOT NULL REFERENCES windows(id),
          status TEXT NOT NULL
        );

        CREATE TABLE window_results (
          id INTEGER PRIMARY KEY,
          run_window_id INTEGER NOT NULL REFERENCES run_windows(id),
          score REAL NOT NULL,
          label TEXT NOT NULL,
          summary TEXT NOT NULL
        );

        CREATE TABLE shifts (
          id INTEGER PRIMARY KEY,
          conversation_id INTEGER NOT NULL REFERENCES conversations(id),
          run_id INTEGER NOT NULL REFERENCES analysis_runs(id),
          from_window_id INTEGER NOT NULL REFERENCES windows(id),
          to_window_id INTEGER NOT NULL REFERENCES windows(id),
          magnitude REAL NOT NULL,
          direction TEXT NOT NULL
        );
        "#,
    )?;

    if variant == "message_ordinal" || variant == "app_indexes" {
        conn.execute_batch("CREATE UNIQUE INDEX messages_conversation_ordinal ON messages(conversation_id, ordinal);")?;
    }

    if variant == "app_indexes" {
        conn.execute_batch(
            r#"
            CREATE INDEX windows_conversation_config_range
              ON windows(conversation_id, window_config_id, start_ordinal, end_ordinal);
            CREATE INDEX run_windows_run_window ON run_windows(run_id, window_id);
            CREATE INDEX window_results_run_window ON window_results(run_window_id);
            CREATE INDEX shifts_conversation_run ON shifts(conversation_id, run_id);
            CREATE INDEX analysis_runs_latest ON analysis_runs(status, completed_at_ms DESC, id DESC);
            "#,
        )?;
    }
    Ok(())
}

fn text_for_message(i: i64) -> String {
    let base = format!("message {} checking in about dinner, timing, and weekend plans", i);
    if i % 100 == 0 {
        return format!(
            "{}. {}",
            base,
            "longer context with emotional nuance and a few details ".repeat(10)
        );
    }
    if i % 10 == 0 {
        return format!("{}. {}", base, "extra detail ".repeat(8));
    }
    base
}

fn bulk_insert_raw(conn: &Connection) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    {
        let mut insert_contact =
            tx.prepare("INSERT INTO contacts (id, display_name, handle) VALUES (?, ?, ?)")?;
        for contact_id in 1..=CONTACT_COUNT {
            insert_contact.execute(params![
                contact_id,
                format!("Contact {}", contact_id),
                format!("+1555000{:04}", contact_id)
            ])?;
        }
    }
    {
        let mut insert_conversation =
            tx.prepare("INSERT INTO conversations (id, external_id, title) VALUES (?, ?, ?)")?;
        let mut insert_participant = tx.prepare(
            "INSERT INTO conversation_participants (conversation_id, contact_id) VALUES (?, ?)",
        )?;
        for conversation_id in 1..=CONVERSATION_COUNT {
            insert_conversation.execute(params![
                conversation_id,
                format!("chat-{}", conversation_id),
                format!("Conversation {}", conversation_id)
            ])?;
            for offset in 0..10 {
                let contact_id = ((conversation_id - 1) * 10 + offset) % CONTACT_COUNT + 1;
                insert_participant.execute(params![conversation_id, contact_id])?;
            }
        }
    }
    {
        let mut insert_raw = tx.prepare(
            "INSERT INTO raw_messages (id, conversation_id, contact_id, sent_at_ms, text) VALUES (?, ?, ?, ?, ?)",
        )?;
        for i in 1..=MESSAGE_COUNT {
            let conversation_id = ((i - 1) % CONVERSATION_COUNT) + 1;
            let ordinal_seed = (i - 1) / CONVERSATION_COUNT;
            let contact_id = ((conversation_id - 1) * 10 + (i % 10)) % CONTACT_COUNT + 1;
            insert_raw.execute(params![
                i,
                conversation_id,
                contact_id,
                BASE_TIME_MS + conversation_id * 1_000 + ordinal_seed * 60_000,
                text_for_message(i)
            ])?;
        }
    }
    tx.execute(
        "INSERT INTO import_state (id, last_raw_message_id, imported_at_ms) VALUES (1, ?, ?)",
        params![MESSAGE_COUNT, BASE_TIME_MS + MESSAGE_COUNT * 60_000],
    )?;
    tx.commit()
}

fn assign_ordinals(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        INSERT INTO messages (conversation_id, ordinal, contact_id, sent_at_ms, text)
        SELECT
          conversation_id,
          ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY sent_at_ms, id) AS ordinal,
          contact_id,
          sent_at_ms,
          text
        FROM raw_messages
        ORDER BY id;
        "#,
    )
}

fn create_windows(conn: &Connection) -> rusqlite::Result<()> {
    let counts: Vec<(i64, i64)> = {
        let mut stmt =
            conn.prepare("SELECT conversation_id, MAX(ordinal) AS message_count FROM messages GROUP BY conversation_id")?;
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO window_configs (id, size, stride, label) VALUES (?, ?, ?, ?)",
        params![1, 100, 50, "100/50"],
    )?;
    tx.execute(
        "INSERT INTO window_configs (id, size, stride, label) VALUES (?, ?, ?, ?)",
        params![2, 250, 125, "250/125"],
    )?;
    {
        let mut insert_window = tx.prepare(
            "INSERT INTO windows (conversation_id, window_config_id, start_ordinal, end_ordinal) VALUES (?, ?, ?, ?)",
        )?;
        for (conversation_id, message_count) in counts {
            for (config_id, size, stride) in [(1, 100, 50), (2, 250, 125)] {
                let mut start = 1;
                while start + size - 1 <= message_count {
                    insert_window.execute(params![conversation_id, config_id, start, start + size - 1])?;
                    start += stride;
                }
            }
        }
    }
    tx.commit()
}

fn fetch_one_window(conn: &Connection) -> rusqlite::Result<i64> {
    let mut stmt = conn.prepare(
        r#"
        SELECT m.ordinal, m.sent_at_ms, m.text, c.display_name
        FROM messages m
        JOIN contacts c ON c.id = m.contact_id
        WHERE m.conversation_id = ? AND m.ordinal BETWEEN ? AND ?
        ORDER BY m.ordinal
        "#,
    )?;
    let rows = stmt
        .query_map(params![1, 5_001, 5_250], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows.len() as i64)
}

fn fetch_random_windows(conn: &Connection) -> rusqlite::Result<i64> {
    let windows: Vec<(i64, i64, i64)> = {
        let mut stmt =
            conn.prepare("SELECT conversation_id, start_ordinal, end_ordinal FROM windows ORDER BY id")?;
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let mut stmt = conn.prepare(
        r#"
        SELECT m.ordinal, m.sent_at_ms, m.text, c.display_name
        FROM messages m
        JOIN contacts c ON c.id = m.contact_id
        WHERE m.conversation_id = ? AND m.ordinal BETWEEN ? AND ?
        ORDER BY m.ordinal
        "#,
    )?;
    let mut rng = Lcg::new(0x5eed);
    let mut rows = 0;
    for _ in 0..1_000 {
        let window = windows[rng.next_int(windows.len())];
        let fetched = stmt
            .query_map(params![window.0, window.1, window.2], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows += fetched.len() as i64;
    }
    Ok(rows)
}

fn insert_analysis(conn: &Connection) -> rusqlite::Result<i64> {
    let windows: Vec<WindowRow> = {
        let mut stmt = conn.prepare("SELECT id, conversation_id, window_config_id FROM windows ORDER BY id")?;
        let rows = stmt
            .query_map([], |row| {
                Ok(WindowRow {
                    id: row.get(0)?,
                    conversation_id: row.get(1)?,
                    window_config_id: row.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };

    let tx = conn.unchecked_transaction()?;
    {
        let mut insert_historical_run = tx.prepare(
            "INSERT INTO analysis_runs (started_at_ms, completed_at_ms, model, status) VALUES (?, ?, ?, ?)",
        )?;
        for i in 0..HISTORICAL_RUN_COUNT {
            insert_historical_run.execute(params![
                BASE_TIME_MS - HISTORICAL_RUN_COUNT + i,
                BASE_TIME_MS - HISTORICAL_RUN_COUNT + i,
                "synthetic-v0",
                "complete"
            ])?;
        }
    }
    tx.execute(
        "INSERT INTO analysis_runs (started_at_ms, completed_at_ms, model, status) VALUES (?, NULL, ?, ?)",
        params![BASE_TIME_MS + 1, "synthetic-v1", "running"],
    )?;
    let run_id = tx.last_insert_rowid();
    {
        let mut insert_run_window =
            tx.prepare("INSERT INTO run_windows (run_id, window_id, status) VALUES (?, ?, ?)")?;
        let mut update_run_window = tx.prepare("UPDATE run_windows SET status = ? WHERE id = ?")?;
        let mut insert_result = tx.prepare(
            "INSERT INTO window_results (run_window_id, score, label, summary) VALUES (?, ?, ?, ?)",
        )?;
        for window in &windows {
            insert_run_window.execute(params![run_id, window.id, "queued"])?;
            let run_window_id = tx.last_insert_rowid();
            let score = ((window.id * 37) % 1_000) as f64 / 1_000.0;
            insert_result.execute(params![
                run_window_id,
                score,
                if score > 0.5 { "warm" } else { "cool" },
                format!("summary for window {}", window.id)
            ])?;
            update_run_window.execute(params!["done", run_window_id])?;
        }
    }
    {
        let mut insert_shift = tx.prepare(
            r#"
            INSERT INTO shifts
              (conversation_id, run_id, from_window_id, to_window_id, magnitude, direction)
              VALUES (?, ?, ?, ?, ?, ?)
            "#,
        )?;
        let size_100_windows: Vec<&WindowRow> =
            windows.iter().filter(|window| window.window_config_id == 1).collect();
        for conversation_id in 1..=CONVERSATION_COUNT {
            let conversation_windows: Vec<&WindowRow> = size_100_windows
                .iter()
                .copied()
                .filter(|window| window.conversation_id == conversation_id)
                .collect();
            for pair in conversation_windows.windows(2) {
                let from = pair[0];
                let to = pair[1];
                let magnitude = ((to.id - from.id) % 100) as f64 / 100.0;
                insert_shift.execute(params![
                    conversation_id,
                    run_id,
                    from.id,
                    to.id,
                    magnitude,
                    if magnitude > 0.5 { "up" } else { "down" }
                ])?;
            }
        }
    }
    tx.execute(
        "UPDATE analysis_runs SET completed_at_ms = ?, status = ? WHERE id = ?",
        params![BASE_TIME_MS + 2, "complete", run_id],
    )?;
    tx.commit()?;
    Ok(windows.len() as i64)
}

fn query_latest_run(conn: &Connection) -> rusqlite::Result<i64> {
    let mut stmt = conn.prepare(
        r#"
        WITH latest_run AS (
          SELECT id
          FROM analysis_runs
          WHERE status = 'complete'
          ORDER BY completed_at_ms DESC, id DESC
          LIMIT 1
        )
        SELECT
          w.id,
          w.window_config_id,
          w.start_ordinal,
          w.end_ordinal,
          wr.score,
          wr.label
        FROM latest_run lr
        JOIN run_windows rw ON rw.run_id = lr.id
        JOIN windows w ON w.id = rw.window_id
        JOIN window_results wr ON wr.run_window_id = rw.id
        WHERE w.conversation_id = ?
        ORDER BY w.window_config_id, w.start_ordinal
        "#,
    )?;
    let rows = stmt
        .query_map(params![1], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, f64>(4)?,
                row.get::<_, String>(5)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows.len() as i64)
}

fn count_rows(conn: &Connection, table: &str) -> rusqlite::Result<i64> {
    conn.query_row(&format!("SELECT COUNT(*) FROM {}", table), [], |row| row.get(0))
}

fn percentile(values: &[f64], percentile_value: f64) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let index = ((percentile_value / 100.0) * sorted.len() as f64).ceil() as usize - 1;
    sorted[index.min(sorted.len() - 1)]
}

fn summarize(results: &[IterationResult]) {
    let operations = [
        "schema_bootstrap",
        "bulk_insert_raw",
        "assign_ordinals",
        "create_windows",
        "fetch_one_window",
        "fetch_1k_windows",
        "insert_analysis",
        "query_latest_run",
    ];

    for variant in VARIANTS {
        println!("\n{}", variant);
        println!("operation,p50_ms,p95_ms,mean_ms");
        for operation in operations {
            let values: Vec<f64> = results
                .iter()
                .filter(|result| result.variant == variant)
                .filter_map(|result| {
                    result
                        .timings
                        .iter()
                        .find(|(name, _)| *name == operation)
                        .map(|(_, value)| *value)
                })
                .collect();
            let mean = values.iter().sum::<f64>() / values.len() as f64;
            println!(
                "{},{:.2},{:.2},{:.2}",
                operation,
                percentile(&values, 50.0),
                percentile(&values, 95.0),
                mean
            );
        }
    }
}

fn to_json(results: &[IterationResult]) -> String {
    let rustc_version = rustc_version();
    let mut output = String::from("[\n");
    for (index, result) in results.iter().enumerate() {
        if index > 0 {
            output.push_str(",\n");
        }
        output.push_str(&format!(
            "  {{\n    \"runtime\": \"rust-rusqlite\",\n    \"variant\": \"{}\",\n    \"iteration\": {},\n    \"versions\": {{ \"rustc\": \"{}\", \"rusqlite\": \"0.32.1\", \"sqlite\": \"{}\" }},\n    \"timingsMs\": {{",
            result.variant,
            result.iteration,
            rustc_version,
            rusqlite::version()
        ));
        for (timing_index, (name, value)) in result.timings.iter().enumerate() {
            if timing_index > 0 {
                output.push(',');
            }
            output.push_str(&format!("\n      \"{}\": {:.3}", name, value));
        }
        output.push_str("\n    },\n    \"counts\": {");
        for (count_index, (name, value)) in result.counts.iter().enumerate() {
            if count_index > 0 {
                output.push(',');
            }
            output.push_str(&format!("\n      \"{}\": {}", name, value));
        }
        output.push_str("\n    }\n  }");
    }
    output.push_str("\n]\n");
    output
}

fn rustc_version() -> String {
    Command::new("rustc")
        .arg("--version")
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|version| version.trim().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}
