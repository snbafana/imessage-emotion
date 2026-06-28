import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { ai, ax } from "@ax-llm/ax";
import { pipeline } from "@huggingface/transformers";
import { getWindowMessages } from "../../src/lib/api/messages.ts";
import { getRunWindows, listRuns } from "../../src/lib/api/runs.ts";
import type { WindowMessage } from "../../src/lib/api/types.ts";
import { openAppDatabase, getPrivacySafeCounts, type AppDatabase } from "../../src/lib/db/schema.ts";
import { resolveDbPath } from "../../src/lib/db/connection.ts";
import { EKMAN_ANCHORS, type Anchor } from "../../src/lib/emotion/anchors.ts";
import { planRunWindowRanges } from "../../src/lib/windows/windows.ts";

const ANCHORS = EKMAN_ANCHORS;
type Scores = Record<Anchor, number>;

type Message = {
  id: string;
  content: string;
  isFromMe: boolean;
  sentAt?: string;
  messageId?: number;
  ordinal?: number;
};

type Conversation = {
  id: string;
  kind: "synthetic" | "private" | "native";
  expected?: Anchor[];
  sourceConversationId?: string;
  fullMessageCount?: number;
  messages: Message[];
  nativeWindows?: Window[];
  nativeRunId?: number;
};

type Window = {
  index: number;
  start: number;
  end: number;
  messages: Message[];
  sourceWindowId?: number;
  sourceRunId?: number;
  ordinal?: number;
};

type SelectionConfig = {
  strategy?: "top_shift";
  maxWindowsPerConversation?: number;
  candidateScorer?: string;
};

type LlmConfig = {
  name: string;
  provider: "openai" | "openrouter";
  model: string;
  runMode?: "selected_windows" | "all_windows" | "whole_conversation";
  window?: { size: number; stride: number };
  contextMode?: "window_only" | "prior_summary" | "prior_messages" | "full_conversation";
  contextMessages?: number;
  maxContextChars?: number;
  maxConversations?: number;
  maxWindowsPerConversation?: number;
  selection?: SelectionConfig;
  concurrency?: number;
  maxWindows?: number;
  maxTokens?: number;
  inputUsdPerMillionTokens?: number;
  outputUsdPerMillionTokens?: number;
  enabled?: boolean;
};

type Config = {
  runName?: string;
  dataset?: {
    kind?: "synthetic" | "private" | "mixed" | "native" | "app";
    appDbPath?: string;
    privateConversationLimit?: number;
    nativeConversationLimit?: number;
    nativeConversationOrder?: "recent" | "longest";
    minMessagesPerConversation?: number;
    maxMessagesPerConversation?: number;
    privateConversationOrder?: "recent" | "longest";
    includeWindowTextInOutput?: boolean;
    preferExistingWindows?: boolean;
    nativeRunId?: number;
  };
  windowing?: Array<{ size: number; stride: number }>;
  selection?: SelectionConfig;
  deterministic?: string[];
  llm?: LlmConfig[];
};

type WindowScore = {
  index: number;
  scores: Scores;
  dominant: Anchor;
  shiftMagnitude?: number;
  zMax?: number;
  deltas?: Scores;
};

type LlmRow =
  | {
      ok: true;
      windowRef: string;
      sourceWindowId?: number;
      sourceRunId?: number;
      latencyMs: number;
      stateLabel: string | null;
      confidence: number;
      dominant: Anchor;
      scores: Scores;
      evidence: SelectedWindow["messageRefs"];
      evidenceRefCount: number;
      reasoningSummary: string | null;
      uncertainty: ParsedLlmScore["uncertainty"];
      priorComparison: ParsedLlmScore["priorComparison"];
      inputTokens: number;
      outputTokens: number;
      estimatedCostUsd: number | null;
      completionMs: number;
    }
  | {
      ok: true;
      dryRun: true;
      windowRef: string;
      sourceWindowId?: number;
      sourceRunId?: number;
      messageCount: number;
      inputChars: number;
      inputTokens: number;
      estimatedCostUsd: null;
      completionMs: number;
    }
  | {
      ok: false;
      error: string;
      completionMs: number;
    };

type SelectedWindow = {
  conversationId: string;
  kind: Conversation["kind"];
  windowRef: string;
  runMode: "selected_windows" | "all_windows" | "whole_conversation";
  contextMode: "window_only" | "prior_summary" | "prior_messages" | "full_conversation";
  text: string;
  baseline: Scores;
  sourceWindowId?: number;
  sourceRunId?: number;
  messageRefs: Array<{ ref: string; messageId?: number; ordinal?: number }>;
  inputChars: number;
};

type LoadedDataset = {
  conversations: Conversation[];
  source: {
    kind: "synthetic" | "private" | "mixed" | "native";
    nativeDb?: {
      pathSource: "default" | "override";
      counts: ReturnType<typeof getPrivacySafeCounts>;
      selectedConversationCount: number;
      existingRunCount: number;
      existingWindowCount: number;
    };
  };
};

const OUT_DIR = new URL("./out/", import.meta.url);
const ROBERTA_EMOTION_MODEL = "nicky48/emotion-english-distilroberta-base-ONNX";

const SYNTHETIC_ARCS: Array<{ id: string; expected: Anchor[]; messages: string[] }> = [
  {
    id: "synthetic_warm_tense_distant",
    expected: ["joy", "anger", "sadness"],
    messages: [
      "Loved catching up today, I missed your jokes.",
      "That made my week, seriously.",
      "Let's do dinner Friday, I can cook.",
      "I feel like you keep dodging the actual issue.",
      "I'm not mad, but I am frustrated that this keeps happening.",
      "Can you please just tell me directly if plans changed?",
      "ok",
      "I don't really have energy to talk tonight.",
      "Let's leave it for later.",
      "Sure.",
    ],
  },
  {
    id: "synthetic_logistical_affectionate",
    expected: ["neutral", "joy"],
    messages: [
      "Train is delayed 12 minutes.",
      "Can you grab the keys from the desk?",
      "I'll be there at 6:40.",
      "Actually I was thinking about you on the ride over.",
      "Thank you for always making these days easier.",
      "I love how calm I feel when I get to see you.",
      "Come here when you arrive.",
      "Miss you.",
    ],
  },
  {
    id: "synthetic_conflict_repair",
    expected: ["anger", "joy"],
    messages: [
      "That hurt more than I expected.",
      "I felt dismissed when you laughed it off.",
      "I'm sorry. I was defensive and didn't listen well.",
      "Thank you for saying that.",
      "Can we reset and talk through what actually happened?",
      "Yes. I care about us and I want to repair this.",
      "I appreciate you staying in it with me.",
      "Same. We're okay.",
    ],
  },
];

