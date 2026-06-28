import { writeFileSync, mkdirSync } from "node:fs";
import { ax, ai } from "@ax-llm/ax";

const OUT_DIR = new URL("./out/", import.meta.url);

const anchors = [
  "warmth_affection",
  "joy_playfulness",
  "stress_anxiety",
  "anger_friction",
  "sadness_distance",
  "neutral_logistical",
];

const signature = `
  baselineJson:string "Prior conversation-specific baseline scores as JSON",
  windowText:string "Conversation message window with speaker direction"
  ->
  scoresJson:string "Strict JSON with scores for ${anchors.join(", ")}, baselineDelta, confidence, stateLabel, evidence"
`;

function providerEnv() {
  return Object.keys(process.env)
    .filter((name) => /^(OPENAI|ANTHROPIC|GOOGLE|GEMINI|TOGETHER|GROQ|MISTRAL|OPENROUTER|AZURE_OPENAI|AX)/.test(name))
    .sort();
}

function llm() {
  if (process.env.OPENAI_APIKEY || process.env.OPENAI_API_KEY) {
    return ai({ name: "openai", apiKey: process.env.OPENAI_APIKEY ?? process.env.OPENAI_API_KEY });
  }
  if (process.env.ANTHROPIC_APIKEY || process.env.ANTHROPIC_API_KEY) {
    return ai({ name: "anthropic", apiKey: process.env.ANTHROPIC_APIKEY ?? process.env.ANTHROPIC_API_KEY });
  }
  if (process.env.GOOGLE_APIKEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY) {
    return ai({ name: "google-gemini", apiKey: process.env.GOOGLE_APIKEY ?? process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY });
  }
  return null;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const scorer = ax(signature);
  const service = llm();
  const result = {
    generatedAt: new Date().toISOString(),
    providerEnvVarsDetected: providerEnv(),
    signature,
    recommendation: "Ax is a practical TypeScript DSPy-style wrapper when multi-provider support or signature optimization is needed. For V1, direct OpenAI structured outputs are still less code if only one provider is used.",
    run: { skipped: "No supported provider API key found" },
  };

  if (service) {
    const started = performance.now();
    const output = await scorer.forward(service, {
      baselineJson: JSON.stringify(Object.fromEntries(anchors.map((anchor) => [anchor, 0.2]))),
      windowText: "me: Loved seeing you today.\nthem: Same, I missed this.\nme: Let's do this again soon.",
    });
    result.run = {
      latencyMs: Math.round((performance.now() - started) * 10) / 10,
      parseableJson: typeof output.scoresJson === "string" && output.scoresJson.trim().startsWith("{"),
    };
  }

  const outPath = new URL("ax-method-results.json", OUT_DIR);
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ outPath: outPath.pathname, run: result.run, providerEnvVarsDetected: result.providerEnvVarsDetected }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
