import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { ai, ax } from "@ax-llm/ax";
import { pipeline } from "@huggingface/transformers";

const ANCHORS = [
  "anger",
  "disgust",
  "fear",
  "joy",
  "neutral",
  "sadness",
  "surprise",
] as const;

type Anchor = (typeof ANCHORS)[number];
type Scores = Record<Anchor, number>;

type Message = {
  id: string;
  content: string;
  isFromMe: boolean;
  sentAt?: string;
};

type Conversation = {
  id: string;
  kind: "synthetic" | "private";
  expected?: Anchor[];
  sourceConversationId?: string;
  fullMessageCount?: number;
  messages: Message[];
};

type Window = {
  index: number;
  start: number;
  end: number;
  messages: Message[];
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
  enabled?: boolean;
};

type Config = {
  runName?: string;
  dataset?: {
    kind?: "synthetic" | "private" | "mixed";
    privateConversationLimit?: number;
    maxMessagesPerConversation?: number;
    privateConversationOrder?: "recent" | "longest";
    includeWindowTextInOutput?: boolean;
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
      latencyMs: number;
      stateLabel: string | null;
      confidence: number;
      dominant: Anchor;
      scores: Scores;
      evidenceRefCount: number;
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

function cuedSql(sql: string): Array<Record<string, unknown>> {
  const raw = execFileSync("cued", ["sql", sql], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(raw.replace(/^\(node:[^\n]+\)\s+ExperimentalWarning:[\s\S]*?\n(?=[\[{])/, ""));
}

function loadDataset(config: Config): Conversation[] {
  const dataset = config.dataset ?? {};
  const kind = dataset.kind ?? "synthetic";
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
  return rows;
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

function windowRef(conversationId: string, window: Window) {
  return `${conversationId}_w${String(window.index).padStart(3, "0")}`;
}

function messageLines(messages: Message[], start = 0, maxChars = 3000) {
  return messages
    .map((message, index) => {
      const speaker = message.isFromMe ? "me" : "them";
      return `m${String(start + index).padStart(4, "0")}: ${speaker}: ${message.content}`;
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
  if (/[❤️💕💗😍🥰😘]/u.test(text)) scores.joy += 2;
  if (/[😂🤣😄😆]/u.test(text)) scores.joy += 2;
  if (/[😬😰😭]/u.test(text)) scores.fear += 1.5;
  if (/[😡🙄]/u.test(text)) scores.anger += 1.5;
  if (/^(ok|k|sure|fine|yeah|yep|no worries)[.!? ]*$/i.test(text.trim())) scores.sadness += 0.8;
  if (/[!?]{2,}|😮|😲/u.test(text)) scores.surprise += 0.8;
  scores.neutral += /\b(\d{1,2}:\d{2}|\d+\s?(min|mins|minutes|pm|am)|where|when|who|send|pick up)\b/i.test(text) ? 0.8 : 0;
  return normalize(scores);
}

let robertaEmotionClassifier: Promise<any> | null = null;

async function robertaEmotion() {
  robertaEmotionClassifier ??= pipeline("text-classification", ROBERTA_EMOTION_MODEL, { dtype: "q8" });
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
        const windows = makeWindows(conversation.messages, spec.size, spec.stride);
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
    const windows = makeWindows(conversation.messages, spec.size, spec.stride);
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
      });
    }
  }
  return selected;
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
    const windows = makeWindows(conversation.messages, spec.size, spec.stride);
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
      });
    }
  }
  return targets;
}