const FEATURE_LEXICON: Record<Anchor, string[]> = {
  anger: [
    "mad",
    "angry",
    "frustrated",
    "annoyed",
    "hurt",
    "issue",
    "dodging",
    "dismissed",
    "defensive",
    "upset",
  ],
  disgust: [
    "gross",
    "disgusting",
    "ugh",
    "ew",
    "nasty",
    "sick of",
    "hate",
  ],
  fear: [
    "worried",
    "anxious",
    "stress",
    "stressed",
    "overwhelmed",
    "panic",
    "scared",
    "nervous",
    "please",
  ],
  joy: [
    "love",
    "loved",
    "miss",
    "missed",
    "care",
    "appreciate",
    "thank",
    "thanks",
    "proud",
    "sweet",
    "kind",
    "hug",
    "lol",
    "haha",
    "fun",
    "funny",
    "excited",
    "yay",
    "great",
    "amazing",
    "joke",
    "jokes",
    "hehe",
  ],
  neutral: [
    "train",
    "delayed",
    "keys",
    "desk",
    "arrive",
    "when",
    "where",
    "time",
    "minutes",
    "tomorrow",
    "today",
    "schedule",
  ],
  sadness: [
    "sad",
    "sorry",
    "tired",
    "distant",
    "later",
    "leave it",
    "energy",
    "alone",
    "can't talk",
    "dont want",
    "don't want",
  ],
  surprise: [
    "wow",
    "whoa",
    "omg",
    "surprised",
    "unexpected",
    "wait",
    "really?",
    "no way",
  ],
};

function parseArgs() {
  const args = process.argv.slice(2);
  const valueAfter = (flag: string, fallback: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
  };
  return {
    config: valueAfter("--config", "harness.ax.json"),
    out: valueAfter("--out", "out/harness-ax-results.json"),
    noProvider: args.includes("--no-provider") || args.includes("--dry-run"),
    allowPrivateOutput: args.includes("--allow-private-output"),
  };
}

function loadEnv() {
  for (const path of [resolve("../../.env"), resolve(".env")]) {
    try {
      const text = readFileSync(path, "utf8");
      for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
        if (!match || process.env[match[1]]) continue;
        process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
      }
    } catch {
      // Optional local secret file.
    }
  }
}

function providerEnvVars() {
  return Object.keys(process.env)
    .filter((name) => /^(OPENAI|OPENROUTER|ANTHROPIC|GOOGLE|GEMINI|GROQ|MISTRAL|TOGETHER|AX)/.test(name))
    .sort();
}

function loadConfig(path: string): Config {
  return JSON.parse(readFileSync(path, "utf8")) as Config;
}

function syntheticConversations(): Conversation[] {
  return SYNTHETIC_ARCS.map((arc) => ({
    id: arc.id,
    kind: "synthetic",
    expected: arc.expected,
    messages: arc.messages.map((content, index) => ({
      id: `${arc.id}_m${String(index).padStart(4, "0")}`,
      content,
      isFromMe: index % 2 === 0,
    })),
  }));
}

function privateConversations(limit: number, maxMessages: number, order: "recent" | "longest"): Conversation[] {
  const orderBy = order === "longest" ? "messages desc, last_at desc" : "last_at desc";
  const conversations = cuedSql(`
    select c.id, count(m.id) as messages,
           sum(case when m.is_from_me then 1 else 0 end) as from_me,
           sum(case when not m.is_from_me then 1 else 0 end) as from_other,
           max(m.sent_at) as last_at
    from conversations c
    join messages m on m.conversation_id = c.id
    where c.platform = 'imessage'
      and c.type = 'dm'
      and m.content is not null
      and length(trim(m.content)) > 0
    group by c.id
    having messages >= 120 and from_me >= 30 and from_other >= 30
    order by ${orderBy}
    limit ${Number(limit) || 2}
  `);

  return conversations.map((row, index) => {
    const sourceConversationId = String(row.id);
    const messageLimit = Number(maxMessages) > 0 ? `limit ${Number(maxMessages)}` : "";
    const messages = cuedSql(`
      select id, is_from_me as isFromMe, sent_at as sentAt, content
      from messages
      where conversation_id = '${sourceConversationId.replaceAll("'", "''")}'
        and content is not null
        and length(trim(content)) > 0
      order by sent_at asc
      ${messageLimit}
    `).map((message) => ({
      id: String(message.id),
      isFromMe: Boolean(message.isFromMe),
      sentAt: String(message.sentAt ?? ""),
      content: String(message.content).slice(0, 500),
    }));

    return {
      id: `private_c${String(index + 1).padStart(2, "0")}`,
      kind: "private" as const,
      sourceConversationId,
      fullMessageCount: Number(row.messages ?? messages.length),
      messages,
    };
  });
}

type NativeConversationRow = {
  id: number;
  message_count: number;
  last_message_at: number | null;
};

function nativeMessage(message: WindowMessage): Message {
  return {
    id: `message:${message.id}`,
    messageId: message.id,
    ordinal: message.conversationOrdinal,
    isFromMe: message.isFromMe,
    sentAt: String(message.sentAt),
    content: String(message.text ?? "").slice(0, 500),
  };
}

function selectNativeMessages(
  db: AppDatabase,
  conversationId: number,
  maxMessages: number,
): Message[] {
  const limitSql = Number(maxMessages) > 0 ? "LIMIT ?" : "";
  const params = Number(maxMessages) > 0 ? [conversationId, maxMessages] : [conversationId];
  const rows = db
    .prepare(
      `
      SELECT id, conversation_ordinal, text, sent_at, is_from_me
      FROM messages
      WHERE conversation_id = ?
        AND text IS NOT NULL
        AND length(trim(text)) > 0
      ORDER BY conversation_ordinal
      ${limitSql}
    `,
    )
    .all(...params) as Array<{
    id: number;
    conversation_ordinal: number;
    text: string;
    sent_at: number;
    is_from_me: number;
  }>;

  return rows.map((row) => ({
    id: `message:${row.id}`,
    messageId: row.id,
    ordinal: row.conversation_ordinal,
    isFromMe: row.is_from_me === 1,
    sentAt: String(row.sent_at),
    content: row.text.slice(0, 500),
  }));
}

function selectNativeConversations(
  db: AppDatabase,
  limit: number,
  minMessages: number,
  order: "recent" | "longest",
): NativeConversationRow[] {
  const orderBy = order === "longest" ? "message_count DESC, last_message_at DESC" : "last_message_at DESC";
  return db
    .prepare(
      `
      SELECT id, message_count, last_message_at
      FROM conversations
      WHERE message_count >= ?
      ORDER BY ${orderBy}, id DESC
      LIMIT ?
    `,
    )
    .all(minMessages, limit) as NativeConversationRow[];
}

