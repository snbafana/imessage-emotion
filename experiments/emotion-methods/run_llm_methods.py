import argparse
import json
import math
import os
import re
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

from run_python_methods import (
    ANCHORS,
    STRIDE,
    SYNTHETIC_ARCS,
    WINDOW_SIZE,
    collapse_labels,
    dominant,
    load_private_conversations,
    load_private_messages,
    rolling_windows,
    score_features,
    score_vader,
    score_windows,
    shift_rows,
)

OUT_DIR = Path("out")
PROMPT_VERSION = "llm-methods-v1"


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--private", action="store_true")
    parser.add_argument("--local-generative", action="store_true")
    parser.add_argument("--openai", action="store_true")
    parser.add_argument("--dspy", action="store_true")
    parser.add_argument("--agent-trajectory", action="store_true")
    parser.add_argument("--agent-private-conversations", type=int, default=2)
    parser.add_argument("--agent-windows-per-conversation", type=int, default=10)
    parser.add_argument("--agent-whole-conversation", action="store_true")
    parser.add_argument("--quality-audit", action="store_true")
    parser.add_argument("--quality-private-conversations", type=int, default=10)
    parser.add_argument("--quality-windows-per-conversation", type=int, default=4)
    parser.add_argument("--pivotal-audit", action="store_true")
    parser.add_argument("--pivotal-private-conversations", type=int, default=2)
    parser.add_argument("--pivotal-candidates-per-conversation", type=int, default=2)
    parser.add_argument("--pivotal-max-depth", type=int, default=3)
    parser.add_argument("--latency-benchmark", action="store_true")
    parser.add_argument("--latency-models", default="gpt-5-nano,gpt-4.1-nano,gpt-4.1-mini,gpt-5-mini")
    parser.add_argument("--latency-concurrency", default="1,4,8")
    parser.add_argument("--latency-private-conversations", type=int, default=2)
    parser.add_argument("--latency-windows-per-conversation", type=int, default=4)
    parser.add_argument("--batch-benchmark", action="store_true")
    parser.add_argument("--batch-models", default="gpt-4.1-nano,gpt-5-nano:minimal")
    parser.add_argument("--batch-sizes", default="4,8")
    parser.add_argument("--batch-concurrency", type=int, default=2)
    parser.add_argument("--batch-private-conversations", type=int, default=4)
    parser.add_argument("--batch-windows-per-conversation", type=int, default=4)
    return parser.parse_args()


def window_text(messages):
    lines = []
    for message in messages:
        speaker = "me" if message.get("isFromMe") else "them"
        lines.append(f"{speaker}: {message['content']}")
    return "\n".join(lines)[:1800]


def indexed_window_text(messages, start_index=0):
    lines = []
    for offset, message in enumerate(messages, start=start_index):
        speaker = "me" if message.get("isFromMe") else "them"
        lines.append(f"m{offset:04}: {speaker}: {message['content']}")
    return "\n".join(lines)[:2400]


def synthetic_windows():
    rows = []
    for arc in SYNTHETIC_ARCS:
        messages = [{"content": text, "isFromMe": index % 2 == 0} for index, text in enumerate(arc["messages"])]
        for window in rolling_windows(messages):
            rows.append({
                "id": f"{arc['id']}_w{window['index']:02}",
                "kind": "synthetic",
                "arc": arc["id"],
                "text": window_text(window["messages"]),
            })
    return rows


