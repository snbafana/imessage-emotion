import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
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

const ROBERTA_EMOTION_MODEL = "nicky48/emotion-english-distilroberta-base-ONNX";

type Anchor = (typeof ANCHORS)[number];
type Scores = Record<Anchor, number>;

type Message = {
  id: string;
  isFromMe: boolean;
  sentAt: string;
  content: string;
};

type Span = {
  start: number;
  end: number;
  depth: number;
  scores: Scores;
  dominant: Anchor;
  spikeScore: number;
  reason: string;
  parent?: { start: number; end: number };
};

function args() {
  const values = process.argv.slice(2);
  const valueAfter = (flag: string, fallback: string) => {
    const index = values.indexOf(flag);
    return index >= 0 ? (values[index + 1] ?? fallback) : fallback;
  };
  return {
    conversationIndex: Number(valueAfter("--conversation-index", "1")),
    maxMessages: Number(valueAfter("--max-messages", "800")),
    broadSize: Number(valueAfter("--broad-size", "128")),
    broadStride: Number(valueAfter("--broad-stride", "64")),
    minSize: Number(valueAfter("--min-size", "2")),
    maxDepth: Number(valueAfter("--max-depth", "7")),
    topSpans: Number(valueAfter("--top-spans", "8")),
    branchFactor: Number(valueAfter("--branch-factor", "2")),
    out: valueAfter("--out", "out/zoom-spikes.json"),
  };
}