function latestNativeRun(db: AppDatabase, conversationId: number, requestedRunId?: number) {
  const runs = listRuns(db, conversationId);
  if (requestedRunId !== undefined) return runs.find((run) => run.id === requestedRunId) ?? null;
  return runs.find((run) => run.windowCount > 0) ?? null;
}

function nativeWindowsForRun(db: AppDatabase, conversationId: number, runId: number): Window[] {
  const windows = getRunWindows(db, runId).filter((window) => window.conversationId === conversationId);
  return windows.map((window) => {
    const messages = getWindowMessages(db, window.id, "focal").map(nativeMessage);
    return {
      index: Math.max(0, window.ordinal - 1),
      start: window.focalStartOrdinal - 1,
      end: window.focalEndOrdinal - 1,
      messages,
      sourceWindowId: window.id,
      sourceRunId: runId,
      ordinal: window.ordinal,
    };
  }).filter((window) => window.messages.length > 0);
}

function nativeConversations(config: NonNullable<Config["dataset"]>): LoadedDataset {
  const dbPath = config.appDbPath ?? resolveDbPath();
  const db = openAppDatabase(dbPath);
  try {
    const counts = getPrivacySafeCounts(db);
    const limit = config.nativeConversationLimit ?? config.privateConversationLimit ?? 2;
    const maxMessages = config.maxMessagesPerConversation ?? 600;
    const minMessages = config.minMessagesPerConversation ?? 24;
    const order = config.nativeConversationOrder ?? config.privateConversationOrder ?? "recent";
    const preferExistingWindows = config.preferExistingWindows !== false;
    const rows = selectNativeConversations(db, limit, minMessages, order);
    let existingRunCount = 0;
    let existingWindowCount = 0;

    const conversations = rows.map((row, index): Conversation => {
      const run = preferExistingWindows ? latestNativeRun(db, row.id, config.nativeRunId) : null;
      const nativeWindows = run ? nativeWindowsForRun(db, row.id, run.id) : [];
      if (nativeWindows.length > 0) {
        existingRunCount += 1;
        existingWindowCount += nativeWindows.length;
      }

      return {
        id: `native_c${String(index + 1).padStart(2, "0")}`,
        kind: "native",
        sourceConversationId: String(row.id),
        fullMessageCount: row.message_count,
        messages: selectNativeMessages(db, row.id, maxMessages),
        nativeWindows,
        nativeRunId: run?.id,
      };
    });

    return {
      conversations,
      source: {
        kind: "native",
        nativeDb: {
          pathSource: config.appDbPath ? "override" : "default",
          counts,
          selectedConversationCount: conversations.length,
          existingRunCount,
          existingWindowCount,
        },
      },
    };
  } finally {
    db.close();
  }
}