def private_windows(limit_conversations=4, windows_per_conversation=8):
    rows = []
    for conv_index, conversation in enumerate(load_private_conversations()[:limit_conversations], start=1):
        messages = load_private_messages(conversation["id"])
        windows = rolling_windows(messages)
        if len(windows) > windows_per_conversation:
            step = max(1, len(windows) // windows_per_conversation)
            windows = windows[::step][:windows_per_conversation]
        for window in windows:
            rows.append({
                "id": f"private_c{conv_index:02}_w{window['index']:03}",
                "kind": "private",
                "conversation": f"private_c{conv_index:02}",
                "text": window_text(window["messages"]),
            })
    return rows


def score_for_selection(messages):
    feature_rows = shift_rows(score_windows(messages, score_features()))
    vader_rows = shift_rows(score_windows(messages, score_vader()))
    rows = []
    for index, feature in enumerate(feature_rows):
        vader = vader_rows[index] if index < len(vader_rows) else feature
        rows.append({
            "index": feature["index"],
            "shiftMagnitude": max(feature["shiftMagnitude"], vader["shiftMagnitude"]),
            "zMax": max(feature["zMax"], vader["zMax"]),
            "featureDominant": feature["dominant"],
            "vaderDominant": vader["dominant"],
        })
    return rows


def select_windows(messages, windows_per_conversation):
    windows = rolling_windows(messages)
    if len(windows) <= windows_per_conversation:
        return windows, "all_windows"
    keep_indexes = {0, len(windows) - 1}
    ranked = sorted(
        score_for_selection(messages),
        key=lambda row: (row["shiftMagnitude"], row["zMax"]),
        reverse=True,
    )
    for row in ranked:
        keep_indexes.add(row["index"])
        if len(keep_indexes) >= windows_per_conversation:
            break
    return [window for window in windows if window["index"] in keep_indexes], "cheap_shift_prefilter"


def private_conversation_samples(limit_conversations=2, windows_per_conversation=10):
    samples = []
    for conv_index, conversation in enumerate(load_private_conversations(limit_conversations), start=1):
        messages = load_private_messages(conversation["id"])
        windows, selector = select_windows(messages, windows_per_conversation)
        samples.append({
            "id": f"private_c{conv_index:02}",
            "sourceConversationId": conversation["id"],
            "messageCount": len(messages),
            "windowCountTotal": len(rolling_windows(messages)),
            "windowSelector": selector,
            "windows": [
                {
                    "id": f"private_c{conv_index:02}_w{window['index']:03}",
                    "index": window["index"],
                    "startMessageRef": f"m{window['index'] * 4:04}",
                    "endMessageRef": f"m{window['index'] * 4 + len(window['messages']) - 1:04}",
                    "text": indexed_window_text(window["messages"], window["index"] * 4),
                }
                for window in windows
            ],
            "wholeConversationText": "\n".join(
                f"m{index:04}: {'me' if message.get('isFromMe') else 'them'}: {message['content']}"
                for index, message in enumerate(messages[:120])
            )[:12000],
        })
    return samples


def provider_env():
    return sorted(
        name for name in os.environ
        if re.match(r"^(OPENAI|ANTHROPIC|GOOGLE|GEMINI|TOGETHER|GROQ|MISTRAL|OPENROUTER|AZURE_OPENAI|AX)", name)
    )


def llm_method_catalog():
    return [
        {
            "method": "absolute_structured_rating",
            "shape": "window -> per-anchor 0-1 scores + confidence + evidence",
            "bestFor": "cacheable hot-path scoring",
            "risk": "anchor calibration drifts unless prompt/evals are tight",
        },
        {
            "method": "comparative_baseline_update",
            "shape": "prior baseline + current window -> updated scores + deltas",
            "bestFor": "conversation-specific temporal state",
            "risk": "more prompt tokens; must avoid leaking future windows into baseline",
        },
        {
            "method": "pairwise_window_comparison",
            "shape": "window A vs window B -> which is warmer/more tense/etc.",
            "bestFor": "eval labeling, calibration, ranking hard examples",
            "risk": "O(n log n) or O(n^2) if used for full timeline; not ideal hot path",
        },
        {
            "method": "ordinal_bucket_rating",
            "shape": "very low/low/medium/high/very high per anchor then map to numbers",
            "bestFor": "more stable human-like ratings than arbitrary decimals",
            "risk": "lower resolution; needs tie handling",
        },
        {
            "method": "rubric_then_score",
            "shape": "apply explicit examples/rubric, then output JSON scores",
            "bestFor": "reducing label ambiguity",
            "risk": "more prompt tokens; rubric can overfit synthetic cases",
        },
        {
            "method": "self_consistency_vote",
            "shape": "run N low-temperature scorers, aggregate median",
            "bestFor": "quality audit or high-value recalculation",
            "risk": "cost/latency multiplier; not V1 default",
        },
        {
            "method": "critique_repair_json",
            "shape": "score -> validate -> critique inconsistencies -> corrected score",
            "bestFor": "batch recalculation and eval data generation",
            "risk": "adds latency and moving parts",
        },
        {
            "method": "retrieval_augmented_cause_explanation",
            "shape": "retrieve shift windows + before/after evidence -> causal explanation",
            "bestFor": "chat over analysis and why explanations",
            "risk": "not a scorer; must cite local message IDs instead of transcripts",
        },
        {
            "method": "dspy_predict",
            "shape": "typed signature: window, baseline -> scores_json, label, confidence",
            "bestFor": "Python experiments and optimizable prompting",
            "risk": "Python runtime/provider dependency; not Electron-native",
        },
        {
            "method": "dspy_chain_of_thought",
            "shape": "same signature with rationale field",
            "bestFor": "debugging calibration and synthetic evals",
            "risk": "do not persist private rationales unless redacted",
        },
        {
            "method": "dspy_rlm",
            "shape": "large conversation context + query -> analysis",
            "bestFor": "long-context chat/explanation over full relationship history",
            "risk": "overkill and expensive for 8-message scoring windows",
        },
        {
            "method": "ax_signature",
            "shape": "TypeScript DSPy-like signature with typed fields",
            "bestFor": "Electron app implementation if using provider abstraction",
            "risk": "extra abstraction before multi-provider is proven",
        },
    ]


def prompt_templates():
    anchors = ", ".join(ANCHORS)
    return {
        "absolute_structured_rating": (
            f"Rate the emotional state of this message window for anchors: {anchors}. "
            "Use 0.0 to 1.0. Return compact JSON with keys scores, confidence, state_label, evidence."
        ),
        "comparative_baseline_update": (
            f"Given prior baseline scores and the current message window, update anchors: {anchors}. "
            "Return JSON with scores, baseline_delta, confidence, state_label, evidence. "
            "Deltas should compare current window against the prior conversation-specific baseline."
        ),
        "pairwise_window_comparison": (
            f"Compare two windows on anchors: {anchors}. Return JSON with warmer_window, more_tense_window, "
            "more_distant_window, confidence, and short evidence."
        ),
        "ordinal_bucket_rating": (
            f"Assign each anchor one of none, low, medium, high for: {anchors}. "
            "Return JSON with buckets, dominant_anchor, confidence, evidence."
        ),
    }


def local_generative_smoke(windows):
    import torch
    from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

    started = time.perf_counter()
    model_name = "google/flan-t5-small"
    tokenizer = AutoTokenizer.from_pretrained(model_name)
    model = AutoModelForSeq2SeqLM.from_pretrained(model_name)
    model.eval()
    load_ms = round((time.perf_counter() - started) * 1000, 1)
    rows = []
    prompts = prompt_templates()
    for item in windows[:10]:
        prompt = (
            prompts["ordinal_bucket_rating"]
            + "\nWindow:\n"
            + item["text"]
            + "\nJSON:"
        )
        infer_started = time.perf_counter()
        encoded = tokenizer(prompt, return_tensors="pt", truncation=True, max_length=512)
        with torch.no_grad():
            generated = model.generate(**encoded, max_new_tokens=120, do_sample=False)
        output = tokenizer.decode(generated[0], skip_special_tokens=True)
        rows.append({
            "id": item["id"],
            "kind": item["kind"],
            "prompt": "ordinal_bucket_rating",
            "parseableJson": looks_like_json(output),
            "redactedOutput": redact_output(output) if item["kind"] != "private" else "[omitted for private window]",
            "inferMs": round((time.perf_counter() - infer_started) * 1000, 1),
        })
    return {"model": model_name, "loadMs": load_ms, "rows": rows}


def looks_like_json(text):
    text = text.strip()
    if not (text.startswith("{") and text.endswith("}")):
        return False
    try:
        json.loads(text)
        return True
    except json.JSONDecodeError:
        return False


def redact_output(text):
    return re.sub(r"\b[A-Z][a-z]+\b", "[name]", text)[:500]


def run_openai_structured(windows):
    if not os.environ.get("OPENAI_API_KEY"):
        return {"skipped": "OPENAI_API_KEY not set"}
    from openai import OpenAI

    client = OpenAI()
    schema = {
        "type": "object",
        "additionalProperties": False,
        "required": ["scores", "confidence", "state_label", "evidence"],
        "properties": {
            "scores": {
                "type": "object",
                "additionalProperties": False,
                "required": ANCHORS,
                "properties": {anchor: {"type": "number", "minimum": 0, "maximum": 1} for anchor in ANCHORS},
            },
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            "state_label": {"type": "string"},
            "evidence": {"type": "array", "items": {"type": "string"}, "maxItems": 3},
        },
    }
    rows = []
    for item in [w for w in windows if w["kind"] == "synthetic"][:6]:
        started = time.perf_counter()
        response = client.responses.create(
            model=os.environ.get("OPENAI_MODEL", "gpt-5-mini"),
            input=[
                {"role": "system", "content": "You score text windows for relationship emotion analysis. Return only structured data."},
                {"role": "user", "content": prompt_templates()["absolute_structured_rating"] + "\nWindow:\n" + item["text"]},
            ],
            text={
                "format": {
                    "type": "json_schema",
                    "name": "emotion_window_score",
                    "schema": schema,
                    "strict": True,
                }
            },
        )
        rows.append({"id": item["id"], "latencyMs": round((time.perf_counter() - started) * 1000, 1), "outputText": response.output_text})
    return {"model": os.environ.get("OPENAI_MODEL", "gpt-5-mini"), "rows": rows}


def run_dspy_methods(windows):
    if not os.environ.get("OPENAI_API_KEY"):
        return {"skipped": "OPENAI_API_KEY not set"}
    import dspy

    dspy.configure(lm=dspy.LM(os.environ.get("DSPY_MODEL", "openai/gpt-5-mini"), temperature=None, max_tokens=None))

    class EmotionWindowScore(dspy.Signature):
        """Score a conversation message window for relationship emotion anchors. Output compact JSON."""

        anchors: str = dspy.InputField()
        baseline_json: str = dspy.InputField()
        window_text: str = dspy.InputField()
        scores_json: str = dspy.OutputField(desc="JSON object with scores, baselineDelta, confidence, stateLabel, evidence")

    predict = dspy.Predict(EmotionWindowScore)
    cot = dspy.ChainOfThought(EmotionWindowScore)
    rows = []
    for item in [w for w in windows if w["kind"] == "synthetic"][:4]:
        for name, program in [("dspy_predict", predict), ("dspy_chain_of_thought", cot)]:
            started = time.perf_counter()
            pred = program(
                anchors=", ".join(ANCHORS),
                baseline_json=json.dumps({anchor: 0.2 for anchor in ANCHORS}),
                window_text=item["text"],
            )
            rows.append({
                "method": name,
                "id": item["id"],
                "latencyMs": round((time.perf_counter() - started) * 1000, 1),
                "parseableJson": looks_like_json(pred.scores_json),
            })
    rlm = {
        "available": hasattr(dspy, "RLM"),
        "denoRequired": True,
        "recommendation": "Use for long-context relationship explanation, not hot-path window scoring.",
    }
    return {"model": os.environ.get("DSPY_MODEL", "openai/gpt-5-mini"), "rows": rows, "rlm": rlm}


def score_schema():
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["scores", "baselineDelta", "confidence", "stateLabel", "evidenceMessageRefs", "notes"],
        "properties": {
            "scores": {
                "type": "object",
                "additionalProperties": False,
                "required": ANCHORS,
                "properties": {anchor: {"type": "number", "minimum": 0, "maximum": 1} for anchor in ANCHORS},
            },
            "baselineDelta": {
                "type": "object",
                "additionalProperties": False,
                "required": ANCHORS,
                "properties": {anchor: {"type": "number", "minimum": -1, "maximum": 1} for anchor in ANCHORS},
            },
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            "stateLabel": {"type": "string"},
            "evidenceMessageRefs": {"type": "array", "items": {"type": "string"}, "maxItems": 4},
            "notes": {"type": "string"},
        },
    }


