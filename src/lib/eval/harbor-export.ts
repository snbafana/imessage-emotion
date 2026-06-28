import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EKMAN_ANCHORS } from '../emotion/anchors'
import { getLabelingWindow, listLabelingWindows } from '../api/labels'
import type { AppDatabase } from '../db/schema'
import type { LabelingWindowDetail, WindowLabel, WindowMessage } from '../api/types'

// A single file in a generated Harbor task directory.
export interface HarborFile {
  path: string // relative to the task directory
  content: string
  executable?: boolean
}

export interface HarborTask {
  taskId: string
  files: HarborFile[]
}

export interface ExportedTask {
  taskId: string
  dir: string
  fileCount: number
}

// Where generated tasks land. Override with HARBOR_EVAL_DIR. Defaults to
// <repo>/evals/harbor/tasks (gitignored — tasks contain real message text).
export function harborTasksDir(): string {
  return process.env.HARBOR_EVAL_DIR ?? join(process.cwd(), 'evals', 'harbor', 'tasks')
}

/**
 * Turn one human-labeled window into a Harbor task that evaluates the emotion
 * scorer. The agent-under-test must read the window's messages and write
 * `/app/result.json` (Ekman-7 scores + dominant); the verifier grades that
 * output against the human gold label, deterministically and with an LLM judge.
 *
 * Pure (no I/O) so it is unit-testable; `exportLabeledWindow` writes the result.
 */
export function buildHarborTask(detail: LabelingWindowDetail): HarborTask {
  const label = detail.label
  if (!label) {
    throw new Error(`Window ${detail.window.id} has no human label; cannot build an eval task`)
  }
  const taskId = `window-${detail.window.id}`
  const gold = goldRecord(detail, label)

  return {
    taskId,
    files: [
      { path: 'instruction.md', content: instructionMarkdown(detail) },
      { path: 'task.toml', content: TASK_TOML },
      { path: 'environment/Dockerfile', content: DOCKERFILE },
      { path: 'solution/solve.sh', content: solveScript(gold), executable: true },
      { path: 'tests/test.sh', content: TEST_SH, executable: true },
      { path: 'tests/gold.json', content: JSON.stringify(gold, null, 2) + '\n' },
      { path: 'tests/llm_judge.py', content: LLM_JUDGE_PY },
    ],
  }
}

export function exportLabeledWindow(
  db: AppDatabase,
  windowId: number,
  labeler?: string,
  baseDir = harborTasksDir(),
): ExportedTask {
  const detail = getLabelingWindow(db, windowId, labeler)
  if (!detail) throw new Error(`Window ${windowId} was not found`)
  const task = buildHarborTask(detail)
  return writeTask(task, baseDir)
}

export function exportAllLabeledWindows(
  db: AppDatabase,
  labeler?: string,
  baseDir = harborTasksDir(),
): { dir: string; count: number; taskIds: string[] } {
  const labeled = listLabelingWindows(db, { labeler, limit: 500 }).filter((item) => item.label)
  const taskIds: string[] = []
  for (const summary of labeled) {
    taskIds.push(exportLabeledWindow(db, summary.window.id, labeler, baseDir).taskId)
  }
  return { dir: baseDir, count: taskIds.length, taskIds }
}

function writeTask(task: HarborTask, baseDir: string): ExportedTask {
  const dir = join(baseDir, task.taskId)
  for (const file of task.files) {
    const fullPath = join(dir, file.path)
    mkdirSync(join(fullPath, '..'), { recursive: true })
    writeFileSync(fullPath, file.content, { mode: file.executable ? 0o755 : 0o644 })
  }
  return { taskId: task.taskId, dir, fileCount: task.files.length }
}

// --- gold label payload (read by the verifier, never shown to the agent) ---

interface GoldRecord {
  windowId: number
  conversationTitle: string
  anchors: readonly string[]
  dominant: string | null
  acceptableDominants: string[]
  scores: Record<string, number>
  requiresContext: boolean | null
  sarcasmOrSubtext: boolean | null
  ambiguity: string | null
  notes: string | null
  focalText: string
}