function cuedSql(sql: string): Array<Record<string, unknown>> {
  const raw = execFileSync("cued", ["sql", sql], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(raw.replace(/^\(node:[^\n]+\)\s+ExperimentalWarning:[\s\S]*?\n(?=[[{])/, ""));
}

function loadDataset(config: Config): LoadedDataset {
  const dataset = config.dataset ?? {};
  const kind = dataset.kind ?? "synthetic";
  if (kind === "native" || kind === "app") return nativeConversations(dataset);

  const rows: Conversation[] = [];
  if (kind === "synthetic" || kind === "mixed") rows.push(...syntheticConversations());
  if (kind === "private" || kind === "mixed") {
    rows.push(
      ...privateConversations(
        dataset.privateConversationLimit ?? 2,
        dataset.maxMessagesPerConversation ?? 600,
        dataset.privateConversationOrder ?? "recent",
      ),
    );
  }
  return {
    conversations: rows,
    source: { kind },
  };
}

function makeWindows(messages: Message[], size: number, stride: number): Window[] {
  const windows: Window[] = [];
  for (let start = 0; start < messages.length; start += stride) {
    const chunk = messages.slice(start, start + size);
    if (chunk.length >= Math.max(2, Math.min(4, size))) {
      windows.push({ index: windows.length, start, end: start + chunk.length - 1, messages: chunk });
    }
  }
  return windows;
}

function makeNativePlannedWindows(messages: Message[], size: number, stride: number): Window[] {
  const byOrdinal = new Map(messages.flatMap((message) => (message.ordinal ? [[message.ordinal, message]] : [])));
  const lastOrdinal = Math.max(0, ...messages.map((message) => message.ordinal ?? 0));
  const ranges = planRunWindowRanges(lastOrdinal, {
    mode: "absolute-message-count",
    contextMessages: 0,
    focalMessages: size,
    stride,
    minFocalMessages: Math.max(2, Math.min(4, size)),
  });
  return ranges.map((range) => ({
    index: range.ordinal - 1,
    start: range.focalStartOrdinal - 1,
    end: range.focalEndOrdinal - 1,
    ordinal: range.ordinal,
    messages: rangeOrdinals(range.focalStartOrdinal, range.focalEndOrdinal)
      .map((ordinal) => byOrdinal.get(ordinal))
      .filter((message): message is Message => Boolean(message)),
  })).filter((window) => window.messages.length > 0);
}

function rangeOrdinals(start: number, end: number): number[] {
  return Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index);
}

function windowsForConversation(conversation: Conversation, spec: { size: number; stride: number }): Window[] {
  if (conversation.kind === "native") {
    if (conversation.nativeWindows && conversation.nativeWindows.length > 0) return conversation.nativeWindows;
    return makeNativePlannedWindows(conversation.messages, spec.size, spec.stride);
  }
  return makeWindows(conversation.messages, spec.size, spec.stride);
}

function windowRef(conversationId: string, window: Window) {
  if (window.sourceWindowId) {
    return `${conversationId}_run${window.sourceRunId ?? "unknown"}_w${window.sourceWindowId}`;
  }
  return `${conversationId}_w${String(window.index).padStart(3, "0")}`;
}

function messageRef(message: Message, fallbackIndex: number): string {
  return `m${String(message.ordinal ?? fallbackIndex).padStart(4, "0")}`;
}

function messageLines(messages: Message[], start = 0, maxChars = 3000) {
  return messages
    .map((message, index) => {
      const speaker = message.isFromMe ? "me" : "them";
      const ref = messageRef(message, start + index);
      const ids = [
        message.messageId ? `messageId=${message.messageId}` : null,
        message.ordinal ? `ordinal=${message.ordinal}` : null,
      ].filter(Boolean).join(" ");
      return `${ref}${ids ? ` ${ids}` : ""}: ${speaker}: ${message.content}`;
    })
    .join("\n")
    .slice(0, maxChars);
}

function windowText(window: Window, maxChars = 3000) {
  return messageLines(window.messages, window.start, maxChars);
}

function zeroScores(): Scores {
  return Object.fromEntries(ANCHORS.map((anchor) => [anchor, 0])) as Scores;
}

function normalize(scores: Scores): Scores {
  const max = Math.max(1, ...Object.values(scores));
  return Object.fromEntries(ANCHORS.map((anchor) => [anchor, round(Math.min(1, scores[anchor] / max))])) as Scores;
}

function dominant(scores: Scores): Anchor {
  return Object.entries(scores).sort((a, b) => b[1] - a[1])[0]?.[0] as Anchor;
}

function meanScores(rows: Scores[]): Scores {
  const totals = zeroScores();
  for (const row of rows) {
    for (const anchor of ANCHORS) totals[anchor] += row[anchor];
  }
  return Object.fromEntries(ANCHORS.map((anchor) => [anchor, round(totals[anchor] / Math.max(1, rows.length))])) as Scores;
}

function scoreEmojiKeywordFeatures(text: string): Scores {
  const lowered = text.toLowerCase();
  const scores = zeroScores();
  for (const [anchor, terms] of Object.entries(FEATURE_LEXICON) as Array<[Anchor, string[]]>) {
    for (const term of terms) {
      if (lowered.includes(term)) scores[anchor] += 1;
    }
  }
  if (/❤️|💕|💗|😍|🥰|😘/u.test(text)) scores.joy += 2;
  if (/[😂🤣😄😆]/u.test(text)) scores.joy += 2;
  if (/[😬😰😭]/u.test(text)) scores.fear += 1.5;
  if (/[😡🙄]/u.test(text)) scores.anger += 1.5;
  if (/^(ok|k|sure|fine|yeah|yep|no worries)[.!? ]*$/i.test(text.trim())) scores.sadness += 0.8;
  if (/[!?]{2,}|😮|😲/u.test(text)) scores.surprise += 0.8;
  scores.neutral += /\b(\d{1,2}:\d{2}|\d+\s?(min|mins|minutes|pm|am)|where|when|who|send|pick up)\b/i.test(text) ? 0.8 : 0;
  return normalize(scores);
}

type EmotionClassifier = (
  input: string | string[],
  options: { top_k: number; truncation: boolean },
) => Promise<Array<{ label: string; score: number }> | Array<Array<{ label: string; score: number }>>>;

let robertaEmotionClassifier: EmotionClassifier | null = null;

async function robertaEmotion() {
  robertaEmotionClassifier ??= await pipeline("text-classification", ROBERTA_EMOTION_MODEL, { dtype: "q8" }) as unknown as EmotionClassifier;
  return robertaEmotionClassifier;
}

function scoresFromRobertaLabels(labels: Array<{ label: string; score: number }>): Scores {
  const scores = zeroScores();
  for (const row of labels) {
    const label = row.label.toLowerCase();
    if ((ANCHORS as readonly string[]).includes(label)) scores[label as Anchor] = round(row.score);
  }
  return scores;
}

function scoreWindow(window: Window, scorer: (text: string) => Scores): WindowScore {
  const totals = zeroScores();
  for (const message of window.messages) {
    const scores = scorer(message.content);
    for (const anchor of ANCHORS) totals[anchor] += scores[anchor];
  }
  const scores = Object.fromEntries(
    ANCHORS.map((anchor) => [anchor, round(totals[anchor] / window.messages.length)]),
  ) as Scores;
  return { index: window.index, scores, dominant: dominant(scores) };
}

function shiftRows(rows: WindowScore[]): WindowScore[] {
  return rows.map((row, index) => {
    if (index === 0) return { ...row, shiftMagnitude: 0, zMax: 0, deltas: zeroScores() };
    const prior = rows.slice(0, index).map((item) => item.scores);
    const baseline = meanScores(prior);
    const deltas = Object.fromEntries(ANCHORS.map((anchor) => [anchor, round(row.scores[anchor] - baseline[anchor])])) as Scores;
    let zMax = 0;
    for (const anchor of ANCHORS) {
      const values = prior.map((scores) => scores[anchor]);
      if (values.length < 2) continue;
      const average = values.reduce((sum, value) => sum + value, 0) / values.length;
      const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
      const sd = Math.sqrt(variance);
      if (sd > 0.001) zMax = Math.max(zMax, Math.abs((row.scores[anchor] - average) / sd));
    }
    return {
      ...row,
      shiftMagnitude: round(Math.sqrt(Object.values(deltas).reduce((sum, value) => sum + value * value, 0))),
      zMax: round(zMax),
      deltas,
    };
  });
}

function deterministicScorer(name: string) {
  if (name === "emoji_keyword_features") return scoreEmojiKeywordFeatures;
  return null;
}

async function scoreRobertaWindows(windows: Window[]): Promise<WindowScore[]> {
  const classifier = await robertaEmotion();
  const inputs = windows.map((window) => windowText(window, 1800));
  const outputs: Array<Array<{ label: string; score: number }>> = [];
  const batchSize = 32;
  for (let index = 0; index < inputs.length; index += batchSize) {
    const batch = inputs.slice(index, index + batchSize);
    const batchOutputs = (await classifier(batch, { top_k: 7, truncation: true })) as Array<Array<{ label: string; score: number }>>;
    outputs.push(...batchOutputs);
  }
  return windows.map((window, index) => {
    const labels = outputs[index] ?? [];
    const scores = scoresFromRobertaLabels(labels);
    return { index: window.index, scores, dominant: dominant(scores) };
  });
}

async function runDeterministic(
  conversations: Conversation[],
  windowing: NonNullable<Config["windowing"]>,
  names: string[],
  includeWindowText: boolean,
) {
  const results = [];
  for (const spec of windowing) {
    for (const name of names) {
      const scorer = deterministicScorer(name);
      if (!scorer && name !== "roberta_emotion") {
        results.push({ name, window: spec, skipped: "not implemented in TS Ax harness" });
        continue;
      }
      const started = performance.now();
      const rows = [];
      for (const conversation of conversations) {
        const windows = windowsForConversation(conversation, spec);
        const scored = name === "roberta_emotion"
          ? await scoreRobertaWindows(windows)
          : windows.map((window) => scoreWindow(window, scorer!));
        const shifted = shiftRows(scored);
        const dominantCounts = countBy(shifted.map((row) => row.dominant));
        rows.push({
          id: conversation.id,
          kind: conversation.kind,
          windowCount: shifted.length,
          dominantCounts,
          topShifts: [...shifted]
            .sort((a, b) => (b.shiftMagnitude ?? 0) - (a.shiftMagnitude ?? 0))
            .slice(0, 8)
            .map((row) => ({
              index: row.index,
              dominant: row.dominant,
              shiftMagnitude: row.shiftMagnitude,
              zMax: row.zMax,
              deltas: row.deltas,
            })),
          rows: shifted,
          reviewRows: includeWindowText
            ? shifted.map((row) => {
                const window = windows[row.index];
                return {
                  windowRef: windowRef(conversation.id, window),
                  sourceWindowId: window.sourceWindowId,
                  sourceRunId: window.sourceRunId,
                  index: row.index,
                  start: window.start,
                  end: window.end,
                  messageIds: window.messages.map((message) => message.id),
                  text: windowText(window, 5000),
                  dominant: row.dominant,
                  scores: row.scores,
                  shiftMagnitude: row.shiftMagnitude,
                  zMax: row.zMax,
                  deltas: row.deltas,
                };
              })
            : undefined,
        });
      }
      const totalWindows = rows.reduce((sum, row) => sum + row.windowCount, 0);
      results.push({
        name,
        window: spec,
        avgWindowMs: round((performance.now() - started) / Math.max(1, totalWindows)),
        totalWindows,
        dominantCounts: countBy(rows.flatMap((row) => Object.entries(row.dominantCounts).flatMap(([key, count]) => Array(count).fill(key)))),
        conversations: rows,
      });
    }
  }
  return results;
}

function windowSpecFor(config: LlmConfig, fallback: NonNullable<Config["windowing"]>[number]) {
  return config.window ?? fallback;
}

function deterministicConversation(
  deterministic: Awaited<ReturnType<typeof runDeterministic>>,
  scorer: string,
  spec: { size: number; stride: number },
  conversationId: string,
) {
  const result = deterministic.find((row) => row.name === scorer && JSON.stringify(row.window) === JSON.stringify(spec));
  return result?.conversations?.find((row) => row.id === conversationId);
}

function selectWindowIndexes(windows: Window[], conversationRow: { topShifts?: Array<{ index: number }> } | undefined, maxPerConversation: number) {
  const ranked = conversationRow?.topShifts?.map((row) => row.index) ?? [];
  const keep = new Set<number>(windows.length ? [0, windows.length - 1] : []);
  for (const index of ranked) {
    keep.add(index);
    if (keep.size >= maxPerConversation) break;
  }
  return keep;
}

function targetText(
  conversation: Conversation,
  window: Window,
  conversationRow: { rows?: WindowScore[] } | undefined,
  contextMode: SelectedWindow["contextMode"],
  maxContextChars: number,
  contextMessages: number,
) {
  const current = windowText(window, maxContextChars);
  if (contextMode === "window_only") return current;
  if (contextMode === "prior_summary") {
    const priorRows = conversationRow?.rows?.filter((row) => row.index < window.index) ?? [];
    const dominantCounts = countBy(priorRows.map((row) => row.dominant));
    const priorBaseline = priorRows.length ? meanScores(priorRows.map((row) => row.scores)) : zeroScores();
    return [
      `Prior aggregate context only, no prior message text. priorWindowCount=${priorRows.length}`,
      `Prior dominant counts: ${JSON.stringify(dominantCounts)}`,
      `Prior baseline: ${JSON.stringify(priorBaseline)}`,
      "Current window:",
      current,
    ].join("\n").slice(0, maxContextChars);
  }
  if (contextMode === "prior_messages") {
    const priorStart = Math.max(0, window.start - contextMessages);
    const prior = conversation.messages.slice(priorStart, window.start);
    return [
      `Prior ${prior.length} messages:`,
      messageLines(prior, priorStart, Math.floor(maxContextChars / 2)),
      "Current window:",
      current,
    ].join("\n").slice(0, maxContextChars);
  }
  return [
    "Conversation context, current window is included in chronological order:",
    messageLines(conversation.messages, 0, maxContextChars),
    `Current window ref: ${windowRef(conversation.id, window)}`,
  ].join("\n").slice(0, maxContextChars);
}

function refsForMessages(messages: Message[], start: number): SelectedWindow["messageRefs"] {
  return messages.map((message, index) => ({
    ref: messageRef(message, start + index),
    messageId: message.messageId,
    ordinal: message.ordinal,
  }));
}

function withInputStats(window: SelectedWindow): SelectedWindow {
  return { ...window, inputChars: scorePacketInputChars(window) };
}

function selectWindows(
  conversations: Conversation[],
  spec: { size: number; stride: number },
  selection: NonNullable<Config["selection"]>,
  deterministic: Awaited<ReturnType<typeof runDeterministic>>,
  contextMode: SelectedWindow["contextMode"] = "window_only",
  runMode: SelectedWindow["runMode"] = "selected_windows",
  maxContextChars = 3000,
  contextMessages = 24,
): SelectedWindow[] {
  const candidateScorer = selection.candidateScorer ?? "roberta_emotion";
  const maxPerConversation = selection.maxWindowsPerConversation ?? 4;
  const selected: SelectedWindow[] = [];

  for (const conversation of conversations) {
    const windows = windowsForConversation(conversation, spec);
    const conversationRow = deterministicConversation(deterministic, candidateScorer, spec, conversation.id);
    const keep = selectWindowIndexes(windows, conversationRow, maxPerConversation);
    for (const window of windows) {
      if (!keep.has(window.index)) continue;
      const prior = conversationRow?.rows?.filter((row) => row.index < window.index).map((row) => row.scores) ?? [];
      selected.push({
        conversationId: conversation.id,
        kind: conversation.kind,
        windowRef: windowRef(conversation.id, window),
        runMode,
        contextMode,
        text: targetText(conversation, window, conversationRow, contextMode, maxContextChars, contextMessages),
        baseline: prior.length ? meanScores(prior) : zeroScores(),
        sourceWindowId: window.sourceWindowId,
        sourceRunId: window.sourceRunId,
        messageRefs: refsForMessages(window.messages, window.start),
        inputChars: 0,
      });
    }
  }
  return selected.map(withInputStats);
}

function allWindowTargets(
  conversations: Conversation[],
  spec: { size: number; stride: number },
  scorer: string,
  deterministic: Awaited<ReturnType<typeof runDeterministic>>,
  contextMode: SelectedWindow["contextMode"],
  maxContextChars: number,
  contextMessages: number,
  maxPerConversation: number | undefined,
) {
  const targets: SelectedWindow[] = [];
  for (const conversation of conversations) {
    const windows = windowsForConversation(conversation, spec);
    const conversationRow = deterministicConversation(deterministic, scorer, spec, conversation.id);
    for (const window of windows.slice(0, maxPerConversation ?? windows.length)) {
      const prior = conversationRow?.rows?.filter((row) => row.index < window.index).map((row) => row.scores) ?? [];
      targets.push({
        conversationId: conversation.id,
        kind: conversation.kind,
        windowRef: windowRef(conversation.id, window),
        runMode: "all_windows",
        contextMode,
        text: targetText(conversation, window, conversationRow, contextMode, maxContextChars, contextMessages),
        baseline: prior.length ? meanScores(prior) : zeroScores(),
        sourceWindowId: window.sourceWindowId,
        sourceRunId: window.sourceRunId,
        messageRefs: refsForMessages(window.messages, window.start),
        inputChars: 0,
      });
    }
  }
  return targets.map(withInputStats);
}

function wholeConversationTargets(
  conversations: Conversation[],
  maxContextChars: number,
  maxConversations: number,
): SelectedWindow[] {
  const targets: SelectedWindow[] = conversations.slice(0, maxConversations).map((conversation) => ({
    conversationId: conversation.id,
    kind: conversation.kind,
    windowRef: `${conversation.id}_conversation`,
    runMode: "whole_conversation",
    contextMode: "full_conversation",
    text: messageLines(conversation.messages, 0, maxContextChars),
    baseline: zeroScores(),
    sourceRunId: conversation.nativeRunId,
    messageRefs: refsForMessages(conversation.messages, 0),
    inputChars: 0,
  }));
  return targets.map(withInputStats);
}

function targetsForRun(
  config: LlmConfig,
  conversations: Conversation[],
  fallbackWindowing: NonNullable<Config["windowing"]>,
  fallbackSelection: NonNullable<Config["selection"]>,
  deterministic: Awaited<ReturnType<typeof runDeterministic>>,
) {
  const runMode = config.runMode ?? "selected_windows";
  const contextMode = config.contextMode ?? (runMode === "whole_conversation" ? "full_conversation" : "window_only");
  const maxContextChars = config.maxContextChars ?? (contextMode === "full_conversation" ? 12000 : 3000);
  const contextMessages = config.contextMessages ?? 24;
  const maxConversations = config.maxConversations ?? conversations.length;
  const maxWindowsPerConversation = config.maxWindowsPerConversation;
  const scopedConversations = conversations.slice(0, maxConversations);
  const spec = windowSpecFor(config, fallbackWindowing[0] ?? { size: 8, stride: 4 });
  const selection = config.selection ?? fallbackSelection;
  const scorer = selection.candidateScorer ?? "roberta_emotion";

  if (runMode === "whole_conversation") return wholeConversationTargets(scopedConversations, maxContextChars, maxConversations);
  if (runMode === "all_windows") {
    return allWindowTargets(scopedConversations, spec, scorer, deterministic, contextMode, maxContextChars, contextMessages, maxWindowsPerConversation);
  }
  return selectWindows(
    scopedConversations,
    spec,
    selection,
    deterministic,
    contextMode,
    "selected_windows",
    maxContextChars,
    contextMessages,
  );
}

const scoreWindowWithAx = ax(`
  taskContext:string "Instructions and JSON contract",
  schemaJson:string "Strict JSON schema the resultJson output must satisfy",
  baselineJson:string "Prior conversation-specific baseline scores as JSON",
  windowRef:string "Stable local window reference",
  windowText:string "Bounded private iMessage window with local message refs"
  ->
  resultJson:string "Strict JSON only, no markdown, no private message quotes"
`);

const WINDOW_SCORE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "windowRef",
    "scores",
    "dominant",
    "confidence",
    "stateLabel",
    "reasoningSummary",
    "uncertainty",
    "priorComparison",
    "evidence",
  ],
  properties: {
    windowRef: { type: "string" },
    scores: {
      type: "object",
      additionalProperties: false,
      required: ANCHORS,
      properties: Object.fromEntries(ANCHORS.map((anchor) => [anchor, { type: "number", minimum: 0, maximum: 1 }])),
    },
    dominant: { enum: ANCHORS },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    stateLabel: { type: "string", maxLength: 80 },
    reasoningSummary: {
      type: "string",
      maxLength: 220,
      description: "Short dashboard-safe rationale. Do not quote or paraphrase private text.",
    },
    uncertainty: {
      type: "object",
      additionalProperties: false,
      required: ["level", "reason"],
      properties: {
        level: { enum: ["low", "medium", "high"] },
        reason: { type: "string", maxLength: 160 },
      },
    },
    priorComparison: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "largestDeltaEmotion", "largestDelta"],
      properties: {
        summary: { type: "string", maxLength: 180 },
        largestDeltaEmotion: { enum: ANCHORS },
        largestDelta: { type: "number", minimum: -1, maximum: 1 },
      },
    },
    evidence: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ref"],
        properties: {
          ref: { type: "string", pattern: "^m[0-9]{4,}$" },
          messageId: { type: "number" },
          ordinal: { type: "number" },
        },
      },
    },
  },
} as const;