def batch_score_schema(max_items):
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["rows"],
        "properties": {
            "rows": {
                "type": "array",
                "maxItems": max_items,
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["windowRef", "scores", "baselineDelta", "confidence", "stateLabel", "evidenceMessageRefs", "notes"],
                    "properties": {
                        "windowRef": {"type": "string"},
                        "scores": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ANCHORS,
                            "properties": {anchor: {"type": "number", "minimum": 0, "maximum": 1} for anchor in ANCHORS},
                        },
                        "baselineDelta": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ANCHORS,
                            "properties": {anchor: {"type": "number", "minimum": -1, "maximum": 1} for anchor in ANCHORS},
                        },
                        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                        "stateLabel": {"type": "string"},
                        "evidenceMessageRefs": {"type": "array", "items": {"type": "string"}, "maxItems": 4},
                        "notes": {"type": "string"},
                    },
                },
            },
        },
    }


def trajectory_schema():
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["conversationLabel", "overallTrajectory", "privacyRisk", "phases", "majorShifts", "methodNotes"],
        "properties": {
            "conversationLabel": {"type": "string"},
            "overallTrajectory": {"type": "string"},
            "privacyRisk": {"type": "string"},
            "phases": {
                "type": "array",
                "maxItems": 8,
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["phaseLabel", "startWindowRef", "endWindowRef", "dominantAnchors", "summaryCategory"],
                    "properties": {
                        "phaseLabel": {"type": "string"},
                        "startWindowRef": {"type": "string"},
                        "endWindowRef": {"type": "string"},
                        "dominantAnchors": {"type": "array", "items": {"type": "string"}, "maxItems": 3},
                        "summaryCategory": {"type": "string"},
                    },
                },
            },
            "majorShifts": {
                "type": "array",
                "maxItems": 8,
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["windowRef", "shiftLabel", "changedAnchors", "evidenceRefs", "topicCategory"],
                    "properties": {
                        "windowRef": {"type": "string"},
                        "shiftLabel": {"type": "string"},
                        "changedAnchors": {"type": "array", "items": {"type": "string"}, "maxItems": 4},
                        "evidenceRefs": {"type": "array", "items": {"type": "string"}, "maxItems": 6},
                        "topicCategory": {"type": "string"},
                    },
                },
            },
            "methodNotes": {"type": "string"},
        },
    }


def pivotal_schema():
    return {
        "type": "object",
        "additionalProperties": False,
        "required": [
            "shiftPresent",
            "focus",
            "pivotStartRef",
            "pivotEndRef",
            "pivotalMessageRefs",
            "sarcasmOrSubtextRefs",
            "changedAnchors",
            "explanationCategory",
            "confidence",
            "uncertainty",
            "notes",
        ],
        "properties": {
            "shiftPresent": {"type": "boolean"},
            "focus": {"type": "string", "enum": ["left", "right", "center", "done"]},
            "pivotStartRef": {"type": "string"},
            "pivotEndRef": {"type": "string"},
            "pivotalMessageRefs": {"type": "array", "items": {"type": "string"}, "maxItems": 6},
            "sarcasmOrSubtextRefs": {"type": "array", "items": {"type": "string"}, "maxItems": 6},
            "changedAnchors": {"type": "array", "items": {"type": "string"}, "maxItems": 5},
            "explanationCategory": {"type": "string"},
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            "uncertainty": {"type": "string"},
            "notes": {"type": "string"},
        },
    }


def openai_json(client, model, name, schema, system, user, reasoning_effort=None):
    request = {
        "model": model,
        "input": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": name,
                "schema": schema,
                "strict": True,
            }
        },
    }
    if reasoning_effort:
        request["reasoning"] = {"effort": reasoning_effort}
    response = client.responses.create(**request)
    return json.loads(response.output_text)


def average_scores(rows):
    if not rows:
        return {anchor: 0.0 for anchor in ANCHORS}
    return {
        anchor: round(sum(row["scores"][anchor] for row in rows) / len(rows), 3)
        for anchor in ANCHORS
    }


def local_delta(scores, baseline):
    return {
        anchor: round(scores[anchor] - baseline.get(anchor, 0), 3)
        for anchor in ANCHORS
    }