function wholeConversationTargets(
  conversations: Conversation[],
  maxContextChars: number,
  maxConversations: number,
): SelectedWindow[] {
  return conversations.slice(0, maxConversations).map((conversation) => ({
    conversationId: conversation.id,
    kind: conversation.kind,
    windowRef: `${conversation.id}_conversation`,
    runMode: "whole_conversation",
    contextMode: "full_conversation",
    text: messageLines(conversation.messages, 0, maxContextChars),
    baseline: zeroScores(),
  }));
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
  baselineJson:string "Prior conversation-specific baseline scores as JSON",
  windowRef:string "Stable local window reference",
  windowText:string "Bounded private iMessage window with local message refs"
  ->
  anger:number "anger score from 0 to 1",
  disgust:number "disgust score from 0 to 1",
  fear:number "fear score from 0 to 1",
  joy:number "joy score from 0 to 1",
  neutral:number "neutral score from 0 to 1",
  sadness:number "sadness score from 0 to 1",
  surprise:number "surprise score from 0 to 1",
  confidence:number "confidence from 0 to 1",
  stateLabel:string "short non-identifying state label",
  evidenceMessageRefs:string[] "local message refs only, like m0042"
`);

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
    "Use evidenceMessageRefs as local refs like m0042 only.",
    "Compare the current window against the baselineJson when choosing stateLabel and confidence.",
  ].join("\n");
}

async function scoreSelectedWindow(config: LlmConfig, service: ReturnType<typeof axService>, window: SelectedWindow) {
  const started = performance.now();
  const output = await scoreWindowWithAx.forward(service, {
    taskContext: taskContext(),
    baselineJson: JSON.stringify(window.baseline),
    windowRef: window.windowRef,
    windowText: window.text,
  });
  const latencyMs = round(performance.now() - started);
  const scores: Scores = {
    anger: clampNumber(output.anger),
    disgust: clampNumber(output.disgust),
    fear: clampNumber(output.fear),
    joy: clampNumber(output.joy),
    neutral: clampNumber(output.neutral),
    sadness: clampNumber(output.sadness),
    surprise: clampNumber(output.surprise),
  };
  return {
    windowRef: window.windowRef,
    latencyMs,
    stateLabel: typeof output.stateLabel === "string" ? output.stateLabel.slice(0, 80) : null,
    confidence: clampNumber(output.confidence),
    dominant: dominant(scores),
    scores,
    evidenceRefCount: Array.isArray(output.evidenceMessageRefs) ? output.evidenceMessageRefs.length : 0,
  };
}

async function runLlm(
  conversations: Conversation[],
  deterministic: Awaited<ReturnType<typeof runDeterministic>>,
  windowing: NonNullable<Config["windowing"]>,
  selection: NonNullable<Config["selection"]>,
  configs: LlmConfig[],
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
    const service = axService(config);
    const rows: LlmRow[] = await mapLimit(windows, config.concurrency ?? 4, async (window): Promise<LlmRow> => {
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
    const ok = rows.filter((row): row is Extract<LlmRow, { ok: true }> => row.ok);
    const latencies = ok.map((row) => Number(row.latencyMs ?? 0));
    results.push({
      name: config.name,
      provider: config.provider,
      model: config.model,
      runMode: config.runMode ?? "selected_windows",
      contextMode: config.contextMode ?? ((config.runMode ?? "selected_windows") === "whole_conversation" ? "full_conversation" : "window_only"),
      window: config.window ?? windowing[0],
      windowCount: windows.length,
      okCount: ok.length,
      errorCount: rows.length - ok.length,
      wallMs: round(performance.now() - started),
      avgLatencyMs: latencies.length ? round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : null,
      dominantCounts: countBy(ok.map((row) => String(row.dominant))),
      avgConfidence: ok.length ? round(ok.reduce((sum, row) => sum + Number(row.confidence ?? 0), 0) / ok.length) : null,
      evidenceCoverage: ok.length ? round(ok.filter((row) => Number(row.evidenceRefCount ?? 0) > 0).length / ok.length) : null,
      firstResultMs: ok.length ? Math.min(...ok.map((row) => Number(row.completionMs))) : null,
      allResultsMs: ok.length ? Math.max(...ok.map((row) => Number(row.completionMs))) : null,
      sampleErrors: rows.filter((row) => !row.ok).map((row) => row.error).slice(0, 3),
      rows: rows.map((row) =>
        row.ok
          ? {
              ok: true,
              windowRef: row.windowRef,
              latencyMs: row.latencyMs,
              completionMs: row.completionMs,
              dominant: row.dominant,
              confidence: row.confidence,
              evidenceRefCount: row.evidenceRefCount,
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
  const includeWindowText = Boolean(config.dataset?.includeWindowTextInOutput);
  assertSafeRawOutputPath(args.out, includeWindowText);
  mkdirSync(OUT_DIR, { recursive: true });

  const conversations = loadDataset(config);
  const windowing = mergedWindowing(config.windowing ?? [{ size: 8, stride: 4 }], config.llm ?? []);
  const deterministicNames = config.deterministic ?? ["roberta_emotion", "emoji_keyword_features"];
  const deterministic = await runDeterministic(conversations, windowing, deterministicNames, includeWindowText);
  const selection = config.selection ?? {};
  const selectedWindows = selectWindows(conversations, windowing[0] ?? { size: 8, stride: 4 }, selection, deterministic);
  const llm = await runLlm(conversations, deterministic, windowing, selection, config.llm ?? []);

  const result = {
    generatedAt: new Date().toISOString(),
    runName: config.runName,
    anchors: ANCHORS,
    providerEnvVarsDetected: providerEnvVars(),
    privacy: includeWindowText
      ? "Private messages may be read locally and sent to configured Ax LLM providers for selected windows. This local review run includes raw window text in ignored out/ artifacts; do not commit those outputs."
      : "Private messages may be read locally and sent to configured Ax LLM providers only for selected windows; persisted output omits raw private text.",
    dataset: {
      conversationCount: conversations.length,
      kinds: countBy(conversations.map((conversation) => conversation.kind)),
      conversations: conversations.map((conversation) => ({
        id: conversation.id,
        kind: conversation.kind,
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