function axService(config: LlmConfig) {
  const apiKey =
    config.provider === "openrouter" ? process.env.OPENROUTER_API_KEY : process.env.OPENAI_API_KEY ?? process.env.OPENAI_APIKEY;
  if (!apiKey) throw new Error(`${config.provider} API key not set`);
  const apiURL = config.provider === "openrouter" ? "https://openrouter.ai/api/v1" : undefined;

  return ai({
    name: "openai",
    apiKey,
    apiURL,
    models: [
      {
        key: "default",
        description: `${config.provider}:${config.model}`,
        model: config.model as never,
      },
    ],
    config: {
      model: "default" as never,
      temperature: 0,
      maxTokens: config.maxTokens ?? 350,
    },
  } as never);
}

function taskContext() {
  return [
    "Score a private iMessage conversation window for temporal emotion analysis.",
    "Do not quote or paraphrase private message text.",
    `Use these RoBERTa/Ekman-style emotion dimensions only: ${ANCHORS.join(", ")}.`,
    "Use evidence refs by local message ref, message id, or ordinal only.",
    "Compare the current window against baselineJson when choosing stateLabel, confidence, uncertainty, and priorComparison.",
    "Return only resultJson that conforms to schemaJson. Do not include raw chain-of-thought.",
  ].join("\n");
}