def trajectory_from_window_scores(client, model, conversation):
    score_rows = []
    baseline = {anchor: 0.2 for anchor in ANCHORS}
    for window in conversation["windows"]:
        started = time.perf_counter()
        parsed = openai_json(
            client,
            model,
            "emotion_window_comparative_score",
            score_schema(),
            (
                "You score private iMessage conversation windows for relationship emotion. "
                "Do not quote message text, names, phone numbers, jobs, places, monetary amounts, plans, or concrete private topics in outputs. "
                "Use only local message refs like m0004 as evidence."
            ),
            (
                f"Anchors: {', '.join(ANCHORS)}\n"
                f"Prior baseline JSON: {json.dumps(baseline)}\n"
                "Score the current window relative to that baseline. "
                "Return stateLabel and notes as abstract emotion/interaction labels only. "
                "Allowed topic categories are: logistics, support, conflict, repair, playful, distant, concern, celebration, mixed, unknown. "
                "Do not name the concrete topic.\n\n"
                f"Window {window['id']}:\n{window['text']}"
            ),
        )
        parsed["windowRef"] = window["id"]
        parsed["startMessageRef"] = window["startMessageRef"]
        parsed["endMessageRef"] = window["endMessageRef"]
        parsed["latencyMs"] = round((time.perf_counter() - started) * 1000, 1)
        parsed["dominantAnchor"] = max(parsed["scores"].items(), key=lambda item: item[1])[0]
        parsed["localBaselineDelta"] = local_delta(parsed["scores"], baseline)
        score_rows.append(parsed)
        baseline = average_scores(score_rows[-6:])

    reducer_rows = [
        {
            "windowRef": row["windowRef"],
            "startMessageRef": row["startMessageRef"],
            "endMessageRef": row["endMessageRef"],
            "scores": row["scores"],
            "baselineDelta": row["baselineDelta"],
            "dominantAnchor": row["dominantAnchor"],
            "stateLabel": row["stateLabel"],
            "confidence": row["confidence"],
            "evidenceMessageRefs": row["evidenceMessageRefs"],
        }
        for row in score_rows
    ]
    started = time.perf_counter()
    trajectory = openai_json(
        client,
        model,
        "emotion_trajectory_from_window_scores",
        trajectory_schema(),
        (
            "You synthesize an emotion trajectory from already-scored windows. "
            "Do not quote private message text or invent facts. Use window refs and message refs only. "
            "Summaries must be abstract interaction categories, not concrete private topics."
        ),
        (
            "Build a concise relationship-emotion trajectory from these scored windows. "
            "Group contiguous windows into phases and identify major shifts.\n\n"
            f"Window scores JSON:\n{json.dumps(reducer_rows)}"
        ),
    )
    trajectory["latencyMs"] = round((time.perf_counter() - started) * 1000, 1)
    return {"windowScores": score_rows, "trajectory": trajectory}


def whole_conversation_trajectory(client, model, conversation):
    started = time.perf_counter()
    trajectory = openai_json(
        client,
        model,
        "emotion_trajectory_whole_conversation",
        trajectory_schema(),
        (
            "You analyze a bounded private iMessage conversation excerpt. "
            "Do not quote message text, names, phone numbers, jobs, places, monetary amounts, plans, or concrete private topics. "
            "Use only local message refs like m0032 as evidence."
        ),
        (
            f"Anchors: {', '.join(ANCHORS)}\n"
            "Produce a conversation-level emotional trajectory with phases and major shifts. "
            "Use abstract phase labels, abstract topic categories, and message refs only. "
            "Allowed topic categories are: logistics, support, conflict, repair, playful, distant, concern, celebration, mixed, unknown. "
            "Do not name the concrete topic.\n\n"
            f"Conversation excerpt {conversation['id']}:\n{conversation['wholeConversationText']}"
        ),
    )
    trajectory["latencyMs"] = round((time.perf_counter() - started) * 1000, 1)
    return trajectory


def combine_local_scores(feature_scores, vader_scores):
    return {
        anchor: round((feature_scores[anchor] + vader_scores[anchor]) / 2, 3)
        for anchor in ANCHORS
    }


def local_score_series(conversation):
    messages = load_private_messages(conversation["sourceConversationId"])
    windows = rolling_windows(messages)
    feature_rows = score_windows(messages, score_features())
    vader_rows = score_windows(messages, score_vader())
    rows = []
    for index, window in enumerate(windows):
        feature = feature_rows[index]["scores"]
        vader = vader_rows[index]["scores"]
        scores = combine_local_scores(feature, vader)
        rows.append({
            "windowRef": f"{conversation['id']}_w{window['index']:03}",
            "startMessageRef": f"m{window['index'] * 4:04}",
            "endMessageRef": f"m{window['index'] * 4 + len(window['messages']) - 1:04}",
            "scores": scores,
            "dominantAnchor": max(scores.items(), key=lambda item: item[1])[0],
        })
    shifted = shift_rows([{"index": index, "scores": row["scores"], "dominant": row["dominantAnchor"]} for index, row in enumerate(rows)])
    for row, shift in zip(rows, shifted):
        row["shiftMagnitude"] = shift["shiftMagnitude"]
        row["deltas"] = shift["deltas"]
    return rows


def score_private_window(client, model, window, baseline):
    started = time.perf_counter()
    parsed = openai_json(
        client,
        model,
        "emotion_quality_audit_window_score",
        score_schema(),
        (
            "You score private iMessage windows for relationship emotion quality evaluation. "
            "Return strict JSON only. Do not quote message text, names, phone numbers, jobs, places, monetary amounts, plans, or concrete private topics. "
            "Use only local message refs like m0004 as evidence."
        ),
        (
            f"Anchors: {', '.join(ANCHORS)}\n"
            f"Prior baseline JSON: {json.dumps(baseline)}\n"
            "Score the current window relative to that baseline. "
            "Use stateLabel and notes as abstract interaction labels only, such as logistics, support, playful, conflict, concern, distant, repair, mixed, or unknown.\n\n"
            f"Window {window['id']}:\n{window['text']}"
        ),
    )
    parsed["latencyMs"] = round((time.perf_counter() - started) * 1000, 1)
    parsed["dominantAnchor"] = max(parsed["scores"].items(), key=lambda item: item[1])[0]
    return parsed


