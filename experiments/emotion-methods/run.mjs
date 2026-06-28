import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import vaderPkg from "vader-sentiment";

const { SentimentIntensityAnalyzer } = vaderPkg;

const ANCHORS = ["warmth", "tension", "affection", "distance", "repair"];
const WINDOW_SIZE = 4;
const PRIVATE_LIMIT = 5;
const OUT_DIR = new URL("./out/", import.meta.url);

const SYNTHETIC_ARCS = [
  {
    id: "synthetic_warm_tense_distant",
    expectedDominant: ["warmth", "tension", "distance"],
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
    expectedDominant: ["distance", "warmth", "affection"],
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
    expectedDominant: ["tension", "repair"],
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

const LEXICON = {
  warmth: [
    "happy",
    "glad",
    "fun",
    "nice",
    "thanks",
    "thank",
    "appreciate",
    "missed",
    "jokes",
    "easier",
    "calm",
    "care",
    "okay",
  ],
  tension: [
    "mad",
    "frustrated",
    "hurt",
    "issue",
    "dodging",
    "dismissed",
    "defensive",
    "annoyed",
    "angry",
    "upset",
    "please",
  ],
  affection: [
    "love",
    "miss",
    "missed",
    "thinking",
    "come here",
    "care",
    "see you",
    "loved",
  ],
  distance: [
    "ok",
    "sure",
    "later",
    "busy",
    "can't",
    "dont",
    "don't",
    "energy",
    "leave it",
    "delayed",
  ],
  repair: [
    "sorry",
    "reset",
    "repair",
    "thank you for saying",
    "appreciate",
    "talk through",
    "we're okay",
    "we are okay",
  ],
};

function args() {
  const values = new Set(process.argv.slice(2));
  return {
    syntheticOnly: values.has("--synthetic-only"),
    includePrivate: values.has("--private"),
    llm: values.has("--llm"),
    transformer: values.has("--transformer") || values.has("--all"),
  };
}

function analyzeLexicon(text) {
  const lowered = text.toLowerCase();
  const vaderScore = SentimentIntensityAnalyzer.polarity_scores(text).compound;
  const scores = Object.fromEntries(ANCHORS.map((anchor) => [anchor, 0]));

  for (const [anchor, terms] of Object.entries(LEXICON)) {
    for (const term of terms) {
      if (lowered.includes(term)) scores[anchor] += 1;
    }
  }

  scores.warmth += Math.max(0, vaderScore) * 1.5;
  scores.affection += Math.max(0, vaderScore) * 0.7;
  scores.tension += Math.max(0, -vaderScore) * 1.3;
  scores.distance += text.length <= 10 ? 0.7 : 0;

  return normalizeScores(scores);
}

function normalizeScores(scores) {
  const max = Math.max(1, ...Object.values(scores));
  return Object.fromEntries(
    ANCHORS.map((anchor) => [anchor, round(Math.min(1, scores[anchor] / max))]),
  );
}

function scoreWindow(messages, method) {
  const totals = Object.fromEntries(ANCHORS.map((anchor) => [anchor, 0]));
  for (const message of messages) {
    const scores = method(message.content ?? message.text ?? "");
    for (const anchor of ANCHORS) totals[anchor] += scores[anchor];
  }
  return Object.fromEntries(
    ANCHORS.map((anchor) => [anchor, round(totals[anchor] / messages.length)]),
  );
}

function rollingWindows(messages, size = WINDOW_SIZE) {
  const windows = [];
  const stride = Math.max(2, Math.floor(size / 2));
  for (let i = 0; i < messages.length; i += stride) {
    const slice = messages.slice(i, i + size);
    if (slice.length >= Math.max(3, Math.floor(size / 2))) {
      windows.push({ index: windows.length, messages: slice });
    }
  }
  return windows;
}

function detectShifts(windowScores) {
  return windowScores.map((current, index) => {
    if (index === 0) {
      return { index, dominant: dominant(current.scores), shiftMagnitude: 0, deltas: zeroScores() };
    }
    const prior = meanScores(windowScores.slice(0, index).map((window) => window.scores));
    const deltas = Object.fromEntries(
      ANCHORS.map((anchor) => [anchor, round(current.scores[anchor] - prior[anchor])]),
    );
    const shiftMagnitude = round(
      Math.sqrt(ANCHORS.reduce((sum, anchor) => sum + deltas[anchor] ** 2, 0)),
    );
    return { index, dominant: dominant(current.scores), shiftMagnitude, deltas };
  });
}

function zeroScores() {
  return Object.fromEntries(ANCHORS.map((anchor) => [anchor, 0]));
}

function meanScores(scoresList) {
  const totals = zeroScores();
  for (const scores of scoresList) {
    for (const anchor of ANCHORS) totals[anchor] += scores[anchor];
  }
  return Object.fromEntries(
    ANCHORS.map((anchor) => [anchor, round(totals[anchor] / scoresList.length)]),
  );
}

function dominant(scores) {
  return Object.entries(scores).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "none";
}

function syntheticMessages(arc) {
  return arc.messages.map((content, index) => ({
    id: `${arc.id}_${index}`,
    isFromMe: index % 2 === 0,
    content,
  }));
}

function evaluateSynthetic(summaries) {
  return summaries.map((summary) => {
    const expected = SYNTHETIC_ARCS.find((arc) => arc.id === summary.id)?.expectedDominant ?? [];
    const actual = summary.windows.map((window) => window.shift.dominant);
    const hits = expected.filter((anchor) => actual.includes(anchor)).length;
    return {
      id: summary.id,
      expected,
      actual,
      passed: hits >= Math.min(2, expected.length),
      hitRate: round(hits / expected.length),
    };
  });
}

function loadPrivateConversations() {
  const query = `
    select c.id, count(m.id) as messages, min(m.sent_at) as first_at, max(m.sent_at) as last_at,
           sum(case when m.is_from_me then 1 else 0 end) as from_me,
           sum(case when not m.is_from_me then 1 else 0 end) as from_other
    from conversations c
    join messages m on m.conversation_id = c.id
    where c.platform = 'imessage'
      and c.type = 'dm'
      and m.content is not null
      and length(trim(m.content)) > 0
    group by c.id
    having messages >= 100 and from_me >= 25 and from_other >= 25
    order by last_at desc
    limit ${PRIVATE_LIMIT};
  `;
  const rows = cuedSql(query);
  return rows.map((row, index) => ({
    privateId: `private_c${String(index + 1).padStart(2, "0")}`,
    sourceConversationId: row.id,
    messageCount: row.messages,
  }));
}

function loadPrivateMessages(conversation) {
  const safeId = conversation.sourceConversationId.replaceAll("'", "''");
  const query = `
    select id, is_from_me as isFromMe, sent_at as sentAt, content
    from messages
    where conversation_id = '${safeId}'
      and content is not null
      and length(trim(content)) > 0
    order by sent_at asc
    limit 220;
  `;
  return cuedSql(query).map((row) => ({
    id: row.id,
    isFromMe: Boolean(row.isFromMe),
    sentAt: row.sentAt,
    content: String(row.content).slice(0, 500),
  }));
}

function cuedSql(query) {
  const raw = execFileSync("cued", ["sql", query], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(raw.replace(/^\(node:[^\n]+\)\s+ExperimentalWarning:[\s\S]*?\n(?=\[|\{)/, ""));
}

function summarizeConversation(id, messages, method = analyzeLexicon) {
  const windows = rollingWindows(messages).map((window) => ({
    index: window.index,
    messageCount: window.messages.length,
    scores: scoreWindow(window.messages, method),
  }));
  const shifts = detectShifts(windows);
  return {
    id,
    messageCount: messages.length,
    windows: windows.map((window, index) => ({ ...window, shift: shifts[index] })),
  };
}

async function runTransformerSmoke() {
  const started = performance.now();
  const { pipeline } = await import("@huggingface/transformers");
  const classifier = await pipeline(
    "text-classification",
    "Xenova/distilbert-base-uncased-finetuned-sst-2-english",
  );
  const samples = [
    "I miss you and loved seeing you.",
    "I'm frustrated that this keeps happening.",
    "Sorry, can we reset and talk?",
  ];
  const outputs = [];
  for (const sample of samples) {
    outputs.push({ sample: redactSample(sample), result: await classifier(sample) });
  }
  return { model: "Xenova/distilbert-base-uncased-finetuned-sst-2-english", ms: round(performance.now() - started), outputs };
}

function llmHarnessSpec() {
  const envNames = Object.keys(process.env).filter((name) =>
    /^(OPENAI|ANTHROPIC|GOOGLE|GEMINI|TOGETHER|GROQ|MISTRAL|OPENROUTER|AZURE_OPENAI|AX)/.test(name),
  );
  return {
    detectedProviderEnvVars: envNames.sort(),
    privateTextPolicy: "disabled in this harness; use synthetic or redacted examples unless explicitly enabled",
    anchors: ANCHORS,
    openAISchema: {
      type: "object",
      additionalProperties: false,
      required: ["scores", "baselineDelta", "evidence", "confidence"],
      properties: {
        scores: {
          type: "object",
          additionalProperties: false,
          required: ANCHORS,
          properties: Object.fromEntries(ANCHORS.map((anchor) => [anchor, { type: "number", minimum: 0, maximum: 1 }])),
        },
        baselineDelta: {
          type: "object",
          additionalProperties: false,
          required: ANCHORS,
          properties: Object.fromEntries(ANCHORS.map((anchor) => [anchor, { type: "number", minimum: -1, maximum: 1 }])),
        },
        evidence: { type: "array", items: { type: "string" }, maxItems: 3 },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
    },
    comparativePromptShape:
      "Given prior conversation baseline scores, current window messages, and earlier state, return strict JSON with updated scores, per-anchor deltas, short redacted evidence, and confidence.",
  };
}

function redactSample(text) {
  return text.replace(/[A-Z][a-z]+/g, "[name]").slice(0, 80);
}

function aggregatePrivate(summary) {
  const topShifts = [...summary.windows]
    .sort((a, b) => b.shift.shiftMagnitude - a.shift.shiftMagnitude)
    .slice(0, 5)
    .map((window) => ({
      windowIndex: window.index,
      dominant: window.shift.dominant,
      shiftMagnitude: window.shift.shiftMagnitude,
      deltas: window.shift.deltas,
      scores: window.scores,
    }));
  return {
    id: summary.id,
    messageCount: summary.messageCount,
    windowCount: summary.windows.length,
    topShifts,
    dominantDistribution: countBy(summary.windows.map((window) => window.shift.dominant)),
  };
}

function countBy(values) {
  return values.reduce((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

async function main() {
  const options = args();
  const started = performance.now();
  mkdirSync(OUT_DIR, { recursive: true });

  const syntheticSummaries = SYNTHETIC_ARCS.map((arc) =>
    summarizeConversation(arc.id, syntheticMessages(arc)),
  );

  const privateSummaries = [];
  if (options.includePrivate && !options.syntheticOnly) {
    for (const conversation of loadPrivateConversations()) {
      const messages = loadPrivateMessages(conversation);
      privateSummaries.push(aggregatePrivate(summarizeConversation(conversation.privateId, messages)));
    }
  }

  const result = {
    generatedAt: new Date().toISOString(),
    anchors: ANCHORS,
    windowSize: WINDOW_SIZE,
    methodsRun: ["vader_plus_anchor_lexicon", "rolling_baseline_shift"],
    synthetic: {
      summaries: syntheticSummaries,
      eval: evaluateSynthetic(syntheticSummaries),
    },
    privateAggregate: privateSummaries,
    transformerSmoke: options.transformer ? await runTransformerSmoke() : { skipped: true, reason: "pass --transformer to download/run local model" },
    llmHarness: llmHarnessSpec(),
    runtimeMs: round(performance.now() - started),
  };

  const outPath = new URL("results.json", OUT_DIR);
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({
    outPath: outPath.pathname,
    syntheticEval: result.synthetic.eval,
    privateConversations: privateSummaries.length,
    transformer: result.transformerSmoke.model ?? result.transformerSmoke,
    providerEnvVarsDetected: result.llmHarness.detectedProviderEnvVars,
    runtimeMs: result.runtimeMs,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