function scorePacketInputChars(window: SelectedWindow): number {
  return (
    taskContext().length +
    JSON.stringify(WINDOW_SCORE_SCHEMA).length +
    JSON.stringify(window.baseline).length +
    window.windowRef.length +
    window.text.length
  );
}

function estimatedTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function estimatedCostUsd(
  config: LlmConfig,
  inputTokens: number,
  outputTokens: number,
): number | null {
  if (config.inputUsdPerMillionTokens === undefined || config.outputUsdPerMillionTokens === undefined) {
    return null;
  }
  return roundCurrency(
    (inputTokens * config.inputUsdPerMillionTokens + outputTokens * config.outputUsdPerMillionTokens) / 1_000_000,
  );
}

function roundCurrency(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

type ParsedLlmScore = {
  windowRef: string;
  scores: Scores;
  dominant: Anchor;
  confidence: number;
  stateLabel: string | null;
  reasoningSummary: string | null;
  uncertainty: { level: string; reason: string } | null;
  priorComparison: { summary: string; largestDeltaEmotion: Anchor; largestDelta: number } | null;
  evidence: SelectedWindow["messageRefs"];
};

function parseResultJson(value: unknown, window: SelectedWindow): ParsedLlmScore {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "")) as Record<string, unknown>;
  const rawScores = (parsed.scores && typeof parsed.scores === "object" ? parsed.scores : {}) as Record<string, unknown>;
  const scores = Object.fromEntries(ANCHORS.map((anchor) => [anchor, clampNumber(rawScores[anchor])])) as Scores;
  const evidence = sanitizeEvidence(parsed.evidence, window);
  const dominantValue = typeof parsed.dominant === "string" && (ANCHORS as readonly string[]).includes(parsed.dominant)
    ? parsed.dominant as Anchor
    : dominant(scores);
  return {
    windowRef: typeof parsed.windowRef === "string" ? parsed.windowRef : window.windowRef,
    scores,
    dominant: dominantValue,
    confidence: clampNumber(parsed.confidence),
    stateLabel: typeof parsed.stateLabel === "string" ? parsed.stateLabel.slice(0, 80) : null,
    reasoningSummary: typeof parsed.reasoningSummary === "string" ? parsed.reasoningSummary.slice(0, 220) : null,
    uncertainty: sanitizeUncertainty(parsed.uncertainty),
    priorComparison: sanitizePriorComparison(parsed.priorComparison),
    evidence,
  };
}