def run_quality_audit(args):
    if not os.environ.get("OPENAI_API_KEY"):
        return {"skipped": "OPENAI_API_KEY not set"}
    from openai import OpenAI

    client = OpenAI()
    model = os.environ.get("OPENAI_MODEL", "gpt-5-mini")
    conversations = private_conversation_samples(
        limit_conversations=args.quality_private_conversations,
        windows_per_conversation=args.quality_windows_per_conversation,
    )
    rows = []
    for conversation in conversations:
        local_by_ref = {row["windowRef"]: row for row in local_score_series(conversation)}
        scored_rows = []
        llm_history = []
        for window in conversation["windows"]:
            baseline = average_scores(llm_history[-6:]) if llm_history else {anchor: 0.2 for anchor in ANCHORS}
            parsed = score_private_window(client, model, window, baseline)
            llm_history.append(parsed)
            local = local_by_ref.get(window["id"])
            scored_rows.append({
                "windowRef": window["id"],
                "index": window["index"],
                "llmDominant": parsed["dominantAnchor"],
                "localDominant": local["dominantAnchor"] if local else None,
                "dominantAgree": bool(local and local["dominantAnchor"] == parsed["dominantAnchor"]),
                "confidence": parsed["confidence"],
                "latencyMs": parsed["latencyMs"],
                "evidenceRefCount": len(parsed.get("evidenceMessageRefs", [])),
                "stateLabel": parsed["stateLabel"],
                "notes": parsed["notes"],
                "scores": parsed["scores"],
                "baselineDelta": parsed["baselineDelta"],
                "localShiftMagnitude": local["shiftMagnitude"] if local else None,
            })
        rows.append({
            "id": conversation["id"],
            "messageCount": conversation["messageCount"],
            "windowCountTotal": conversation["windowCountTotal"],
            "windowSelector": conversation["windowSelector"],
            "windowCountSampled": len(scored_rows),
            "windows": scored_rows,
        })

    flat = [window for conversation in rows for window in conversation["windows"]]
    dominant_counts = Counter(row["llmDominant"] for row in flat)
    local_counts = Counter(row["localDominant"] for row in flat if row["localDominant"])
    state_counts = Counter(row["stateLabel"] for row in flat)
    confidences = [row["confidence"] for row in flat]
    latencies = [row["latencyMs"] for row in flat]
    agreement_rows = [row for row in flat if row["localDominant"]]
    avg_scores = {
        anchor: round(sum(row["scores"][anchor] for row in flat) / len(flat), 3)
        for anchor in ANCHORS
    } if flat else {anchor: 0 for anchor in ANCHORS}
    return {
        "model": model,
        "privacy": "Private text was sent to OpenAI for bounded sampled windows; persisted output omits raw text and uses refs/scores only.",
        "conversationCount": len(rows),
        "windowCount": len(flat),
        "selector": "cheap_shift_prefilter",
        "summary": {
            "llmDominantCounts": dict(dominant_counts.most_common()),
            "localDominantCounts": dict(local_counts.most_common()),
            "stateLabelCounts": dict(state_counts.most_common(12)),
            "avgConfidence": round(sum(confidences) / len(confidences), 3) if confidences else None,
            "lowConfidenceCount": sum(1 for value in confidences if value < 0.65),
            "avgLatencyMs": round(sum(latencies) / len(latencies), 1) if latencies else None,
            "p95LatencyMs": round(sorted(latencies)[int(0.95 * (len(latencies) - 1))], 1) if latencies else None,
            "evidenceCoverage": round(sum(1 for row in flat if row["evidenceRefCount"] > 0) / len(flat), 3) if flat else None,
            "agreementWithLocalDominant": round(sum(1 for row in agreement_rows if row["dominantAgree"]) / len(agreement_rows), 3) if agreement_rows else None,
            "avgScores": avg_scores,
        },
        "conversations": rows,
    }


def message_ref(index):
    return f"m{index:04}"


def message_ref_index(ref, default):
    match = re.search(r"m(\d{4})", str(ref))
    return int(match.group(1)) if match else default


def format_indexed_messages(messages, start, end):
    lines = []
    for index in range(start, min(end + 1, len(messages))):
        message = messages[index]
        speaker = "me" if message.get("isFromMe") else "them"
        lines.append(f"{message_ref(index)}: {speaker}: {message['content']}")
    return "\n".join(lines)[:5000]


def candidate_shift_windows(conversation, limit):
    score_rows = local_score_series(conversation)
    ranked = sorted(
        [row for row in score_rows if row["windowRef"] != f"{conversation['id']}_w000"],
        key=lambda row: (row["shiftMagnitude"], max(abs(value) for value in row["deltas"].values())),
        reverse=True,
    )
    return {
        "scoreSource": "local_features_plus_vader_all_windows",
        "windowCountAll": len(score_rows),
        "candidates": ranked[:limit],
    }


