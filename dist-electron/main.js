var Re = Object.defineProperty;
var Ie = (e, t, n) => t in e ? Re(e, t, { enumerable: !0, configurable: !0, writable: !0, value: n }) : e[t] = n;
var Y = (e, t, n) => Ie(e, typeof t != "symbol" ? t + "" : t, n);
import { app as L, BrowserWindow as ae, ipcMain as O } from "electron";
import { fileURLToPath as Le } from "node:url";
import g, { join as Ae } from "node:path";
import oe from "better-sqlite3";
import { execFileSync as we } from "node:child_process";
import { readFileSync as ve } from "node:fs";
import { homedir as Ce } from "node:os";
function ye(e) {
  const t = new oe(e);
  return t.pragma("journal_mode = WAL"), t.pragma("foreign_keys = ON"), t.pragma("busy_timeout = 5000"), Me(t), t;
}
function Me(e) {
  e.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY,
      handle_identifier TEXT NOT NULL,
      normalized_handle TEXT NOT NULL,
      service TEXT NOT NULL DEFAULT 'iMessage',
      display_name TEXT,
      company TEXT,
      avatar_url TEXT,
      source_contact_id TEXT,
      resolved_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      UNIQUE (normalized_handle, service)
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY,
      source_chat_id INTEGER NOT NULL UNIQUE,
      chat_identifier TEXT NOT NULL,
      display_name TEXT,
      is_group INTEGER NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      first_message_at INTEGER,
      last_message_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE TABLE IF NOT EXISTS conversation_participants (
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      PRIMARY KEY (conversation_id, contact_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      conversation_ordinal INTEGER NOT NULL,
      source_rowid INTEGER NOT NULL,
      guid TEXT NOT NULL UNIQUE,
      sender_contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
      text TEXT,
      sent_at INTEGER NOT NULL,
      is_from_me INTEGER NOT NULL,
      is_read INTEGER NOT NULL,
      read_at INTEGER,
      status TEXT NOT NULL,
      error_code INTEGER NOT NULL DEFAULT 0,
      has_attachments INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      UNIQUE (conversation_id, conversation_ordinal),
      UNIQUE (conversation_id, source_rowid)
    );

    CREATE INDEX IF NOT EXISTS messages_conversation_order_idx
      ON messages(conversation_id, conversation_ordinal);
    CREATE INDEX IF NOT EXISTS messages_conversation_time_idx
      ON messages(conversation_id, sent_at, source_rowid, guid);

    CREATE TABLE IF NOT EXISTS import_state (
      source TEXT PRIMARY KEY,
      last_rowid INTEGER NOT NULL DEFAULT 0,
      last_imported_at INTEGER,
      last_error TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
  `), xe(e), e.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS windows (
      id INTEGER PRIMARY KEY,
      run_id INTEGER NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      start_ordinal INTEGER NOT NULL,
      end_ordinal INTEGER NOT NULL,
      context_start_ordinal INTEGER,
      context_end_ordinal INTEGER,
      focal_start_ordinal INTEGER NOT NULL,
      focal_end_ordinal INTEGER NOT NULL,
      start_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      end_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      message_count INTEGER NOT NULL,
      context_message_count INTEGER NOT NULL DEFAULT 0,
      focal_message_count INTEGER NOT NULL,
      window_metadata_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT NOT NULL DEFAULT '{}',
      shift_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      latency_ms INTEGER,
      error TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      CHECK (start_ordinal <= end_ordinal),
      CHECK (focal_start_ordinal <= focal_end_ordinal),
      UNIQUE (run_id, ordinal)
    );

    CREATE INDEX IF NOT EXISTS windows_conversation_order_idx
      ON windows(conversation_id, start_ordinal, end_ordinal);
    CREATE INDEX IF NOT EXISTS windows_run_order_idx
      ON windows(run_id, ordinal);

    CREATE TABLE IF NOT EXISTS analysis_runs (
      id INTEGER PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      method_key TEXT NOT NULL,
      status TEXT NOT NULL,
      window_config_json TEXT NOT NULL,
      context_config_json TEXT NOT NULL,
      scorer_config_json TEXT NOT NULL,
      summary_json TEXT NOT NULL DEFAULT '{}',
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS analysis_runs_conversation_idx
      ON analysis_runs(conversation_id, started_at DESC);
  `);
}
function xe(e) {
  !Ue(e, "windows") || De(e, "windows", "run_id") || e.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS shifts;
    DROP TABLE IF EXISTS window_results;
    DROP TABLE IF EXISTS run_windows;
    DROP TABLE IF EXISTS analysis_runs;
    DROP TABLE IF EXISTS windows;
    DROP TABLE IF EXISTS scorer_configs;
    DROP TABLE IF EXISTS window_configs;
    PRAGMA foreign_keys = ON;
  `);
}
function Ue(e, t) {
  return e.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !== void 0;
}
function De(e, t, n) {
  return e.prepare(`PRAGMA table_info(${t})`).all().some((r) => r.name === n);
}
const z = /* @__PURE__ */ new WeakMap();
function V(e, t, n) {
  let s = z.get(e);
  s || (s = /* @__PURE__ */ new Map(), z.set(e, s));
  let r = s.get(t);
  return r || (r = new Set(
    e.prepare(`PRAGMA table_info(${t})`).all().map((o) => o.name)
  ), s.set(t, r)), r.has(n);
}
function y(e) {
  if (!e) return {};
  try {
    const t = JSON.parse(e);
    if (t && typeof t == "object" && !Array.isArray(t))
      return t;
  } catch {
    return {};
  }
  return {};
}
function Fe(e) {
  return {
    id: e.id,
    conversationId: e.conversation_id ?? 0,
    methodKey: e.method_key ?? "unknown",
    status: ie(e.status),
    startedAt: e.started_at,
    completedAt: e.completed_at,
    summary: y(e.summary_json),
    windowCount: e.window_count
  };
}
function We(e) {
  return {
    id: e.id,
    runId: e.run_id,
    conversationId: e.conversation_id,
    ordinal: e.ordinal,
    startOrdinal: e.start_ordinal,
    endOrdinal: e.end_ordinal,
    contextStartOrdinal: e.context_start_ordinal,
    contextEndOrdinal: e.context_end_ordinal,
    focalStartOrdinal: e.focal_start_ordinal,
    focalEndOrdinal: e.focal_end_ordinal,
    messageCount: e.message_count,
    contextMessageCount: e.context_message_count,
    focalMessageCount: e.focal_message_count,
    metadata: y(e.window_metadata_json),
    result: y(e.result_json),
    shift: y(e.shift_json),
    status: ie(e.status),
    latencyMs: e.latency_ms,
    error: e.error,
    createdAt: e.created_at
  };
}
function ie(e) {
  return e === "complete" ? "completed" : e === "running" || e === "completed" || e === "error" ? e : "pending";
}
function B(e, t) {
  return e.prepare(
    `
      SELECT
        ar.id,
        ar.conversation_id,
        ar.method_key,
        ar.status,
        ar.started_at,
        ar.completed_at,
        ar.summary_json,
        COUNT(w.id) AS window_count
      FROM analysis_runs ar
      LEFT JOIN windows w ON w.run_id = ar.id
      WHERE ar.conversation_id = ?
      GROUP BY ar.id
      ORDER BY ar.started_at DESC, ar.id DESC
    `
  ).all(t).map(Fe);
}
function je(e, t) {
  return e.prepare(
    `
      SELECT
        w.id,
        w.run_id,
        w.conversation_id,
        w.ordinal,
        w.start_ordinal,
        w.end_ordinal,
        w.context_start_ordinal,
        w.context_end_ordinal,
        w.focal_start_ordinal,
        w.focal_end_ordinal,
        w.message_count,
        w.context_message_count,
        w.focal_message_count,
        w.window_metadata_json,
        w.result_json,
        w.shift_json,
        w.status,
        w.latency_ms,
        w.error,
        w.created_at
      FROM windows w
      WHERE w.run_id = ?
      ORDER BY w.ordinal, w.id
    `
  ).all(t).map(We);
}
function de(e, t) {
  const n = B(e, t.id), s = t.participant_summary ?? "";
  return {
    id: t.id,
    sourceChatId: t.source_chat_id,
    chatIdentifier: t.chat_identifier,
    title: t.display_name || s || t.chat_identifier,
    isGroup: t.is_group === 1,
    participantSummary: s,
    participantCount: t.participant_count,
    messageCount: t.message_count,
    firstMessageAt: t.first_message_at,
    lastMessageAt: t.last_message_at,
    latestRun: n[0] ?? null
  };
}
function ce(e, t = "", n = []) {
  return e.prepare(
    `
      SELECT
        c.id,
        c.source_chat_id,
        c.chat_identifier,
        c.display_name,
        c.is_group,
        GROUP_CONCAT(DISTINCT COALESCE(NULLIF(ct.display_name, ''), ct.handle_identifier)) AS participant_summary,
        COUNT(DISTINCT cp.contact_id) AS participant_count,
        COUNT(DISTINCT m.id) AS message_count,
        MIN(m.sent_at) AS first_message_at,
        MAX(m.sent_at) AS last_message_at
      FROM conversations c
      LEFT JOIN conversation_participants cp ON cp.conversation_id = c.id
      LEFT JOIN contacts ct ON ct.id = cp.contact_id
      LEFT JOIN messages m ON m.conversation_id = c.id
      ${t}
      GROUP BY c.id
      ORDER BY last_message_at DESC, c.id DESC
    `
  ).all(...n);
}
function Ge(e) {
  return ce(e).map((t) => de(e, t));
}
function Pe(e, t) {
  const n = ce(e, "WHERE c.id = ?", [t])[0];
  if (!n) return null;
  const s = e.prepare(
    `
      SELECT
        ct.id,
        ct.handle_identifier,
        ct.normalized_handle,
        ct.service,
        ct.display_name
      FROM conversation_participants cp
      JOIN contacts ct ON ct.id = cp.contact_id
      WHERE cp.conversation_id = ?
      ORDER BY COALESCE(NULLIF(ct.display_name, ''), ct.handle_identifier), ct.id
    `
  ).all(t);
  return {
    ...de(e, n),
    participants: s.map((r) => ({
      id: r.id,
      handle: r.handle_identifier,
      handleIdentifier: r.handle_identifier,
      normalizedHandle: r.normalized_handle,
      service: r.service,
      displayName: r.display_name
    })),
    runs: B(e, t)
  };
}
function Be(e) {
  return V(e, "analysis_runs", "conversation_id") && V(e, "windows", "run_id");
}
function $e(e, t) {
  return Be(e) ? e.prepare(
    `
          SELECT
            id,
            conversation_id,
            start_ordinal,
            end_ordinal,
            context_start_ordinal,
            context_end_ordinal,
            focal_start_ordinal,
            focal_end_ordinal
          FROM windows
          WHERE id = ?
        `
  ).get(t) ?? null : e.prepare(
    `
        SELECT
          id,
          conversation_id,
          start_ordinal,
          end_ordinal,
          NULL AS context_start_ordinal,
          NULL AS context_end_ordinal,
          start_ordinal AS focal_start_ordinal,
          end_ordinal AS focal_end_ordinal
        FROM windows
        WHERE id = ?
      `
  ).get(t) ?? null;
}
function He(e, t) {
  return e === "all" || e === "full" ? { start: t.start_ordinal, end: t.end_ordinal } : e === "context" ? t.context_start_ordinal === null || t.context_end_ordinal === null ? null : { start: t.context_start_ordinal, end: t.context_end_ordinal } : { start: t.focal_start_ordinal, end: t.focal_end_ordinal };
}
function Xe(e, t, n = "all") {
  const s = $e(e, t);
  if (!s) throw new Error(`Missing window ${t}`);
  const r = He(n, s);
  return r ? e.prepare(
    `
      SELECT
        m.id,
        m.conversation_id,
        m.conversation_ordinal,
        m.source_rowid,
        m.guid,
        m.sender_contact_id,
        COALESCE(NULLIF(c.display_name, ''), c.handle_identifier) AS sender_name,
        m.text,
        m.sent_at,
        m.is_from_me,
        m.is_read,
        m.has_attachments,
        m.status
      FROM messages m
      LEFT JOIN contacts c ON c.id = m.sender_contact_id
      WHERE
        m.conversation_id = ?
        AND m.conversation_ordinal BETWEEN ? AND ?
      ORDER BY m.conversation_ordinal, m.sent_at, m.source_rowid, m.guid
    `
  ).all(s.conversation_id, r.start, r.end).map((a) => ({
    id: a.id,
    conversationId: a.conversation_id,
    conversationOrdinal: a.conversation_ordinal,
    sourceRowid: a.source_rowid,
    guid: a.guid,
    senderContactId: a.sender_contact_id,
    senderName: a.sender_name,
    text: a.text,
    sentAt: a.sent_at,
    isFromMe: a.is_from_me === 1,
    isRead: a.is_read === 1,
    hasAttachments: a.has_attachments === 1,
    status: a.status,
    slice: n
  })) : [];
}
function be(e, t) {
  const n = F(t.conversationId, "conversationId"), s = F(t.runId, "runId"), r = F(t.windowId, "windowId"), o = t.question.trim();
  if (!o) throw new Error("Question is required");
  const a = Ye(e, n), i = ze(e, s);
  if (i.conversationId !== null && i.conversationId !== n)
    throw new Error(`Run ${s} does not belong to conversation ${n}`);
  const c = Ve(e, s, n);
  if (c.length === 0)
    throw new Error(`Run ${s} has no windows for conversation ${n}`);
  const d = c.findIndex((_) => _.id === r);
  if (d < 0)
    throw new Error(`Window ${r} does not belong to run ${s} and conversation ${n}`);
  const l = c[d], m = l.contextStartOrdinal === null || l.contextEndOrdinal === null ? [] : J(
    e,
    n,
    l.contextStartOrdinal,
    l.contextEndOrdinal,
    "context"
  ), u = J(
    e,
    n,
    l.focalStartOrdinal,
    l.focalEndOrdinal,
    "focal"
  );
  return {
    question: o,
    conversation: a,
    run: i,
    selectedWindow: l,
    contextMessages: m,
    focalMessages: u,
    neighboringWindows: [c[d - 1], c[d + 1]].filter(
      (_) => !!_
    )
  };
}
function F(e, t) {
  if (!Number.isInteger(e) || e <= 0)
    throw new TypeError(`${t} must be a positive integer`);
  return e;
}
function Ye(e, t) {
  const n = e.prepare(
    `
      SELECT id, display_name, chat_identifier, message_count, first_message_at, last_message_at
      FROM conversations
      WHERE id = ?
    `
  ).get(t);
  if (!n) throw new Error(`Conversation ${t} was not found`);
  return {
    id: f(n.id),
    title: A(n.display_name) ?? A(n.chat_identifier) ?? `Conversation ${n.id}`,
    messageCount: f(n.message_count, 0),
    firstMessageAt: E(n.first_message_at),
    lastMessageAt: E(n.last_message_at)
  };
}
function ze(e, t) {
  const n = e.prepare("SELECT * FROM analysis_runs WHERE id = ?").get(t);
  if (!n) throw new Error(`Analysis run ${t} was not found`);
  return {
    id: f(n.id),
    conversationId: E(n.conversation_id),
    methodKey: A(n.method_key) ?? null,
    status: A(n.status) ?? "unknown",
    summary: M(n.summary_json) ?? {},
    startedAt: E(n.started_at),
    completedAt: E(n.completed_at)
  };
}
function Ve(e, t, n) {
  return e.prepare(
    `
      SELECT *
      FROM windows
      WHERE run_id = ? AND conversation_id = ?
      ORDER BY ordinal, id
    `
  ).all(t, n).map((r) => Je(r, t, n));
}
function Je(e, t, n) {
  const s = f(e.start_ordinal), r = f(e.end_ordinal), o = E(e.context_start_ordinal), a = E(e.context_end_ordinal), i = E(e.focal_start_ordinal) ?? s, c = E(e.focal_end_ordinal) ?? r, d = M(e.result_json) ?? {}, l = M(e.shift_json) ?? {};
  return {
    id: f(e.id),
    runId: E(e.run_id) ?? t,
    conversationId: E(e.conversation_id) ?? n,
    ordinal: E(e.ordinal),
    startOrdinal: s,
    endOrdinal: r,
    contextStartOrdinal: o,
    contextEndOrdinal: a,
    focalStartOrdinal: i,
    focalEndOrdinal: c,
    startMessageId: E(e.start_message_id),
    endMessageId: E(e.end_message_id),
    messageCount: f(e.message_count, r - s + 1),
    contextMessageCount: E(e.context_message_count) ?? k(o, a),
    focalMessageCount: E(e.focal_message_count) ?? k(i, c),
    metadata: M(e.window_metadata_json) ?? {},
    result: d,
    shift: l,
    status: A(e.status)
  };
}
function J(e, t, n, s, r) {
  return e.prepare(
    `
      SELECT id, conversation_id, conversation_ordinal, text, sent_at, is_from_me
      FROM messages
      WHERE conversation_id = ?
        AND conversation_ordinal BETWEEN ? AND ?
      ORDER BY conversation_ordinal
    `
  ).all(t, n, s).map((o) => {
    const a = o;
    return {
      id: f(a.id),
      conversationId: f(a.conversation_id),
      ordinal: f(a.conversation_ordinal),
      text: A(a.text) ?? "",
      sentAt: f(a.sent_at),
      isFromMe: f(a.is_from_me, 0) === 1,
      role: r
    };
  });
}
function k(e, t) {
  return e === null || t === null || t < e ? 0 : t - e + 1;
}
function f(e, t) {
  const n = E(e);
  if (n !== null) return n;
  if (t !== void 0) return t;
  throw new Error(`Expected number, received ${String(e)}`);
}
function E(e) {
  return typeof e == "number" && Number.isFinite(e) ? e : typeof e == "bigint" ? Number(e) : null;
}
function A(e) {
  return typeof e == "string" ? e : null;
}
function M(e) {
  if (typeof e != "string" || e.trim() === "") return null;
  try {
    const t = JSON.parse(e);
    return t !== null && typeof t == "object" && !Array.isArray(t) ? t : null;
  } catch {
    return { raw: e };
  }
}
function ke(e, t) {
  return Ke(be(e, t));
}
function Ke(e) {
  const t = e.selectedWindow, n = qe(e), s = Q("Result", t.result), r = Q("Shift", t.shift), o = e.neighboringWindows.map(j).join(", ") || "none available";
  return { answer: [
    `Scoped answer for conversation #${e.conversation.id} (${e.conversation.title}), run #${e.run.id}, window #${t.id}.`,
    `Selected window: ${j(t)} covering ordinals ${t.startOrdinal}-${t.endOrdinal}.`,
    `Context/old messages: ${q(e.contextMessages)} (${e.contextMessages.length} messages).`,
    `Focal/new messages: ${q(e.focalMessages)} (${e.focalMessages.length} messages).`,
    s,
    r,
    `Neighboring windows: ${o}.`,
    `Question answered from the selected run/window packet: ${e.question}`
  ].join(`
`), citations: n };
}
function qe(e) {
  const t = e.selectedWindow, n = [
    ...K(e.contextMessages),
    ...K(e.focalMessages)
  ], s = /* @__PURE__ */ new Map();
  W(s, {
    type: "run",
    id: e.run.id,
    label: `run #${e.run.id}`
  }), W(s, {
    type: "window",
    id: t.id,
    label: j(t)
  });
  for (const r of n)
    W(s, {
      type: "message",
      id: r.id,
      label: `${r.role} message #${r.id} (ordinal ${r.ordinal})`
    });
  return [...s.values()];
}
function W(e, t) {
  e.set(`${t.type}:${t.id}`, t);
}
function K(e) {
  return e.length <= 2 ? e : [e[0], e[e.length - 1]];
}
function q(e) {
  if (e.length === 0) return "none";
  const t = e[0], n = e[e.length - 1];
  return `ordinals ${t.ordinal}-${n.ordinal}, message ids ${t.id}-${n.id}`;
}
function j(e) {
  return `${e.ordinal === null ? "" : `window ${e.ordinal} · `}id ${e.id}`;
}
function Q(e, t) {
  const n = C(t, "summary") ?? C(t, "label"), s = C(t, "dominant"), r = C(t, "method"), o = [
    n,
    s ? `dominant ${s}` : null,
    r ? `method ${r}` : null
  ].filter((a) => a !== null);
  return `${e} metadata: ${o.length > 0 ? o.join("; ") : "none recorded"}.`;
}
function C(e, t) {
  const n = e[t];
  return typeof n == "string" && n.trim() ? n : null;
}
const S = {
  syncMessagesNow: "imessage-emotion:sync-messages-now",
  listConversations: "imessage-emotion:list-conversations",
  getConversation: "imessage-emotion:get-conversation",
  analyzeConversation: "imessage-emotion:analyze-conversation",
  listRuns: "imessage-emotion:list-runs",
  getRunWindows: "imessage-emotion:get-run-windows",
  getWindowMessages: "imessage-emotion:get-window-messages",
  askConversation: "imessage-emotion:ask-conversation"
};
function Qe(e, t, n, s) {
  if ($("lastOrdinal", e, !0), ue(t, n, s), e < s) return [];
  const r = [];
  for (let o = 1; o <= e; o += n) {
    const a = o + t - 1;
    if (a <= e) {
      r.push({ startOrdinal: o, endOrdinal: a });
      continue;
    }
    const i = e - o + 1, c = r[r.length - 1];
    i >= s && (c == null ? void 0 : c.endOrdinal) !== e && r.push({ startOrdinal: o, endOrdinal: e });
    break;
  }
  return r;
}
function Ze(e, t) {
  if (le(t), t.mode === "absolute-message-count")
    return Qe(
      e,
      t.focalMessages,
      t.stride,
      t.minFocalMessages
    ).map((s, r) => ({
      ...s,
      ordinal: r + 1,
      contextStartOrdinal: null,
      contextEndOrdinal: null,
      focalStartOrdinal: s.startOrdinal,
      focalEndOrdinal: s.endOrdinal,
      contextMessageCount: 0,
      focalMessageCount: s.endOrdinal - s.startOrdinal + 1
    }));
  if (e < t.contextMessages + t.minFocalMessages) return [];
  const n = [];
  for (let s = t.contextMessages + 1; s <= e; s += t.stride) {
    const r = s + t.focalMessages - 1, o = Math.min(r, e), a = o - s + 1;
    if (a < t.minFocalMessages) break;
    const i = s - t.contextMessages, c = s - 1;
    if (n.push({
      ordinal: n.length + 1,
      startOrdinal: i,
      endOrdinal: o,
      contextStartOrdinal: i,
      contextEndOrdinal: c,
      focalStartOrdinal: s,
      focalEndOrdinal: o,
      contextMessageCount: t.contextMessages,
      focalMessageCount: a
    }), r >= e) break;
  }
  return n;
}
function et(e, t, n, s) {
  return e.transaction(() => {
    const r = tt(e, n), o = Ze(r, s), a = e.prepare(
      `
      SELECT id
      FROM messages
      WHERE conversation_id = ? AND conversation_ordinal = ?
    `
    ), i = e.prepare(
      `
      INSERT INTO windows (
        run_id,
        conversation_id,
        ordinal,
        start_ordinal,
        end_ordinal,
        context_start_ordinal,
        context_end_ordinal,
        focal_start_ordinal,
        focal_end_ordinal,
        start_message_id,
        end_message_id,
        message_count,
        context_message_count,
        focal_message_count,
        window_metadata_json,
        status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `
    ), c = [];
    for (const d of o) {
      const l = a.get(n, d.startOrdinal), m = a.get(n, d.endOrdinal);
      if (!l || !m)
        throw new Error(
          `Missing boundary message for conversation ${n} window ${d.ordinal}`
        );
      const u = {
        mode: s.mode,
        contextMessages: s.contextMessages,
        focalMessages: s.focalMessages,
        stride: s.stride,
        minFocalMessages: s.minFocalMessages
      }, _ = i.run(
        t,
        n,
        d.ordinal,
        d.startOrdinal,
        d.endOrdinal,
        d.contextStartOrdinal,
        d.contextEndOrdinal,
        d.focalStartOrdinal,
        d.focalEndOrdinal,
        l.id,
        m.id,
        d.endOrdinal - d.startOrdinal + 1,
        d.contextMessageCount,
        d.focalMessageCount,
        JSON.stringify(u)
      );
      c.push(Number(_.lastInsertRowid));
    }
    return c;
  })();
}
function le(e) {
  if (e.mode !== "absolute-message-count" && e.mode !== "comparative-message-count")
    throw new RangeError(`Unsupported window mode: ${e.mode}`);
  if ($("contextMessages", e.contextMessages, e.mode === "absolute-message-count"), ue(e.focalMessages, e.stride, e.minFocalMessages), e.mode === "comparative-message-count" && e.contextMessages <= 0)
    throw new RangeError("contextMessages must be positive for comparative-message-count");
}
function tt(e, t) {
  return e.prepare(
    `
      SELECT MAX(conversation_ordinal) AS last_ordinal
      FROM messages
      WHERE conversation_id = ?
    `
  ).get(t).last_ordinal ?? 0;
}
function ue(e, t, n) {
  if ($("messageCount", e), !Number.isInteger(t) || t <= 0 || t > e)
    throw new RangeError("stride must be a positive integer no larger than messageCount");
  if (!Number.isInteger(n) || n <= 0 || n > e)
    throw new RangeError("minTailMessages must be a positive integer no larger than messageCount");
}
function $(e, t, n = !1) {
  if (!(Number.isInteger(t) && (n ? t >= 0 : t > 0)))
    throw new RangeError(`${e} must be ${n ? "a non-negative" : "a positive"} integer`);
}
const nt = {
  warmth: [
    "appreciate",
    "care",
    "caring",
    "glad",
    "grateful",
    "heart",
    "helpful",
    "hug",
    "kind",
    "love",
    "miss",
    "proud",
    "support",
    "sweet",
    "thanks",
    "thank"
  ],
  joy: [
    "amazing",
    "awesome",
    "celebrate",
    "excited",
    "fun",
    "haha",
    "happy",
    "hilarious",
    "joy",
    "lol",
    "nice",
    "perfect",
    "yay",
    "yes"
  ],
  stress: [
    "anxious",
    "busy",
    "deadline",
    "exhausted",
    "late",
    "overwhelmed",
    "pressure",
    "stressed",
    "stress",
    "swamped",
    "tense",
    "tired",
    "urgent",
    "worried"
  ],
  friction: [
    "angry",
    "annoyed",
    "argue",
    "blame",
    "conflict",
    "fight",
    "frustrated",
    "mad",
    "no",
    "problem",
    "rude",
    "upset",
    "wrong"
  ],
  sadness: [
    "alone",
    "cry",
    "disappointed",
    "grief",
    "hurt",
    "lonely",
    "sad",
    "sorry",
    "tears",
    "unhappy"
  ]
}, I = ["warmth", "joy", "stress", "friction", "sadness"], st = /[a-z']+/g;
function rt(e) {
  var c;
  const t = Object.fromEntries(I.map((d) => [d, 0])), n = /* @__PURE__ */ new Map();
  for (const d of e) {
    const m = (((c = d.text) == null ? void 0 : c.toLowerCase()) ?? "").match(st) ?? [];
    let u = 0;
    for (const _ of I) {
      const w = nt[_];
      for (const v of m)
        w.includes(v) && (t[_] += 1, u += 1);
    }
    u > 0 && n.set(d.id, u);
  }
  const s = I.reduce((d, l) => d + t[l], 0), r = Object.fromEntries(
    I.map((d) => [d, at(t[d], s)])
  ), o = s === 0 ? "neutral" : I.reduce((d, l) => r[l] > r[d] ? l : d), a = [...I].sort((d, l) => r[l] - r[d]), i = s === 0 ? 0 : _e(Math.min(1, r[a[0]] - r[a[1]] + s / 30));
  return {
    scores: r,
    dominant: o,
    confidence: i,
    summary: "Baseline lexical pass; not final model.",
    evidenceMessageIds: [...n.entries()].sort((d, l) => l[1] - d[1] || d[0] - l[0]).slice(0, 5).map(([d]) => d),
    method: "baseline-v1"
  };
}
function at(e, t) {
  return t === 0 ? 0 : _e(e / t);
}
function _e(e) {
  return Math.round(e * 1e3) / 1e3;
}
const Z = ["warmth", "joy", "stress", "friction", "sadness"];
function ot(e, t, n) {
  const s = Object.fromEntries(
    Z.map((a) => [
      a,
      t ? dt(n.scores[a] - t.scores[a]) : 0
    ])
  ), r = Z.reduce(
    (a, i) => Math.abs(s[i]) > Math.abs(s[a]) ? i : a
  ), o = s[r];
  return {
    comparedToWindowId: e,
    deltas: s,
    strongest: t && Math.abs(o) > 0 ? { emotion: r, delta: o } : null,
    severity: it(Math.abs(o))
  };
}
function it(e) {
  return e >= 0.5 ? "high" : e >= 0.25 ? "medium" : e > 0 ? "low" : "none";
}
function dt(e) {
  return Math.round(e * 1e3) / 1e3;
}
const ct = {
  mode: "comparative-message-count",
  contextMessages: 100,
  focalMessages: 50,
  stride: 50,
  minFocalMessages: 25
};
function lt(e, t, n = {}) {
  const { scorerConfig: s = {}, ...r } = n, o = {
    ...ct,
    ...ut(r)
  };
  le(o);
  const a = Date.now(), i = _t(e, t, o, s, a);
  try {
    const c = e.transaction(() => {
      et(e, i, t, o);
      const d = Et(e, i), l = mt(e, t, d), m = pt(l);
      return e.prepare(
        `
        UPDATE analysis_runs
        SET status = 'completed',
          completed_at = ?,
          summary_json = ?
        WHERE id = ?
      `
      ).run(Date.now(), JSON.stringify(m), i), m;
    })();
    return {
      runId: i,
      windowCount: c.windowCount
    };
  } catch (c) {
    throw e.prepare(
      `
      UPDATE analysis_runs
      SET status = 'failed',
        completed_at = ?,
        error = ?
      WHERE id = ?
    `
    ).run(Date.now(), c instanceof Error ? c.message : String(c), i), c;
  }
}
function ut(e) {
  return Object.fromEntries(
    Object.entries(e).filter(([, t]) => t !== void 0)
  );
}
function _t(e, t, n, s, r) {
  const o = e.prepare(
    `
      INSERT INTO analysis_runs (
        conversation_id,
        method_key,
        status,
        window_config_json,
        context_config_json,
        scorer_config_json,
        summary_json,
        started_at
      )
      VALUES (?, 'baseline-v1', 'running', ?, ?, ?, '{}', ?)
    `
  ).run(
    t,
    JSON.stringify(n),
    JSON.stringify({
      mode: n.mode,
      contextMessages: n.contextMessages,
      focalMessages: n.focalMessages
    }),
    JSON.stringify({
      method: "baseline-v1",
      scorer: "local-lexicon-rules",
      ...s
    }),
    r
  );
  return Number(o.lastInsertRowid);
}
function Et(e, t) {
  return e.prepare(
    `
      SELECT id, focal_start_ordinal, focal_end_ordinal
      FROM windows
      WHERE run_id = ?
      ORDER BY ordinal
    `
  ).all(t);
}
function mt(e, t, n) {
  const s = e.prepare(
    `
    UPDATE windows
    SET result_json = ?,
      shift_json = ?,
      status = 'completed',
      latency_ms = ?
    WHERE id = ?
  `
  ), r = [];
  let o = null, a = null;
  for (const i of n) {
    const c = Date.now(), d = ft(
      e,
      t,
      i.focal_start_ordinal,
      i.focal_end_ordinal
    ), l = rt(d), m = ot(o, a, l);
    s.run(
      JSON.stringify(l),
      JSON.stringify(m),
      Date.now() - c,
      i.id
    ), r.push({ windowId: i.id, result: l, shift: m }), o = i.id, a = l;
  }
  return r;
}
function ft(e, t, n, s) {
  return e.prepare(
    `
      SELECT id, text
      FROM messages
      WHERE conversation_id = ?
        AND conversation_ordinal BETWEEN ? AND ?
      ORDER BY conversation_ordinal
    `
  ).all(t, n, s);
}
function pt(e) {
  const t = ["warmth", "joy", "stress", "friction", "sadness"], n = Object.fromEntries(t.map((a) => [a, 0])), s = [...t, "neutral"], r = Object.fromEntries(s.map((a) => [a, 0]));
  for (const { result: a } of e) {
    r[a.dominant] += 1;
    for (const i of t)
      n[i] += a.scores[i];
  }
  const o = Object.fromEntries(
    t.map((a) => [
      a,
      e.length === 0 ? 0 : Math.round(n[a] / e.length * 1e3) / 1e3
    ])
  );
  return {
    method: "baseline-v1",
    windowCount: e.length,
    averageScores: o,
    dominantCounts: r,
    strongestShiftWindowId: Tt(e)
  };
}
function Tt(e) {
  var s;
  let t = null, n = 0;
  for (const { windowId: r, shift: o } of e) {
    const a = Math.abs(((s = o.strongest) == null ? void 0 : s.delta) ?? 0);
    a > n && (t = r, n = a);
  }
  return t;
}
const gt = 10, Nt = 11;
function ht(e) {
  return e.replace(/\D/g, "");
}
function Ee(e) {
  const t = e.trim();
  if (t.length === 0) return "";
  const n = ht(t);
  return n.length === 0 ? "" : n.length === Nt && n.startsWith("1") ? n.slice(1) : t.startsWith("+") ? `+${n}` : n;
}
function Ot(e) {
  const t = Ee(e);
  return t.length === 0 ? null : t.startsWith("+") ? t : t.length === gt ? `+1${t}` : /^\d+$/.test(t) ? `+${t}` : null;
}
const St = /\s*\(filtered\)\s*$/i;
function G(e) {
  return e.replace(St, "");
}
function me(e) {
  const t = G(e).trim();
  return t.includes("@") ? t.toLowerCase() : Ot(t) ?? Ee(t) ?? t;
}
function Rt(e) {
  const t = JSON.parse(ve(e, "utf8"));
  if (Array.isArray(t)) return t;
  if (t && Array.isArray(t.contacts))
    return t.contacts.map((n, s) => {
      var i;
      const r = n.phoneNumbers ?? [], o = n.emails ?? [], a = ((i = n.displayName) == null ? void 0 : i.trim()) || "Unknown";
      return {
        sourceId: n.sourceId ?? `contacts-file:${s}:${a}`,
        displayName: a,
        company: n.company ?? null,
        avatarUrl: n.avatarUrl ?? null,
        phoneNumbers: r,
        emails: o
      };
    });
  throw new Error(`Unsupported contacts file shape: ${e}`);
}
function It() {
  const t = we("osascript", ["-l", "JavaScript", "-e", `
    const app = Application('Contacts');
    const people = app.people();
    const output = [];

    for (let i = 0; i < people.length; i += 1) {
      const person = people[i];
      const phones = [];
      const emails = [];

      const phonesValue = person.phones();
      for (let j = 0; j < phonesValue.length; j += 1) {
        phones.push(String(phonesValue[j].value()));
      }

      const emailsValue = person.emails();
      for (let j = 0; j < emailsValue.length; j += 1) {
        emails.push(String(emailsValue[j].value()));
      }

      output.push({
        sourceId: String(person.id()),
        displayName: [String(person.firstName() || ''), String(person.lastName() || '')].join(' ').trim() || String(person.organization() || 'Unknown'),
        company: String(person.organization() || '') || null,
        avatarUrl: null,
        phoneNumbers: phones,
        emails: emails,
      });
    }

    JSON.stringify(output);
  `], {
    encoding: "utf8",
    timeout: 12e4
  });
  return JSON.parse(t);
}
function Lt(e = process.env.IMESSAGE_CONTACTS_JSON_PATH) {
  return e ? Rt(e) : It();
}
function ee() {
  return Date.now();
}
function At(e) {
  return [
    ...e.phoneNumbers.map((t) => ({ value: t, service: "iMessage" })),
    ...e.emails.map((t) => ({ value: t, service: "iMessage" }))
  ];
}
function wt(e, t) {
  return e.transaction(() => {
    const n = e.prepare(
      `
      INSERT INTO contacts (
        handle_identifier,
        normalized_handle,
        service,
        display_name,
        company,
        avatar_url,
        source_contact_id,
        resolved_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(normalized_handle, service) DO UPDATE SET
        display_name = excluded.display_name,
        company = excluded.company,
        avatar_url = excluded.avatar_url,
        source_contact_id = excluded.source_contact_id,
        resolved_at = excluded.resolved_at,
        updated_at = excluded.updated_at
    `
    );
    let s = 0;
    for (const r of t)
      for (const o of At(r)) {
        const a = o.value.trim();
        a && (n.run(
          a,
          me(a),
          o.service,
          r.displayName,
          r.company,
          r.avatarUrl,
          r.sourceId,
          ee(),
          ee()
        ), s += 1);
      }
    return {
      scannedContacts: t.length,
      resolvedHandles: s
    };
  })();
}
function vt(e) {
  return wt(e, Lt());
}
const Ct = 10 * 60 * 1e3;
function yt(e, t = {}) {
  let n = !1, s = null, r = null;
  const o = t.pollIntervalMs ?? Ct;
  function a(d) {
    var l;
    return (l = t.onStatus) == null || l.call(t, d), d;
  }
  async function i() {
    return s || (s = Promise.resolve().then(() => {
      a({ state: "syncing", scannedContacts: 0, resolvedHandles: 0 });
      const d = vt(e);
      return a({
        state: "idle",
        scannedContacts: d.scannedContacts,
        resolvedHandles: d.resolvedHandles
      });
    }).catch(
      (d) => a({
        state: "error",
        scannedContacts: 0,
        resolvedHandles: 0,
        error: d instanceof Error ? d.message : String(d)
      })
    ).finally(() => {
      s = null;
    }), s);
  }
  function c() {
    n || (r = setTimeout(() => {
      i().finally(c);
    }, o));
  }
  return i().finally(c), {
    syncNow: i,
    stop() {
      n = !0, r && clearTimeout(r), a({ state: "stopped", scannedContacts: 0, resolvedHandles: 0 });
    }
  };
}
const H = "imessage", Mt = 1e12;
function T() {
  return Date.now();
}
function te(e) {
  return e * 1e3;
}
function X(e, t) {
  const n = t.identifier.trim(), s = me(n), r = t.service || "iMessage";
  e.prepare(
    `
    INSERT INTO contacts (handle_identifier, normalized_handle, service, display_name, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(normalized_handle, service) DO UPDATE SET
      handle_identifier = excluded.handle_identifier,
      normalized_handle = excluded.normalized_handle,
      service = excluded.service,
      updated_at = excluded.updated_at
  `
  ).run(n, s, r, n, T());
  const o = e.prepare("SELECT id FROM contacts WHERE normalized_handle = ? AND service = ?").get(s, r);
  if (!o) throw new Error("contact upsert did not produce a row");
  return o.id;
}
function ne(e, t) {
  e.prepare(
    `
    INSERT INTO conversations (source_chat_id, chat_identifier, display_name, is_group, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source_chat_id) DO UPDATE SET
      chat_identifier = excluded.chat_identifier,
      display_name = excluded.display_name,
      is_group = excluded.is_group,
      updated_at = excluded.updated_at
  `
  ).run(t.id, t.identifier, t.displayName, t.isGroup ? 1 : 0, T());
  const n = e.prepare("SELECT id FROM conversations WHERE source_chat_id = ?").get(t.id);
  if (!n) throw new Error("conversation upsert did not produce a row");
  const s = n.id;
  for (const r of t.participants) {
    const o = X(e, r);
    e.prepare(
      `
      INSERT OR IGNORE INTO conversation_participants (conversation_id, contact_id)
      VALUES (?, ?)
    `
    ).run(s, o);
  }
  return s;
}
function xt(e, t) {
  return t ? X(e, t) : null;
}
function Ut(e, t, n) {
  const s = xt(e, t.sender);
  return e.prepare(
    `
      INSERT INTO messages (
        conversation_id,
        conversation_ordinal,
        source_rowid,
        guid,
        sender_contact_id,
        text,
        sent_at,
        is_from_me,
        is_read,
        read_at,
        status,
        error_code,
        has_attachments,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guid) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        source_rowid = excluded.source_rowid,
        sender_contact_id = excluded.sender_contact_id,
        text = excluded.text,
        sent_at = excluded.sent_at,
        is_from_me = excluded.is_from_me,
        is_read = excluded.is_read,
        read_at = excluded.read_at,
        status = excluded.status,
        error_code = excluded.error_code,
        has_attachments = excluded.has_attachments,
        updated_at = excluded.updated_at
    `
  ).run(
    n,
    -Math.abs(t.id),
    t.id,
    t.guid,
    s,
    t.text,
    te(t.timestamp),
    t.isFromMe ? 1 : 0,
    t.isRead ? 1 : 0,
    t.readAt != null ? te(t.readAt) : null,
    t.status,
    t.errorCode,
    t.hasAttachments ? 1 : 0,
    T()
  ).changes > 0;
}
function Dt(e, t) {
  const n = e.prepare(
    `
      SELECT id
      FROM messages
      WHERE conversation_id = ?
      ORDER BY sent_at ASC, source_rowid ASC, guid ASC
    `
  ).all(t);
  e.prepare(
    `
    UPDATE messages
    SET conversation_ordinal = -(id + ?), updated_at = ?
    WHERE conversation_id = ?
  `
  ).run(Mt, T(), t);
  const r = e.prepare(
    `
    UPDATE messages
    SET conversation_ordinal = ?, updated_at = ?
    WHERE id = ?
  `
  );
  for (const [a, i] of n.entries())
    r.run(a + 1, T(), i.id);
  const o = e.prepare(
    `
      SELECT COUNT(*) AS message_count, MIN(sent_at) AS first_message_at, MAX(sent_at) AS last_message_at
      FROM messages
      WHERE conversation_id = ?
    `
  ).get(t);
  e.prepare(
    `
    UPDATE conversations
    SET message_count = ?, first_message_at = ?, last_message_at = ?, updated_at = ?
    WHERE id = ?
  `
  ).run(
    o.message_count,
    o.first_message_at,
    o.last_message_at,
    T(),
    t
  );
}
function Ft(e, t) {
  return e.transaction(() => {
    const n = /* @__PURE__ */ new Map();
    for (const o of t.chats)
      n.set(o.id, ne(e, o));
    for (const o of t.handles)
      X(e, o);
    let s = 0;
    const r = /* @__PURE__ */ new Set();
    for (const o of t.messages) {
      const a = n.get(o.chatId) ?? ne(e, {
        id: o.chatId,
        identifier: String(o.chatId),
        displayName: null,
        isGroup: !1,
        participants: []
      });
      Ut(e, o, a) && (s += 1), r.add(a);
    }
    for (const o of r)
      Dt(e, o);
    return e.prepare(
      `
      INSERT INTO import_state (source, last_rowid, last_imported_at, last_error, updated_at)
      VALUES (?, ?, ?, NULL, ?)
      ON CONFLICT(source) DO UPDATE SET
        last_rowid = excluded.last_rowid,
        last_imported_at = excluded.last_imported_at,
        last_error = NULL,
        updated_at = excluded.updated_at
    `
    ).run(H, t.cursor, T(), T()), {
      fetchedCount: t.fetchedCount,
      importedMessages: s,
      cursor: t.cursor,
      affectedConversationIds: [...r]
    };
  })();
}
function x(e) {
  const t = e.prepare("SELECT last_rowid FROM import_state WHERE source = ?").get(H);
  return (t == null ? void 0 : t.last_rowid) ?? 0;
}
function Wt(e, t) {
  const n = t instanceof Error ? t.message : String(t);
  e.prepare(
    `
    INSERT INTO import_state (source, last_rowid, last_error, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(source) DO UPDATE SET
      last_error = excluded.last_error,
      updated_at = excluded.updated_at
  `
  ).run(H, x(e), n, T());
}
function fe(e, t = 0) {
  if (t >= e.length) return null;
  const n = e[t];
  if (n < 128) return [1, n];
  const r = {
    129: 2,
    130: 4,
    131: 8
  }[n];
  if (!r || t + 1 + r > e.length) return null;
  let o = 0n;
  for (let a = 0; a < r; a += 1)
    o |= BigInt(e[t + 1 + a]) << BigInt(a * 8);
  return o > BigInt(Number.MAX_SAFE_INTEGER) ? null : [1 + r, Number(o)];
}
const se = Buffer.from("NSString"), jt = 43, Gt = Buffer.from([134, 132]), Pt = new TextDecoder("utf-8", { fatal: !0 });
function pe(e) {
  try {
    return Pt.decode(e);
  } catch {
    return null;
  }
}
function Te(e) {
  const t = e.replace(/\ufffc/g, "").trim();
  return t ? t.startsWith("NS") || t.startsWith("_NS") || t.startsWith("NSMutable") ? null : t : e.includes("￼") ? "[attachment]" : null;
}
function Bt(e, t) {
  const n = fe(e, t);
  if (!n) return null;
  const [s, r] = n, o = t + s, a = o + r;
  if (r <= 0 || a > e.length) return null;
  const i = pe(e.subarray(o, a));
  return i ? Te(i) : null;
}
function $t(e, t) {
  const n = e.indexOf(Gt, t);
  if (n === -1 || n <= t) return null;
  let s = e.subarray(t, n);
  const r = fe(s);
  if (r) {
    const [a, i] = r;
    a + i === s.length && (s = s.subarray(a));
  }
  const o = pe(s);
  return o ? Te(o) : null;
}
function Ht(e, t) {
  return $t(e, t) ?? Bt(e, t);
}
function Xt(e) {
  if (!e || e.length === 0) return null;
  let t = 0;
  for (; t < e.length; ) {
    const n = e.indexOf(se, t);
    if (n === -1) return null;
    const s = n + se.length;
    for (let r = s; r < e.length - 1; r += 1) {
      if (e[r] !== jt) continue;
      const o = Ht(e, r + 1);
      if (o) return o;
    }
    t = s;
  }
  return null;
}
const ge = Ae(Ce(), "Library", "Messages", "chat.db"), re = 978307200;
function bt(e, t, n, s, r) {
  return r !== 0 ? "failed" : e ? s ? "read" : n ? "delivered" : t ? "sent" : "sending" : s ? "read" : "delivered";
}
function Yt(e) {
  return e >= 2e3 && e <= 3007;
}
function zt(e, t) {
  if (e && e.trim() !== "") return e;
  const n = Xt(t);
  return n && n.trim() !== "" ? n : e;
}
class Vt {
  constructor(t = ge) {
    Y(this, "db");
    this.db = new oe(t, { readonly: !0, fileMustExist: !0 });
  }
  close() {
    this.db.close();
  }
  buildBatch(t, n = 500) {
    var c;
    const s = this.db.prepare(
      `
        SELECT
          m.ROWID AS rowid,
          m.guid,
          cmj.chat_id,
          CASE WHEN m.is_from_me = 0 THEN m.handle_id ELSE NULL END AS sender_id,
          h.id AS sender_identifier,
          h.service AS sender_service,
          m.text,
          m.attributedBody,
          CAST(m.date / 1000000000 AS INTEGER) + ${re} AS unix_date,
          m.is_from_me,
          m.is_sent,
          m.is_delivered,
          m.is_read,
          CASE
            WHEN m.date_read IS NULL OR m.date_read = 0 THEN NULL
            ELSE CAST(m.date_read / 1000000000 AS INTEGER) + ${re}
          END AS unix_date_read,
          m.error,
          m.cache_has_attachments,
          m.associated_message_type
        FROM message m
        INNER JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        LEFT JOIN handle h ON h.ROWID = m.handle_id
        WHERE m.ROWID > ? AND m.item_type IN (0, 1, 2)
        ORDER BY m.ROWID
        LIMIT ?
      `
    ).all(t, n);
    if (s.length === 0)
      return { cursor: t, fetchedCount: 0, chats: [], messages: [], handles: [] };
    const r = this.transformMessages(s), o = [...new Set(r.map((d) => d.chatId))], a = this.getChats(o), i = /* @__PURE__ */ new Map();
    for (const d of a)
      for (const l of d.participants) i.set(l.id, l);
    for (const d of r)
      d.sender && i.set(d.sender.id, d.sender);
    return {
      cursor: ((c = s[s.length - 1]) == null ? void 0 : c.rowid) ?? t,
      fetchedCount: s.length,
      chats: a,
      messages: r,
      handles: [...i.values()]
    };
  }
  transformMessages(t) {
    return t.filter((n) => !Yt(n.associated_message_type)).map((n) => {
      const s = n.is_from_me === 1, r = n.is_read === 1, o = n.sender_id !== null ? {
        id: n.sender_id,
        identifier: G(n.sender_identifier ?? ""),
        service: n.sender_service ?? "iMessage"
      } : null;
      return {
        id: n.rowid,
        guid: n.guid,
        chatId: n.chat_id,
        text: zt(n.text, n.attributedBody),
        timestamp: n.unix_date ?? 0,
        isFromMe: s,
        isRead: r,
        readAt: n.unix_date_read,
        status: bt(
          s,
          n.is_sent === 1,
          n.is_delivered === 1,
          r,
          n.error
        ),
        errorCode: n.error,
        hasAttachments: n.cache_has_attachments === 1,
        sender: o
      };
    });
  }
  getChats(t) {
    if (t.length === 0) return [];
    const n = JSON.stringify(t), s = this.db.prepare(
      `
        WITH requested_chats AS (
          SELECT CAST(value AS INTEGER) AS chat_id
          FROM json_each(?)
        ),
        participant_counts AS (
          SELECT chj.chat_id, COUNT(*) AS cnt
          FROM chat_handle_join chj
          WHERE chj.chat_id IN (SELECT chat_id FROM requested_chats)
          GROUP BY chj.chat_id
        )
        SELECT
          c.ROWID AS id,
          c.chat_identifier AS identifier,
          c.display_name AS name,
          COALESCE(pc.cnt, 0) > 1 AS is_group
        FROM chat c
        LEFT JOIN participant_counts pc ON pc.chat_id = c.ROWID
        WHERE c.ROWID IN (SELECT chat_id FROM requested_chats)
      `
    ).all(n), r = this.db.prepare(
      `
        SELECT
          chj.chat_id AS chat_id,
          h.ROWID AS id,
          h.id AS identifier,
          h.service AS service
        FROM chat_handle_join chj
        INNER JOIN handle h ON h.ROWID = chj.handle_id
        WHERE chj.chat_id IN (
          SELECT CAST(value AS INTEGER)
          FROM json_each(?)
        )
      `
    ).all(n), o = /* @__PURE__ */ new Map();
    for (const i of r) {
      const c = o.get(i.chat_id) ?? [];
      c.push({
        id: i.id,
        identifier: G(i.identifier),
        service: i.service
      }), o.set(i.chat_id, c);
    }
    const a = /* @__PURE__ */ new Map();
    for (const i of s)
      a.set(i.id, {
        id: i.id,
        identifier: i.identifier,
        displayName: i.name ?? null,
        isGroup: i.is_group === 1,
        participants: o.get(i.id) ?? []
      });
    return t.map((i) => a.get(i) ?? null).filter((i) => !!i);
  }
}
const Jt = 1e3, kt = 3e4;
function Kt(e, t = {}) {
  let n = !1, s = null, r = null, o = !1;
  const a = t.batchSize ?? Jt, i = t.pollIntervalMs ?? kt, c = t.chatDbPath ?? process.env.IMESSAGE_CHAT_DB_PATH ?? ge;
  function d(u) {
    var _;
    return (_ = t.onStatus) == null || _.call(t, u), u;
  }
  async function l() {
    return s || (s = Promise.resolve().then(() => {
      let u = x(e), _ = 0;
      d({ state: "syncing", cursor: u, importedMessages: _ });
      const w = new Vt(c);
      try {
        const v = w.buildBatch(u, a), b = Ft(e, v);
        u = b.cursor, _ = b.importedMessages, o = v.fetchedCount >= a;
      } finally {
        w.close();
      }
      return d({ state: "idle", cursor: u, importedMessages: _, hasMore: o });
    }).catch((u) => {
      Wt(e, u);
      const _ = u instanceof Error ? u.message : String(u);
      return d({
        state: "error",
        cursor: x(e),
        importedMessages: 0,
        error: _
      });
    }).finally(() => {
      s = null;
    }), s);
  }
  function m() {
    n || (r = setTimeout(() => {
      l().finally(m);
    }, o ? 0 : i));
  }
  return l().finally(m), {
    syncNow: l,
    stop() {
      n = !0, r && clearTimeout(r), d({
        state: "stopped",
        cursor: x(e),
        importedMessages: 0
      });
    }
  };
}
const Ne = g.dirname(Le(import.meta.url));
process.env.APP_ROOT = g.join(Ne, "..");
const P = process.env.VITE_DEV_SERVER_URL, he = g.join(process.env.APP_ROOT, "dist");
process.env.VITE_PUBLIC = P ? g.join(process.env.APP_ROOT, "public") : he;
let p, N = null, R = null, U = null, D = {
  state: "idle",
  cursor: 0,
  importedMessages: 0
}, Oe = {
  state: "idle",
  scannedContacts: 0,
  resolvedHandles: 0
};
const qt = 3e4, Qt = 10 * 60 * 1e3;
function Zt() {
  return {
    messages: D,
    contacts: Oe
  };
}
function en(e, t = {}) {
  if (t.methodKey && t.methodKey !== "baseline-v1")
    throw new Error(`Unsupported baseline method: ${t.methodKey}`);
  const n = {
    mode: t.mode,
    contextMessages: t.contextMessages,
    focalMessages: t.focalMessages ?? t.windowSize,
    stride: t.stride,
    minFocalMessages: t.minFocalMessages,
    scorerConfig: t.scorerConfig
  }, s = lt(h(), e, n), r = h().prepare(
    `
      SELECT
        id,
        conversation_id,
        method_key,
        status,
        started_at,
        completed_at,
        summary_json,
        error
      FROM analysis_runs
      WHERE id = ?
    `
  ).get(s.runId);
  if (!r) throw new Error(`Missing baseline run ${s.runId}`);
  return {
    id: r.id,
    conversationId: r.conversation_id,
    methodKey: r.method_key,
    status: r.status,
    windowCount: s.windowCount,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    summary: JSON.parse(r.summary_json),
    error: r.error ?? void 0
  };
}
function tn() {
  const e = g.join(L.getPath("userData"), "imessage-emotion.sqlite");
  N = ye(e), R = Kt(N, {
    pollIntervalMs: qt,
    onStatus(t) {
      D = t, p == null || p.webContents.send("imessage-sync-status", t);
    }
  }), U = yt(N, {
    pollIntervalMs: Qt,
    onStatus(t) {
      Oe = t, p == null || p.webContents.send("contacts-sync-status", t);
    }
  });
}
function h() {
  if (!N) throw new Error("Database is not ready");
  return N;
}
function Se() {
  p = new ae({
    icon: g.join(process.env.VITE_PUBLIC, "electron-vite.svg"),
    webPreferences: {
      preload: g.join(Ne, "preload.mjs")
    }
  }), P ? p.loadURL(P) : p.loadFile(g.join(he, "index.html"));
}
L.on("window-all-closed", () => {
  process.platform !== "darwin" && (L.quit(), p = null);
});
L.on("activate", () => {
  ae.getAllWindows().length === 0 && Se();
});
O.handle(S.syncMessagesNow, async () => (D = await ((R == null ? void 0 : R.syncNow()) ?? Promise.resolve(D)), Zt()));
O.handle(S.listConversations, () => Ge(h()));
O.handle(
  S.getConversation,
  (e, t) => Pe(h(), t)
);
O.handle(
  S.analyzeConversation,
  (e, t, n) => en(t, n)
);
O.handle(
  S.listRuns,
  (e, t) => B(h(), t)
);
O.handle(
  S.getRunWindows,
  (e, t) => je(h(), t)
);
O.handle(
  S.getWindowMessages,
  (e, t, n = "all") => Xe(h(), t, n)
);
O.handle(
  S.askConversation,
  (e, t) => ke(h(), {
    conversationId: t.conversationId,
    runId: t.runId,
    windowId: t.windowId,
    question: t.question
  })
);
L.whenReady().then(() => {
  tn(), Se();
});
L.on("before-quit", () => {
  R == null || R.stop(), U == null || U.stop(), N == null || N.close();
});