function goldRecord(detail: LabelingWindowDetail, label: WindowLabel): GoldRecord {
  return {
    windowId: detail.window.id,
    conversationTitle: detail.conversation.title,
    anchors: EKMAN_ANCHORS,
    dominant: label.dominant,
    acceptableDominants: label.acceptableDominants,
    scores: label.scores as Record<string, number>,
    requiresContext: label.requiresContext,
    sarcasmOrSubtext: label.sarcasmOrSubtext,
    ambiguity: label.ambiguity,
    notes: label.notes,
    focalText: renderMessages(detail.focalMessages),
  }
}

function instructionMarkdown(detail: LabelingWindowDetail): string {
  const anchors = EKMAN_ANCHORS.join(', ')
  return `# Score the emotional tone of a conversation window

You are an emotion scorer. Read the iMessage conversation window below and rate
the emotional tone of the **focal** messages, using the **context** messages
only for grounding.

Write your answer as JSON to \`/app/result.json\` with exactly this shape:

\`\`\`json
{
  "scores": { "anger": 0.0, "disgust": 0.0, "fear": 0.0, "joy": 0.0, "neutral": 0.0, "sadness": 0.0, "surprise": 0.0 },
  "dominant": "<one anchor>",
  "confidence": 0.0,
  "rationale": "one sentence explaining the dominant emotion"
}
\`\`\`

- Use the Ekman-7 anchors: ${anchors}.
- Each score is 0..1 and they need not sum to 1.
- \`dominant\` is the single anchor that best describes the focal messages.

## Context (earlier messages, for grounding)

${renderMessages(detail.contextMessages) || '_(no context messages)_'}

## Focal messages (score these)

${renderMessages(detail.focalMessages) || '_(no focal messages)_'}
`
}

function renderMessages(messages: WindowMessage[]): string {
  return messages
    .map((message) => {
      const sender = message.isFromMe ? 'Me' : message.senderName ?? 'Them'
      const text = (message.text ?? '').replace(/\r?\n/g, ' ').trim() || '[attachment or empty]'
      return `- #${message.conversationOrdinal} ${sender}: ${text}`
    })
    .join('\n')
}

const TASK_TOML = `# Harbor task: emotion-scorer accuracy vs a human gold label.
[verifier]
timeout_sec = 300.0

[verifier.env]
# LLM-as-a-judge provider. Defaults to OpenAI (matches the app's scorer creds).
# Set OPENAI_API_KEY on the host; the judge is skipped if it is unset.
OPENAI_API_KEY = "\${OPENAI_API_KEY}"
OPENAI_BASE_URL = "\${OPENAI_BASE_URL}"
JUDGE_MODEL = "gpt-4.1-mini"
`

const DOCKERFILE = `FROM python:3.12-slim
RUN pip install --no-cache-dir "openai>=1.0" "pydantic>=2.0"
WORKDIR /app
`

const TEST_SH = `#!/bin/bash
set -euo pipefail
python /tests/llm_judge.py
`

function solveScript(gold: GoldRecord): string {
  const scores = Object.fromEntries(
    EKMAN_ANCHORS.map((anchor) => {
      const labeled = gold.scores[anchor]
      if (typeof labeled === 'number') return [anchor, labeled]
      // No per-anchor scores were labeled: peak the dominant anchor.
      return [anchor, anchor === gold.dominant ? 1 : 0]
    }),
  )
  const result = {
    scores,
    dominant: gold.dominant ?? 'neutral',
    confidence: 1,
    rationale: 'oracle: human gold label',
  }
  return `#!/bin/bash
set -euo pipefail
cat > /app/result.json <<'JSON'
${JSON.stringify(result, null, 2)}
JSON
`
}