function cuedSql(sql: string): Array<Record<string, unknown>> {
  const raw = execFileSync("cued", ["sql", sql], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  return JSON.parse(raw.replace(/^\(node:[^\n]+\)\s+ExperimentalWarning:[\s\S]*?\n(?=[[{])/, ""));
}

function loadConversation(conversationIndex: number, maxMessages: number) {
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
    order by last_at desc
    limit ${Math.max(1, conversationIndex)}
  `);
  const conversation = conversations[conversationIndex - 1];
  if (!conversation) throw new Error(`No private conversation at index ${conversationIndex}`);
  const sourceConversationId = String(conversation.id);
  const messages = cuedSql(`
    select id, is_from_me as isFromMe, sent_at as sentAt, content
    from messages
    where conversation_id = '${sourceConversationId.replaceAll("'", "''")}'
      and content is not null
      and length(trim(content)) > 0
    order by sent_at asc
    limit ${maxMessages}
  `).map((row) => ({
    id: String(row.id),
    isFromMe: Boolean(row.isFromMe),
    sentAt: String(row.sentAt ?? ""),
    content: String(row.content).slice(0, 500),
  }));
  return { id: `private_c${String(conversationIndex).padStart(2, "0")}`, sourceConversationId, messages };
}

function zeroScores(): Scores {
  return Object.fromEntries(ANCHORS.map((anchor) => [anchor, 0])) as Scores;
}

function normalize(scores: Scores): Scores {
  const max = Math.max(1, ...Object.values(scores));
  return Object.fromEntries(ANCHORS.map((anchor) => [anchor, round(Math.min(1, scores[anchor] / max))])) as Scores;
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
  return normalize(scores);
}

function spanText(messages: Message[], start: number, end: number) {
  const slice = messages.slice(start, end + 1);
  return slice
    .map((message, index) => {
      const speaker = message.isFromMe ? "me" : "them";
      return `m${String(start + index).padStart(4, "0")}: ${speaker}: ${message.content}`;
    })
    .join("\n")
    .slice(0, 1800);
}

async function scoreSpan(messages: Message[], start: number, end: number): Promise<Scores> {
  const classifier = await robertaEmotion();
  const outputs = (await classifier(spanText(messages, start, end), { top_k: 7, truncation: true })) as Array<{ label: string; score: number }>;
  return scoresFromRobertaLabels(outputs);
}

function dominant(scores: Scores): Anchor {
  return Object.entries(scores).sort((a, b) => b[1] - a[1])[0]?.[0] as Anchor;
}

function distance(a: Scores, b: Scores) {
  return Math.sqrt(ANCHORS.reduce((sum, anchor) => sum + (a[anchor] - b[anchor]) ** 2, 0));
}

function emotionalMass(scores: Scores) {
  return (
    scores.joy +
    scores.surprise * 0.9 +
    scores.fear * 1.2 +
    scores.anger * 1.4 +
    scores.disgust * 1.25 +
    scores.sadness * 1.25 -
    scores.neutral * 0.25
  );
}

function spanScore(scores: Scores, baseline: Scores, parent?: Scores) {
  return round(emotionalMass(scores) + distance(scores, baseline) * 1.8 + (parent ? distance(scores, parent) * 2.2 : 0));
}

async function makeSpan(
  messages: Message[],
  start: number,
  end: number,
  depth: number,
  baseline: Scores,
  parentScores?: Scores,
  parent?: Span,
): Promise<Span> {
  const scores = await scoreSpan(messages, start, end);
  const score = spanScore(scores, baseline, parentScores);
  const dom = dominant(scores);
  const reason = parent
    ? `split ${parent.start}-${parent.end}; ${dom}; score=${score}`
    : `broad candidate; ${dom}; score=${score}`;
  return {
    start,
    end,
    depth,
    scores,
    dominant: dom,
    spikeScore: score,
    reason,
    parent: parent ? { start: parent.start, end: parent.end } : undefined,
  };
}

async function broadSpans(messages: Message[], size: number, stride: number, baseline: Scores) {
  const spans: Span[] = [];
  for (let start = 0; start < messages.length; start += stride) {
    const end = Math.min(messages.length - 1, start + size - 1);
    if (end - start + 1 >= Math.min(size, 8)) spans.push(await makeSpan(messages, start, end, 0, baseline));
  }
  return spans;
}

async function splitSpan(messages: Message[], span: Span, baseline: Scores, minSize: number) {
  const size = span.end - span.start + 1;
  if (size <= minSize) return [];
  const mid = Math.floor((span.start + span.end) / 2);
  const parentScores = span.scores;
  const children = [
    await makeSpan(messages, span.start, mid, span.depth + 1, baseline, parentScores, span),
    await makeSpan(messages, mid + 1, span.end, span.depth + 1, baseline, parentScores, span),
  ];
  if (size >= minSize * 4) {
    const quarter = Math.floor(size / 4);
    const centerStart = Math.max(span.start, mid - quarter + 1);
    const centerEnd = Math.min(span.end, mid + quarter);
    children.push(await makeSpan(messages, centerStart, centerEnd, span.depth + 1, baseline, parentScores, span));
  }
  return children;
}

async function zoom(messages: Message[], options: ReturnType<typeof args>) {
  const baseline = await scoreSpan(messages, 0, messages.length - 1);
  const coarse = await broadSpans(messages, options.broadSize, options.broadStride, baseline);
  let frontier = [...coarse].sort((a, b) => b.spikeScore - a.spikeScore).slice(0, options.topSpans);
  const visited = new Map<string, Span>();
  for (const span of frontier) visited.set(`${span.start}:${span.end}`, span);

  for (let depth = 0; depth < options.maxDepth; depth++) {
    const children = (await Promise.all(frontier.map((span) => splitSpan(messages, span, baseline, options.minSize)))).flat();
    if (!children.length) break;
    const ranked = children.sort((a, b) => b.spikeScore - a.spikeScore).slice(0, Math.max(1, options.topSpans * options.branchFactor));
    for (const span of ranked) visited.set(`${span.start}:${span.end}`, span);
    frontier = ranked.slice(0, options.topSpans);
    if (frontier.every((span) => span.end - span.start + 1 <= options.minSize)) break;
  }

  return {
    baseline,
    coarse: coarse.sort((a, b) => b.spikeScore - a.spikeScore).slice(0, options.topSpans),
    pivotal: [...visited.values()]
      .filter((span) => span.end - span.start + 1 <= Math.max(options.minSize * 2, 4))
      .sort((a, b) => b.spikeScore - a.spikeScore)
      .slice(0, options.topSpans)
      .map(redactSpan),
    allVisited: [...visited.values()].sort((a, b) => b.spikeScore - a.spikeScore).slice(0, 80).map(redactSpan),
  };
}

function redactSpan(span: Span) {
  return {
    start: span.start,
    end: span.end,
    size: span.end - span.start + 1,
    messageRefs: [`m${String(span.start).padStart(4, "0")}`, `m${String(span.end).padStart(4, "0")}`],
    depth: span.depth,
    dominant: span.dominant,
    spikeScore: span.spikeScore,
    scores: span.scores,
    reason: span.reason,
    parent: span.parent,
  };
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}

async function main() {
  const options = args();
  const conversation = loadConversation(options.conversationIndex, options.maxMessages);
  const result = {
    generatedAt: new Date().toISOString(),
    conversationId: conversation.id,
    messageCount: conversation.messages.length,
    privacy: "Raw private message text was read locally for scoring but is not persisted; spans use message refs only.",
    options,
    ...(await zoom(conversation.messages, options)),
  };
  writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        out: options.out,
        conversationId: result.conversationId,
        messageCount: result.messageCount,
        topPivotal: result.pivotal.slice(0, 8).map((span) => ({
          refs: span.messageRefs,
          size: span.size,
          dominant: span.dominant,
          spikeScore: span.spikeScore,
        })),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