function sanitizeEvidence(value: unknown, window: SelectedWindow): SelectedWindow["messageRefs"] {
  if (!Array.isArray(value)) return [];
  const allowed = new Map(window.messageRefs.map((ref) => [ref.ref, ref]));
  return value.slice(0, 5).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const ref = typeof row.ref === "string" ? row.ref : "";
    const known = allowed.get(ref);
    if (known) return [known];
    return [];
  });
}

function sanitizeUncertainty(value: unknown): ParsedLlmScore["uncertainty"] {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const level = typeof row.level === "string" ? row.level : "medium";
  return {
    level: ["low", "medium", "high"].includes(level) ? level : "medium",
    reason: typeof row.reason === "string" ? row.reason.slice(0, 160) : "",
  };
}

function sanitizePriorComparison(value: unknown): ParsedLlmScore["priorComparison"] {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const emotion = typeof row.largestDeltaEmotion === "string" && (ANCHORS as readonly string[]).includes(row.largestDeltaEmotion)
    ? row.largestDeltaEmotion as Anchor
    : "neutral";
  return {
    summary: typeof row.summary === "string" ? row.summary.slice(0, 180) : "",
    largestDeltaEmotion: emotion,
    largestDelta: Math.max(-1, Math.min(1, round(Number(row.largestDelta) || 0))),
  };
}

async function scoreSelectedWindow(config: LlmConfig, service: ReturnType<typeof axService>, window: SelectedWindow) {
  const started = performance.now();
  const output = await scoreWindowWithAx.forward(service, {
    taskContext: taskContext(),
    schemaJson: JSON.stringify(WINDOW_SCORE_SCHEMA),
    baselineJson: JSON.stringify(window.baseline),
    windowRef: window.windowRef,
    windowText: window.text,
  });
  const latencyMs = round(performance.now() - started);
  const parsed = parseResultJson(output.resultJson, window);
  const outputTokens = estimatedTokens(String(output.resultJson ?? "").length);
  const inputTokens = estimatedTokens(window.inputChars);
  return {
    windowRef: window.windowRef,
    sourceWindowId: window.sourceWindowId,
    sourceRunId: window.sourceRunId,
    latencyMs,
    stateLabel: parsed.stateLabel,
    confidence: parsed.confidence,
    dominant: parsed.dominant,
    scores: parsed.scores,
    evidence: parsed.evidence,
    evidenceRefCount: parsed.evidence.length,
    reasoningSummary: parsed.reasoningSummary,
    uncertainty: parsed.uncertainty,
    priorComparison: parsed.priorComparison,
    inputTokens,
    outputTokens,
    estimatedCostUsd: estimatedCostUsd(config, inputTokens, outputTokens),
  };
}

async function runLlm(
  conversations: Conversation[],
  deterministic: Awaited<ReturnType<typeof runDeterministic>>,
  windowing: NonNullable<Config["windowing"]>,
  selection: NonNullable<Config["selection"]>,
  configs: LlmConfig[],
  noProvider: boolean,
) {
  const results = [];
  for (const config of configs) {
    if (config.enabled === false) {
      results.push({ name: config.name, skipped: "disabled" });
      continue;
    }
    const targets = targetsForRun(config, conversations, windowing, selection, deterministic);
    const windows = targets.slice(0, config.maxWindows ?? targets.length);
    const started = performance.now();
    const rows: LlmRow[] = noProvider
      ? windows.map((window) => ({
          ok: true,
          dryRun: true,
          windowRef: window.windowRef,
          sourceWindowId: window.sourceWindowId,
          sourceRunId: window.sourceRunId,
          messageCount: window.messageRefs.length,
          inputChars: window.inputChars,
          inputTokens: estimatedTokens(window.inputChars),
          estimatedCostUsd: null,
          completionMs: round(performance.now() - started),
        }))
      : await providerRows(config, windows, started);
    const ok = rows.filter((row): row is Extract<LlmRow, { ok: true }> => row.ok);
    const providerOk = ok.filter((row): row is Extract<LlmRow, { ok: true; dryRun?: never }> => !("dryRun" in row));
    const latencies = providerOk.map((row) => Number(row.latencyMs ?? 0));
    const inputTokens = ok.reduce((sum, row) => sum + Number(row.inputTokens ?? 0), 0);
    const outputTokens = providerOk.reduce((sum, row) => sum + Number(row.outputTokens ?? 0), 0);
    const costValues = ok.map((row) => row.estimatedCostUsd).filter((value): value is number => typeof value === "number");
    results.push({
      name: config.name,
      provider: config.provider,
      model: config.model,
      dryRun: noProvider,
      runMode: config.runMode ?? "selected_windows",
      contextMode: config.contextMode ?? ((config.runMode ?? "selected_windows") === "whole_conversation" ? "full_conversation" : "window_only"),
      window: config.window ?? windowing[0],
      windowCount: windows.length,
      okCount: ok.length,
      errorCount: rows.length - ok.length,
      wallMs: round(performance.now() - started),
      avgLatencyMs: latencies.length ? round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : null,
      tokenEstimate: {
        input: inputTokens,
        output: outputTokens,
        total: inputTokens + outputTokens,
      },
      estimatedCostUsd: costValues.length ? roundCurrency(costValues.reduce((sum, value) => sum + value, 0)) : null,
      dominantCounts: countBy(providerOk.map((row) => String(row.dominant))),
      avgConfidence: providerOk.length ? round(providerOk.reduce((sum, row) => sum + Number(row.confidence ?? 0), 0) / providerOk.length) : null,
      evidenceCoverage: providerOk.length ? round(providerOk.filter((row) => Number(row.evidenceRefCount ?? 0) > 0).length / providerOk.length) : null,
      firstResultMs: ok.length ? Math.min(...ok.map((row) => Number(row.completionMs))) : null,
      allResultsMs: ok.length ? Math.max(...ok.map((row) => Number(row.completionMs))) : null,
      sampleErrors: rows.filter((row) => !row.ok).map((row) => row.error).slice(0, 3),
      rows: rows.map((row) =>
        row.ok && "dryRun" in row
          ? {
              ok: true,
              dryRun: true,
              windowRef: row.windowRef,
              sourceWindowId: row.sourceWindowId,
              sourceRunId: row.sourceRunId,
              messageCount: row.messageCount,
              inputChars: row.inputChars,
              inputTokens: row.inputTokens,
              estimatedCostUsd: row.estimatedCostUsd,
              completionMs: row.completionMs,
            }
          : row.ok
          ? {
              ok: true,
              windowRef: row.windowRef,
              sourceWindowId: row.sourceWindowId,
              sourceRunId: row.sourceRunId,
              latencyMs: row.latencyMs,
              completionMs: row.completionMs,
              dominant: row.dominant,
              confidence: row.confidence,
              evidence: row.evidence,
              evidenceRefCount: row.evidenceRefCount,
              reasoningSummary: row.reasoningSummary,
              uncertainty: row.uncertainty,
              priorComparison: row.priorComparison,
              inputTokens: row.inputTokens,
              outputTokens: row.outputTokens,
              estimatedCostUsd: row.estimatedCostUsd,
              scores: row.scores,
            }
          : {
              ok: false,
              completionMs: row.completionMs,
              error: row.error,
            },
      ),
    });
  }
  return results;
}