def locate_pivotal_span(client, model, messages, candidate, max_depth):
    center_index = int(candidate["windowRef"].split("_w")[-1]) * STRIDE
    span_start = max(0, center_index - 24)
    span_end = min(len(messages) - 1, center_index + WINDOW_SIZE + 24)
    iterations = []

    for _depth in range(max_depth):
        span_size = span_end - span_start + 1
        split_mid = span_start + span_size // 2
        started = time.perf_counter()
        result = openai_json(
            client,
            model,
            "emotion_pivotal_span_locator",
            pivotal_schema(),
            (
                "You locate the smallest pivotal span behind an emotional shift in a private iMessage conversation. "
                "Do not quote private message text, names, phone numbers, jobs, places, monetary amounts, plans, or concrete private topics. "
                "Use only local refs like m0042. Return abstract categories only."
            ),
            (
                f"Anchors: {', '.join(ANCHORS)}\n"
                f"Candidate local shift JSON: {json.dumps(candidate)}\n"
                f"Current search span: {message_ref(span_start)}..{message_ref(span_end)}. "
                f"Left half ends near {message_ref(split_mid)}; right half starts near {message_ref(split_mid + 1)}.\n"
                "Decide whether the pivotal change is in the left half, right half, centered across the boundary, or already sufficiently localized. "
                "Flag sarcasm/subtext refs when relevant. Keep notes abstract and do not quote messages.\n\n"
                f"Messages:\n{format_indexed_messages(messages, span_start, span_end)}"
            ),
        )
        result["latencyMs"] = round((time.perf_counter() - started) * 1000, 1)
        result["spanStartRef"] = message_ref(span_start)
        result["spanEndRef"] = message_ref(span_end)
        iterations.append(result)

        if result["focus"] == "done" or span_size <= 10:
            break
        pivot_start = message_ref_index(result["pivotStartRef"], span_start)
        pivot_end = message_ref_index(result["pivotEndRef"], span_end)
        next_size = max(8, math.ceil(span_size / 2))
        if result["focus"] == "left":
            span_end = min(span_end, split_mid)
        elif result["focus"] == "right":
            span_start = max(span_start, split_mid + 1)
        else:
            midpoint = max(span_start, min(span_end, (pivot_start + pivot_end) // 2))
            span_start = max(0, midpoint - next_size // 2)
            span_end = min(len(messages) - 1, span_start + next_size - 1)

    final = iterations[-1] if iterations else {}
    return {
        "candidateWindowRef": candidate["windowRef"],
        "candidateShiftMagnitude": candidate["shiftMagnitude"],
        "candidateDominantAnchor": candidate["dominantAnchor"],
        "iterations": iterations,
        "final": {
            key: final.get(key)
            for key in [
                "shiftPresent",
                "pivotStartRef",
                "pivotEndRef",
                "pivotalMessageRefs",
                "sarcasmOrSubtextRefs",
                "changedAnchors",
                "explanationCategory",
                "confidence",
                "uncertainty",
                "notes",
            ]
        },
    }


def run_pivotal_audit(args):
    if not os.environ.get("OPENAI_API_KEY"):
        return {"skipped": "OPENAI_API_KEY not set"}
    from openai import OpenAI

    client = OpenAI()
    model = os.environ.get("OPENAI_MODEL", "gpt-5-mini")
    conversations = private_conversation_samples(
        limit_conversations=args.pivotal_private_conversations,
        windows_per_conversation=max(args.pivotal_candidates_per_conversation, 2),
    )
    rows = []
    for conversation in conversations:
        messages = load_private_messages(conversation["sourceConversationId"])
        candidates = candidate_shift_windows(conversation, args.pivotal_candidates_per_conversation)
        rows.append({
            "id": conversation["id"],
            "messageCount": len(messages),
            "windowCountTotal": conversation["windowCountTotal"],
            "candidateGenerator": {
                "method": candidates["scoreSource"],
                "windowCountAll": candidates["windowCountAll"],
                "candidateCount": len(candidates["candidates"]),
            },
            "pivotalSpans": [
                locate_pivotal_span(client, model, messages, candidate, args.pivotal_max_depth)
                for candidate in candidates["candidates"]
            ],
        })
    return {
        "model": model,
        "privacy": "Private text was sent to OpenAI for bounded binary-search spans; persisted output omits raw text and uses refs/categories only.",
        "method": {
            "nonLlmPass": "score every rolling window locally, rank by shiftMagnitude and anchor deltas",
            "llmPass": "zoom search over each candidate span to find minimal pivotal refs, sarcasm/subtext refs, changed anchors, uncertainty",
            "contextPolicy": "LLM receives current bounded span plus candidate local shift JSON, not the entire conversation transcript",
        },
        "conversations": rows,
    }


def flatten_sampled_windows(limit_conversations, windows_per_conversation):
    sampled = []
    for conversation in private_conversation_samples(limit_conversations, windows_per_conversation):
        for window in conversation["windows"]:
            sampled.append({
                "conversationRef": conversation["id"],
                "windowRef": window["id"],
                "index": window["index"],
                "text": window["text"],
            })
    return sampled


def percentile(values, pct):
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round((pct / 100) * (len(ordered) - 1))))
    return ordered[index]


def parse_model_spec(spec):
    if ":" not in spec:
        return spec, None
    model, effort = spec.split(":", 1)
    return model, effort or None


def benchmark_model_concurrency(model_spec, windows, concurrency):
    from openai import OpenAI

    model, reasoning_effort = parse_model_spec(model_spec)
    baseline = {anchor: 0.2 for anchor in ANCHORS}

    def run_one(window):
        client = OpenAI()
        started = time.perf_counter()
        try:
            parsed = openai_json(
                client,
                model,
                "emotion_latency_benchmark_window_score",
                score_schema(),
                (
                    "You score private iMessage windows for latency benchmarking. "
                    "Return strict JSON only. Do not quote message text or concrete private topics. "
                    "Use only local message refs as evidence."
                ),
                (
                    f"Anchors: {', '.join(ANCHORS)}\n"
                    f"Prior baseline JSON: {json.dumps(baseline)}\n"
                    "Score this window relative to the baseline with abstract labels only.\n\n"
                    f"Window {window['windowRef']}:\n{window['text']}"
                ),
                reasoning_effort=reasoning_effort,
            )
            latency = round((time.perf_counter() - started) * 1000, 1)
            return {
                "windowRef": window["windowRef"],
                "ok": True,
                "latencyMs": latency,
                "dominantAnchor": max(parsed["scores"].items(), key=lambda item: item[1])[0],
                "confidence": parsed["confidence"],
                "stateLabel": parsed["stateLabel"],
                "evidenceRefCount": len(parsed.get("evidenceMessageRefs", [])),
            }
        except Exception as exc:
            latency = round((time.perf_counter() - started) * 1000, 1)
            return {
                "windowRef": window["windowRef"],
                "ok": False,
                "latencyMs": latency,
                "error": f"{type(exc).__name__}: {str(exc)[:240]}",
            }

    started = time.perf_counter()
    rows = []
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = [pool.submit(run_one, window) for window in windows]
        for future in as_completed(futures):
            row = future.result()
            row["completionMs"] = round((time.perf_counter() - started) * 1000, 1)
            rows.append(row)
    wall_ms = round((time.perf_counter() - started) * 1000, 1)
    ok_rows = [row for row in rows if row["ok"]]
    latencies = [row["latencyMs"] for row in ok_rows]
    return {
        "model": model,
        "modelSpec": model_spec,
        "reasoningEffort": reasoning_effort,
        "concurrency": concurrency,
        "windowCount": len(windows),
        "okCount": len(ok_rows),
        "errorCount": len(rows) - len(ok_rows),
        "wallMs": wall_ms,
        "effectiveWindowsPerSecond": round(len(ok_rows) / (wall_ms / 1000), 3) if wall_ms else None,
        "avgLatencyMs": round(sum(latencies) / len(latencies), 1) if latencies else None,
        "p50LatencyMs": percentile(latencies, 50),
        "p95LatencyMs": percentile(latencies, 95),
        "dominantCounts": dict(Counter(row["dominantAnchor"] for row in ok_rows)),
        "avgConfidence": round(sum(row["confidence"] for row in ok_rows) / len(ok_rows), 3) if ok_rows else None,
        "evidenceCoverage": round(sum(1 for row in ok_rows if row["evidenceRefCount"] > 0) / len(ok_rows), 3) if ok_rows else None,
        "firstResultMs": min((row["completionMs"] for row in ok_rows), default=None),
        "halfResultsMs": percentile([row["completionMs"] for row in ok_rows], 50),
        "allResultsMs": max((row["completionMs"] for row in ok_rows), default=None),
        "trace": [
            {
                "completionMs": row["completionMs"],
                "windowRef": row["windowRef"],
                "dominantAnchor": row.get("dominantAnchor"),
                "confidence": row.get("confidence"),
                "ok": row["ok"],
            }
            for row in sorted(rows, key=lambda item: item["completionMs"])
        ],
        "sampleErrors": [row["error"] for row in rows if not row["ok"]][:3],
    }


def run_latency_benchmark(args):
    if not os.environ.get("OPENAI_API_KEY"):
        return {"skipped": "OPENAI_API_KEY not set"}
    models = [model.strip() for model in args.latency_models.split(",") if model.strip()]
    concurrencies = [int(value.strip()) for value in args.latency_concurrency.split(",") if value.strip()]
    windows = flatten_sampled_windows(
        args.latency_private_conversations,
        args.latency_windows_per_conversation,
    )
    rows = []
    for model in models:
        for concurrency in concurrencies:
            rows.append(benchmark_model_concurrency(model, windows, concurrency))
    return {
        "privacy": "Private text was sent to OpenAI for bounded benchmark windows; persisted output omits raw text and stores aggregate latency/labels only.",
        "windowCount": len(windows),
        "models": models,
        "concurrencies": concurrencies,
        "results": rows,
    }


def chunked(items, size):
    return [items[index : index + size] for index in range(0, len(items), size)]


def benchmark_batch_model(model_spec, windows, batch_size, concurrency):
    from openai import OpenAI

    model, reasoning_effort = parse_model_spec(model_spec)
    baseline = {anchor: 0.2 for anchor in ANCHORS}
    batches = chunked(windows, batch_size)

    def run_batch(batch):
        client = OpenAI()
        started = time.perf_counter()
        batch_text = "\n\n".join(
            f"### Window {window['windowRef']}\n{window['text']}"
            for window in batch
        )
        try:
            parsed = openai_json(
                client,
                model,
                "emotion_batch_latency_score",
                batch_score_schema(len(batch)),
                (
                    "You score multiple private iMessage windows for latency benchmarking. "
                    "Return strict JSON only. Do not quote message text or concrete private topics. "
                    "Return exactly one row per input windowRef."
                ),
                (
                    f"Anchors: {', '.join(ANCHORS)}\n"
                    f"Prior baseline JSON for every window: {json.dumps(baseline)}\n"
                    "Score each window independently relative to the baseline. Use abstract labels only.\n\n"
                    f"{batch_text}"
                ),
                reasoning_effort=reasoning_effort,
            )
            latency = round((time.perf_counter() - started) * 1000, 1)
            rows = parsed.get("rows", [])
            for row in rows:
                row["dominantAnchor"] = max(row["scores"].items(), key=lambda item: item[1])[0]
            return {
                "ok": True,
                "latencyMs": latency,
                "inputCount": len(batch),
                "outputCount": len(rows),
                "rows": rows,
                "missingRefs": sorted(set(window["windowRef"] for window in batch) - set(row.get("windowRef") for row in rows)),
            }
        except Exception as exc:
            latency = round((time.perf_counter() - started) * 1000, 1)
            return {
                "ok": False,
                "latencyMs": latency,
                "inputCount": len(batch),
                "outputCount": 0,
                "rows": [],
                "missingRefs": [window["windowRef"] for window in batch],
                "error": f"{type(exc).__name__}: {str(exc)[:240]}",
            }

    started = time.perf_counter()
    batch_rows = []
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = [pool.submit(run_batch, batch) for batch in batches]
        for future in as_completed(futures):
            row = future.result()
            row["completionMs"] = round((time.perf_counter() - started) * 1000, 1)
            batch_rows.append(row)
    wall_ms = round((time.perf_counter() - started) * 1000, 1)
    scored_rows = [row for batch in batch_rows for row in batch["rows"]]
    latencies = [batch["latencyMs"] for batch in batch_rows if batch["ok"]]
    return {
        "model": model,
        "modelSpec": model_spec,
        "reasoningEffort": reasoning_effort,
        "batchSize": batch_size,
        "concurrency": concurrency,
        "windowCount": len(windows),
        "batchCount": len(batches),
        "okBatchCount": sum(1 for batch in batch_rows if batch["ok"]),
        "scoredWindowCount": len(scored_rows),
        "missingRefCount": sum(len(batch["missingRefs"]) for batch in batch_rows),
        "wallMs": wall_ms,
        "effectiveWindowsPerSecond": round(len(scored_rows) / (wall_ms / 1000), 3) if wall_ms else None,
        "avgBatchLatencyMs": round(sum(latencies) / len(latencies), 1) if latencies else None,
        "p95BatchLatencyMs": percentile(latencies, 95),
        "firstBatchMs": min((batch["completionMs"] for batch in batch_rows if batch["ok"]), default=None),
        "allBatchesMs": max((batch["completionMs"] for batch in batch_rows if batch["ok"]), default=None),
        "dominantCounts": dict(Counter(row["dominantAnchor"] for row in scored_rows)),
        "avgConfidence": round(sum(row["confidence"] for row in scored_rows) / len(scored_rows), 3) if scored_rows else None,
        "evidenceCoverage": round(sum(1 for row in scored_rows if row.get("evidenceMessageRefs")) / len(scored_rows), 3) if scored_rows else None,
        "sampleErrors": [batch.get("error") for batch in batch_rows if not batch["ok"]][:3],
        "trace": [
            {
                "completionMs": batch["completionMs"],
                "inputCount": batch["inputCount"],
                "outputCount": batch["outputCount"],
                "ok": batch["ok"],
            }
            for batch in sorted(batch_rows, key=lambda item: item["completionMs"])
        ],
    }


def run_batch_benchmark(args):
    if not os.environ.get("OPENAI_API_KEY"):
        return {"skipped": "OPENAI_API_KEY not set"}
    models = [model.strip() for model in args.batch_models.split(",") if model.strip()]
    batch_sizes = [int(value.strip()) for value in args.batch_sizes.split(",") if value.strip()]
    windows = flatten_sampled_windows(
        args.batch_private_conversations,
        args.batch_windows_per_conversation,
    )
    rows = []
    for model in models:
        for batch_size in batch_sizes:
            rows.append(benchmark_batch_model(model, windows, batch_size, args.batch_concurrency))
    return {
        "privacy": "Private text was sent to OpenAI in bounded multi-window batches; persisted output omits raw text and stores aggregate latency/labels only.",
        "windowCount": len(windows),
        "models": models,
        "batchSizes": batch_sizes,
        "concurrency": args.batch_concurrency,
        "results": rows,
    }


def score_only_trajectory(client, model, conversation):
    started = time.perf_counter()
    score_rows = local_score_series(conversation)
    compact_rows = [
        row for row in score_rows
        if row["shiftMagnitude"] >= 0.18
        or row["windowRef"].endswith("_w000")
        or row == score_rows[-1]
    ][:80]
    trajectory = openai_json(
        client,
        model,
        "emotion_trajectory_score_only",
        trajectory_schema(),
        (
            "You synthesize a privacy-safe emotion trajectory from numeric window scores only. "
            "You have no transcript text. Do not infer concrete topics. Use abstract categories and window refs only."
        ),
        (
            f"Anchors: {', '.join(ANCHORS)}\n"
            "Build phases and major shifts from these numeric score rows. "
            "If evidence is weak, say so in methodNotes. Do not mention concrete topics.\n\n"
            f"Score rows JSON:\n{json.dumps(compact_rows)}"
        ),
    )
    trajectory["latencyMs"] = round((time.perf_counter() - started) * 1000, 1)
    return {
        "scoreSource": "local_features_plus_vader_all_windows",
        "windowCountAll": len(score_rows),
        "windowCountSentToReducer": len(compact_rows),
        "reducerRows": compact_rows,
        "trajectory": trajectory,
    }


def hybrid_trajectory(client, model, score_only_result, comparative_result):
    local_rows = score_only_result["reducerRows"]
    comparative_rows = [
        {
            "windowRef": row["windowRef"],
            "scores": row["scores"],
            "baselineDelta": row["baselineDelta"],
            "dominantAnchor": row["dominantAnchor"],
            "stateLabel": row["stateLabel"],
            "confidence": row["confidence"],
            "evidenceMessageRefs": row["evidenceMessageRefs"],
            "notes": row["notes"],
        }
        for row in comparative_result["windowScores"]
    ]
    started = time.perf_counter()
    trajectory = openai_json(
        client,
        model,
        "emotion_trajectory_hybrid_scores",
        trajectory_schema(),
        (
            "You synthesize a privacy-safe relationship emotion trajectory. "
            "You receive numeric local score rows across the full conversation plus selected LLM-scored windows. "
            "Do not quote private message text or infer concrete private topics. Use window/message refs only."
        ),
        (
            f"Anchors: {', '.join(ANCHORS)}\n"
            "Use local score rows for coverage and selected LLM windows for calibration/labels. "
            "Prefer abstract interaction categories over concrete topics. "
            "If the local series and LLM selected windows disagree, explain the uncertainty in methodNotes.\n\n"
            f"Local score rows JSON:\n{json.dumps(local_rows)}\n\n"
            f"Selected LLM window scores JSON:\n{json.dumps(comparative_rows)}"
        ),
    )
    trajectory["latencyMs"] = round((time.perf_counter() - started) * 1000, 1)
    return {
        "scoreSource": "local_all_windows_plus_selected_llm_windows",
        "localWindowCountSentToReducer": len(local_rows),
        "selectedLlmWindowCount": len(comparative_rows),
        "trajectory": trajectory,
    }


def run_agent_trajectory(args):
    if not os.environ.get("OPENAI_API_KEY"):
        return {"skipped": "OPENAI_API_KEY not set"}
    from openai import OpenAI

    client = OpenAI()
    model = os.environ.get("OPENAI_MODEL", "gpt-5-mini")
    conversations = private_conversation_samples(
        limit_conversations=args.agent_private_conversations,
        windows_per_conversation=args.agent_windows_per_conversation,
    )
    rows = []
    for conversation in conversations:
        score_only = score_only_trajectory(client, model, conversation)
        comparative = trajectory_from_window_scores(client, model, conversation)
        row = {
            "id": conversation["id"],
            "messageCount": conversation["messageCount"],
            "windowCountTotal": conversation["windowCountTotal"],
            "windowSelector": conversation["windowSelector"],
            "windowCountSampled": len(conversation["windows"]),
            "scoreOnlyTrajectory": score_only,
            "windowComparative": comparative,
            "hybridTrajectory": hybrid_trajectory(client, model, score_only, comparative),
            "wholeConversation": whole_conversation_trajectory(client, model, conversation) if args.agent_whole_conversation else {"skipped": "pass --agent-whole-conversation"},
        }
        rows.append(row)
    return {
        "model": model,
        "privacy": "Private text was sent to OpenAI for bounded sampled windows/excerpts; persisted output omits raw text and uses local refs only.",
        "conversations": rows,
    }


def summarize_best_practices():
    return [
        "Use fixed project anchors rather than open-ended sentiment labels; open labels drift across conversations.",
        "Prefer comparative scoring against a conversation-specific prior baseline for the product metric.",
        "Use ordinal buckets or rubric examples when calibration matters; map buckets to numbers after validation.",
        "Use pairwise comparisons for eval/calibration and hard-example review, not for every production window.",
        "Keep scorer output small and typed: scores, deltas, confidence, label, evidence message IDs.",
        "Separate scoring from explanation: scorer should be cacheable; explanation can retrieve before/after windows and reason with more context.",
        "For private data, send only the minimum required window to external APIs and store evidence IDs rather than transcript copies.",
        "Evaluate with synthetic injected shifts plus private aggregate smoke tests; do not tune only on generic sentiment datasets.",
        "Use self-consistency or critique-repair only for batch recalculation/high-value explanations because cost scales linearly.",
        "Use DSPy/GEPA/Ax optimization after there is a stable eval set; premature optimization will tune against vague labels.",
    ]


def main():
    args = parse_args()
    OUT_DIR.mkdir(exist_ok=True)
    windows = synthetic_windows()
    if args.private:
        windows.extend(private_windows())

    result = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "promptVersion": PROMPT_VERSION,
        "providerEnvVarsDetected": provider_env(),
        "anchors": ANCHORS,
        "windowCounts": {
            "synthetic": sum(1 for w in windows if w["kind"] == "synthetic"),
            "private": sum(1 for w in windows if w["kind"] == "private"),
        },
        "methodCatalog": llm_method_catalog(),
        "promptTemplates": prompt_templates(),
        "bestPractices": summarize_best_practices(),
        "localGenerative": local_generative_smoke(windows) if args.local_generative else {"skipped": "pass --local-generative"},
        "openaiStructured": run_openai_structured(windows) if args.openai else {"skipped": "pass --openai"},
        "dspy": run_dspy_methods(windows) if args.dspy else {"skipped": "pass --dspy"},
        "agentTrajectory": run_agent_trajectory(args) if args.agent_trajectory else {"skipped": "pass --agent-trajectory"},
        "qualityAudit": run_quality_audit(args) if args.quality_audit else {"skipped": "pass --quality-audit"},
        "pivotalAudit": run_pivotal_audit(args) if args.pivotal_audit else {"skipped": "pass --pivotal-audit"},
        "latencyBenchmark": run_latency_benchmark(args) if args.latency_benchmark else {"skipped": "pass --latency-benchmark"},
        "batchBenchmark": run_batch_benchmark(args) if args.batch_benchmark else {"skipped": "pass --batch-benchmark"},
    }
    out_path = OUT_DIR / "llm-method-results.json"
    out_path.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({
        "outPath": str(out_path),
        "providerEnvVarsDetected": result["providerEnvVarsDetected"],
        "windowCounts": result["windowCounts"],
        "localGenerative": {
            "model": result["localGenerative"].get("model"),
            "loadMs": result["localGenerative"].get("loadMs"),
            "parseable": sum(1 for row in result["localGenerative"].get("rows", []) if row["parseableJson"]),
            "rows": len(result["localGenerative"].get("rows", [])),
        } if isinstance(result["localGenerative"], dict) else result["localGenerative"],
        "openaiStructured": {k: v for k, v in result["openaiStructured"].items() if k in {"skipped", "model"}},
        "dspy": {k: v for k, v in result["dspy"].items() if k in {"skipped", "model", "rlm"}},
        "agentTrajectory": {
            "model": result["agentTrajectory"].get("model"),
            "conversations": len(result["agentTrajectory"].get("conversations", [])),
            "skipped": result["agentTrajectory"].get("skipped"),
        } if isinstance(result["agentTrajectory"], dict) else result["agentTrajectory"],
        "qualityAudit": {
            "model": result["qualityAudit"].get("model"),
            "conversations": result["qualityAudit"].get("conversationCount"),
            "windows": result["qualityAudit"].get("windowCount"),
            "summary": result["qualityAudit"].get("summary"),
            "skipped": result["qualityAudit"].get("skipped"),
        } if isinstance(result["qualityAudit"], dict) else result["qualityAudit"],
        "pivotalAudit": {
            "model": result["pivotalAudit"].get("model"),
            "conversations": len(result["pivotalAudit"].get("conversations", [])),
            "skipped": result["pivotalAudit"].get("skipped"),
        } if isinstance(result["pivotalAudit"], dict) else result["pivotalAudit"],
        "latencyBenchmark": {
            "windowCount": result["latencyBenchmark"].get("windowCount"),
            "results": result["latencyBenchmark"].get("results"),
            "skipped": result["latencyBenchmark"].get("skipped"),
        } if isinstance(result["latencyBenchmark"], dict) else result["latencyBenchmark"],
        "batchBenchmark": {
            "windowCount": result["batchBenchmark"].get("windowCount"),
            "results": result["batchBenchmark"].get("results"),
            "skipped": result["batchBenchmark"].get("skipped"),
        } if isinstance(result["batchBenchmark"], dict) else result["batchBenchmark"],
    }, indent=2))


if __name__ == "__main__":
    main()