// The verifier: deterministic metrics + optional LLM-as-a-judge, written to
// /logs/verifier/reward.json as named metrics (Harbor format).
const LLM_JUDGE_PY = `import json
import os
import pathlib

ANCHORS = ["anger", "disgust", "fear", "joy", "neutral", "sadness", "surprise"]
REWARD_PATH = pathlib.Path("/logs/verifier/reward.json")


def load_json(path, default):
    try:
        return json.loads(pathlib.Path(path).read_text())
    except Exception:
        return default


def write_reward(metrics):
    REWARD_PATH.parent.mkdir(parents=True, exist_ok=True)
    REWARD_PATH.write_text(json.dumps(metrics, indent=2))
    print(json.dumps(metrics, indent=2))


def clamp01(value):
    try:
        return max(0.0, min(1.0, float(value)))
    except Exception:
        return 0.0


def main():
    result = load_json("/app/result.json", None)
    gold = load_json("/tests/gold.json", {})

    if not isinstance(result, dict):
        write_reward({"reward": 0.0, "error": "missing or invalid /app/result.json"})
        return

    pred_dominant = result.get("dominant")
    pred_scores = result.get("scores") or {}
    gold_dominant = gold.get("dominant")
    acceptable = set(gold.get("acceptableDominants") or [])
    if gold_dominant:
        acceptable.add(gold_dominant)

    # Deterministic metrics.
    dominant_exact = 1.0 if pred_dominant and pred_dominant == gold_dominant else 0.0
    dominant_acceptable = 1.0 if pred_dominant in acceptable else 0.0

    gold_scores = gold.get("scores") or {}
    graded = [a for a in ANCHORS if isinstance(gold_scores.get(a), (int, float))]
    score_agreement = None
    if graded:
        err = sum(abs(clamp01(pred_scores.get(a, 0)) - clamp01(gold_scores[a])) for a in graded)
        score_agreement = round(1.0 - err / len(graded), 4)

    metrics = {
        "dominant_exact": dominant_exact,
        "dominant_acceptable": dominant_acceptable,
    }
    if score_agreement is not None:
        metrics["score_agreement"] = score_agreement

    judge = run_llm_judge(gold, result)
    if judge is not None:
        metrics.update(judge)

    # Primary reward: the LLM judge if available, else acceptable-dominant match.
    metrics["reward"] = round(metrics.get("judge_overall", dominant_acceptable), 4)
    write_reward(metrics)


def run_llm_judge(gold, result):
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        return None
    try:
        from openai import OpenAI
        from pydantic import BaseModel, Field
    except Exception:
        return None

    class Verdict(BaseModel):
        dominant_correctness: float = Field(ge=0.0, le=1.0)
        calibration: float = Field(ge=0.0, le=1.0)
        rationale_quality: float = Field(ge=0.0, le=1.0)
        overall: float = Field(ge=0.0, le=1.0)
        reasoning: str

    client = OpenAI(api_key=api_key, base_url=os.environ.get("OPENAI_BASE_URL") or None)
    model = os.environ.get("JUDGE_MODEL", "gpt-4.1-mini")
    prompt = (
        "You grade an emotion scorer against a human expert's gold label.\\n\\n"
        "Focal messages:\\n" + str(gold.get("focalText", "")) + "\\n\\n"
        "Expert label: dominant=" + str(gold.get("dominant")) +
        ", also-acceptable=" + str(gold.get("acceptableDominants")) +
        ", sarcasm/subtext=" + str(gold.get("sarcasmOrSubtext")) +
        ", ambiguity=" + str(gold.get("ambiguity")) +
        ", notes=" + str(gold.get("notes")) + "\\n\\n"
        "Model output: dominant=" + str(result.get("dominant")) +
        ", scores=" + json.dumps(result.get("scores") or {}) +
        ", rationale=" + str(result.get("rationale")) + "\\n\\n"
        "Score 0..1: dominant_correctness (does the model's dominant match the "
        "expert's intent, crediting acceptable alternatives), calibration (are the "
        "scores reasonable, incl. sarcasm/ambiguity), rationale_quality, and an "
        "overall. Give one sentence of reasoning."
    )
    try:
        completion = client.beta.chat.completions.parse(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            response_format=Verdict,
        )
        v = completion.choices[0].message.parsed
        return {
            "judge_dominant_correctness": round(v.dominant_correctness, 4),
            "judge_calibration": round(v.calibration, 4),
            "judge_rationale_quality": round(v.rationale_quality, 4),
            "judge_overall": round(v.overall, 4),
        }
    except Exception as exc:
        print("judge failed:", exc)
        return None


if __name__ == "__main__":
    main()
`