async function providerRows(
  config: LlmConfig,
  windows: SelectedWindow[],
  started: number,
): Promise<LlmRow[]> {
  const service = axService(config);
  return mapLimit(windows, config.concurrency ?? 4, async (window): Promise<LlmRow> => {
    try {
      return {
        ok: true,
        ...(await scoreSelectedWindow(config, service, window)),
        completionMs: round(performance.now() - started),
      };
    } catch (error) {
      return {
        ok: false,
        error: redactError(error),
        completionMs: round(performance.now() - started),
      };
    }
  });
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await fn(items[current]);
    }
  });
  await Promise.all(workers);
  return results;
}

function clampNumber(value: unknown) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(1, round(numeric)));
}

function countBy(values: string[]) {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function redactError(error: unknown) {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted-key]")
    .replace(/m\d{4}:.*$/gm, "[redacted-message-line]")
    .slice(0, 240);
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}

function mergedWindowing(base: NonNullable<Config["windowing"]>, llm: LlmConfig[]) {
  const seen = new Set<string>();
  const specs = [...base, ...llm.map((row) => row.window).filter((row): row is { size: number; stride: number } => Boolean(row))];
  return specs.filter((spec) => {
    const key = `${spec.size}/${spec.stride}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function assertSafeRawOutputPath(out: string, includeWindowText: boolean) {
  if (!includeWindowText) return;
  const outRoot = resolve(fileURLToPath(OUT_DIR));
  const outPath = resolve(out);
  if (outPath !== outRoot && !outPath.startsWith(`${outRoot}${sep}`)) {
    throw new Error(`includeWindowTextInOutput can only write under ignored out/: ${outPath}`);
  }
}

async function main() {
  loadEnv();
  const args = parseArgs();
  const config = loadConfig(args.config);
  const includeWindowText = Boolean(args.allowPrivateOutput && config.dataset?.includeWindowTextInOutput);
  assertSafeRawOutputPath(args.out, includeWindowText);
  mkdirSync(OUT_DIR, { recursive: true });

  const dataset = loadDataset(config);
  const conversations = dataset.conversations;
  const windowing = mergedWindowing(config.windowing ?? [{ size: 8, stride: 4 }], config.llm ?? []);
  const deterministicNames = config.deterministic ?? ["roberta_emotion", "emoji_keyword_features"];
  const deterministic = await runDeterministic(conversations, windowing, deterministicNames, includeWindowText);
  const selection = config.selection ?? {};
  const selectedWindows = selectWindows(conversations, windowing[0] ?? { size: 8, stride: 4 }, selection, deterministic);
  const llm = await runLlm(conversations, deterministic, windowing, selection, config.llm ?? [], args.noProvider);

  const result = {
    generatedAt: new Date().toISOString(),
    runName: config.runName,
    anchors: ANCHORS,
    providerEnvVarsDetected: providerEnvVars(),
    noProvider: args.noProvider,
    privacy: includeWindowText
      ? "Private messages may be read locally and sent to configured Ax LLM providers for selected windows. This local review run includes raw window text in ignored out/ artifacts; do not commit those outputs."
      : "Private messages may be read locally and sent to configured Ax LLM providers only when provider mode is enabled; persisted output omits raw private text and evidence uses message refs only.",
    dataset: {
      source: dataset.source,
      conversationCount: conversations.length,
      kinds: countBy(conversations.map((conversation) => conversation.kind)),
      conversations: conversations.map((conversation) => ({
        id: conversation.id,
        kind: conversation.kind,
        sourceConversationId: conversation.sourceConversationId,
        nativeRunId: conversation.nativeRunId,
        nativeWindowCount: conversation.nativeWindows?.length ?? 0,
        fullMessageCount: conversation.fullMessageCount ?? conversation.messages.length,
        loadedMessageCount: conversation.messages.length,
      })),
    },
    windowing,
    selectedWindowCount: selectedWindows.length,
    deterministic,
    llm,
  };

  writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        outPath: resolve(args.out),
        runName: result.runName,
        dataset: result.dataset,
        selectedWindowCount: result.selectedWindowCount,
        deterministic: deterministic.map((row) => ({
          name: row.name,
          window: row.window,
          totalWindows: row.totalWindows,
          avgWindowMs: row.avgWindowMs,
          dominantCounts: row.dominantCounts,
          skipped: row.skipped,
        })),
        llm: llm.map((row) => ({
          name: row.name,
          provider: row.provider,
          model: row.model,
          runMode: row.runMode,
          contextMode: row.contextMode,
          window: row.window,
          windowCount: row.windowCount,
          okCount: row.okCount,
          errorCount: row.errorCount,
          wallMs: row.wallMs,
          avgLatencyMs: row.avgLatencyMs,
          avgConfidence: row.avgConfidence,
          tokenEstimate: row.tokenEstimate,
          estimatedCostUsd: row.estimatedCostUsd,
          dryRun: row.dryRun,
          skipped: row.skipped,
          sampleErrors: row.sampleErrors,
        })),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(redactError(error));
  process.exit(1);
});
