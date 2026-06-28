import argparse
import json
import os
import re
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

from openai import OpenAI
from transformers import pipeline

from run_python_methods import (
    ANCHORS,
    DAIR_TO_ANCHOR,
    EKMAN_TO_ANCHOR,
    GOEMOTIONS_TO_ANCHOR,
    SENTIMENT_TO_ANCHOR,
    TWITTER_EMOTION_TO_ANCHOR,
    collapse_labels,
    dominant,
    load_private_conversations,
    load_private_messages,
    normalize,
    score_afinn,
    score_features,
    score_node_sentiment_messages,
    score_nrclex,
    score_relationship_features,
    score_textblob,
    score_vad_proxy,
    score_vader,
    shift_rows,
    SYNTHETIC_ARCS,
)

OUT_DIR = Path("out")

DETERMINISTIC = {
    "vader": score_vader,
    "textblob": score_textblob,
    "afinn": score_afinn,
    "nrclex": score_nrclex,
    "vad_proxy": score_vad_proxy,
    "emoji_keyword_features": score_features,
    "relationship_proxy_features": score_relationship_features,
}

BATCH_DETERMINISTIC = {
    "node_sentiment": score_node_sentiment_messages,
}

MAPPINGS = {
    "goemotions": GOEMOTIONS_TO_ANCHOR,
    "ekman": EKMAN_TO_ANCHOR,
    "sentiment": SENTIMENT_TO_ANCHOR,
    "twitter_emotion": TWITTER_EMOTION_TO_ANCHOR,
    "dair": DAIR_TO_ANCHOR,
}


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--out", default="out/harness-results.json")
    return parser.parse_args()


def load_config(path):
    return json.loads(Path(path).read_text())


def synthetic_conversations():
    rows = []
    for arc in SYNTHETIC_ARCS:
        rows.append({
            "id": arc["id"],
            "kind": "synthetic",
            "expected": arc["expected"],
            "messages": [
                {
                    "id": f"{arc['id']}_m{index:04}",
                    "content": text,
                    "isFromMe": bool(index % 2 == 0),
                }
                for index, text in enumerate(arc["messages"])
            ],
        })
    return rows


def private_conversations(limit, max_messages):
    rows = []
    for index, conversation in enumerate(load_private_conversations(limit), start=1):
        messages = load_private_messages(conversation["id"])[:max_messages]
        rows.append({
            "id": f"private_c{index:02}",
            "kind": "private",
            "sourceConversationId": conversation["id"],
            "messages": messages,
        })
    return rows


def load_dataset(config):
    dataset = config.get("dataset", {})
    kind = dataset.get("kind", "synthetic")
    rows = []
    if kind in {"synthetic", "mixed"}:
        rows.extend(synthetic_conversations())
    if kind in {"private", "mixed"}:
        rows.extend(private_conversations(
            int(dataset.get("privateConversationLimit", 2)),
            int(dataset.get("maxMessagesPerConversation", 600)),
        ))
    return rows


def make_windows(messages, size, stride):
    windows = []
    for start in range(0, len(messages), stride):
        chunk = messages[start:start + size]
        if len(chunk) >= max(2, min(4, size)):
            windows.append({
                "index": len(windows),
                "start": start,
                "end": start + len(chunk) - 1,
                "messages": chunk,
            })
    return windows


def window_ref(conversation_id, window):
    return f"{conversation_id}_w{window['index']:03}"


def window_text(window):
    lines = []
    for offset, message in enumerate(window["messages"], start=window["start"]):
        speaker = "me" if message.get("isFromMe") else "them"
        lines.append(f"m{offset:04}: {speaker}: {message['content']}")
    return "\n".join(lines)[:3000]


def score_windows(messages, windows, score_message):
    rows = []
    for window in windows:
        totals = {anchor: 0.0 for anchor in ANCHORS}
        for message in window["messages"]:
            scores = score_message(message["content"])
            for anchor in ANCHORS:
                totals[anchor] += scores[anchor]
        scores = {anchor: round(totals[anchor] / len(window["messages"]), 3) for anchor in ANCHORS}
        rows.append({"index": window["index"], "scores": scores, "dominant": dominant(scores)})
    return rows


def score_windows_from_message_scores(windows, message_scores):
    rows = []
    for window in windows:
        totals = {anchor: 0.0 for anchor in ANCHORS}
        for offset in range(window["start"], window["end"] + 1):
            scores = message_scores[offset]
            for anchor in ANCHORS:
                totals[anchor] += scores[anchor]
        scores = {anchor: round(totals[anchor] / len(window["messages"]), 3) for anchor in ANCHORS}
        rows.append({"index": window["index"], "scores": scores, "dominant": dominant(scores)})
    return rows


def summarize_shifted(rows):
    shifted = shift_rows(rows)
    return {
        "windowCount": len(shifted),
        "dominantCounts": dict(Counter(row["dominant"] for row in shifted)),
        "topShifts": sorted(
            [
                {
                    "index": row["index"],
                    "dominant": row["dominant"],
                    "shiftMagnitude": row["shiftMagnitude"],
                    "zMax": row["zMax"],
                    "deltas": row["deltas"],
                }
                for row in shifted
            ],
            key=lambda row: row["shiftMagnitude"],
            reverse=True,
        )[:8],
        "rows": shifted,
    }


def run_deterministic(conversations, windowing, names):
    results = []
    for spec in windowing:
        size = int(spec["size"])
        stride = int(spec["stride"])
        for name in names:
            started = time.perf_counter()
            conversation_rows = []
            for conversation in conversations:
                windows = make_windows(conversation["messages"], size, stride)
                if name in DETERMINISTIC:
                    shifted = summarize_shifted(score_windows(conversation["messages"], windows, DETERMINISTIC[name]()))
                elif name in BATCH_DETERMINISTIC:
                    shifted = summarize_shifted(score_windows_from_message_scores(
                        windows,
                        BATCH_DETERMINISTIC[name](conversation["messages"]),
                    ))
                else:
                    conversation_rows.append({"id": conversation["id"], "error": f"unknown deterministic method {name}"})
                    continue
                conversation_rows.append({
                    "id": conversation["id"],
                    "kind": conversation["kind"],
                    "windowCount": shifted["windowCount"],
                    "dominantCounts": shifted["dominantCounts"],
                    "topShifts": shifted["topShifts"],
                })
            elapsed = time.perf_counter() - started
            total_windows = sum(row.get("windowCount", 0) for row in conversation_rows)
            aggregate = Counter()
            for row in conversation_rows:
                aggregate.update(row.get("dominantCounts", {}))
            results.append({
                "name": name,
                "window": {"size": size, "stride": stride},
                "avgWindowMs": round((elapsed * 1000) / max(1, total_windows), 3),
                "totalWindows": total_windows,
                "dominantCounts": dict(aggregate),
                "conversations": conversation_rows,
            })
    return results


def select_llm_windows(conversations, windowing, selection, deterministic_results):
    if not windowing:
        return []
    size = int(windowing[0]["size"])
    stride = int(windowing[0]["stride"])
    max_per_conversation = int(selection.get("maxWindowsPerConversation", 4))
    scorer = selection.get("candidateScorer")
    selected = []
    for conversation in conversations:
        windows = make_windows(conversation["messages"], size, stride)
        ranked = []
        if scorer:
            matching = [
                result for result in deterministic_results
                if result["name"] == scorer and result["window"] == {"size": size, "stride": stride}
            ]
            conv_rows = {}
            if matching:
                for row in matching[0]["conversations"]:
                    if row["id"] == conversation["id"]:
                        conv_rows = {item["index"]: item for item in row.get("topShifts", [])}
            ranked_indexes = list(conv_rows.keys())
        else:
            ranked_indexes = []
        keep = {0, len(windows) - 1} if windows else set()
        for index in ranked_indexes:
            keep.add(index)
            if len(keep) >= max_per_conversation:
                break
        for window in windows:
            if window["index"] in keep and len(selected) < 1000:
                selected.append({
                    "conversationId": conversation["id"],
                    "kind": conversation["kind"],
                    "windowRef": window_ref(conversation["id"], window),
                    "text": window_text(window),
                })
    return selected


def parse_model_spec(spec):
    if ":" not in spec:
        return spec, None
    model, effort = spec.split(":", 1)
    return model, effort or None


def parse_jsonish(text):
    if not text:
        raise ValueError("empty output")
    stripped = text.strip()
    stripped = re.sub(r"^```(?:json)?\s*", "", stripped)
    stripped = re.sub(r"\s*```$", "", stripped)
    return json.loads(stripped)


def llm_client(provider):
    if provider == "openai":
        return OpenAI(), None
    if provider == "openrouter":
        key = os.environ.get("OPENROUTER_API_KEY")
        if not key:
            raise RuntimeError("OPENROUTER_API_KEY not set")
        return OpenAI(base_url="https://openrouter.ai/api/v1", api_key=key), {
            "HTTP-Referer": "https://local.imessage-emotion.test",
            "X-Title": "imessage-emotion harness",
        }
    raise RuntimeError(f"unknown LLM provider {provider}")


def score_llm_window(config, window):
    provider = config["provider"]
    model, reasoning_effort = parse_model_spec(config["model"])
    client, extra_headers = llm_client(provider)
    prompt = (
        "Return one valid JSON object only. Keys: windowRef, scores, confidence, stateLabel, evidenceMessageRefs, notes. "
        f"scores must contain exactly these anchors from 0 to 1: {', '.join(ANCHORS)}.\n"
        f"WindowRef: {window['windowRef']}\n"
        f"Window:\n{window['text']}"
    )
    started = time.perf_counter()
    request = {
        "model": model,
        "messages": [
            {"role": "system", "content": "You score private iMessage windows. Do not quote private text. Use local message refs only."},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0,
        "max_tokens": int(config.get("maxTokens", 350)),
    }
    if config.get("jsonMode", True):
        request["response_format"] = {"type": "json_object"}
    if extra_headers:
        request["extra_headers"] = extra_headers
    if reasoning_effort and provider == "openai":
        request["extra_body"] = {"reasoning": {"effort": reasoning_effort}}
    response = client.chat.completions.create(**request)
    latency_ms = round((time.perf_counter() - started) * 1000, 1)
    parsed = parse_jsonish(response.choices[0].message.content or "")
    scores = parsed.get("scores") or {}
    return {
        "windowRef": window["windowRef"],
        "latencyMs": latency_ms,
        "stateLabel": parsed.get("stateLabel"),
        "confidence": parsed.get("confidence"),
        "dominant": dominant({anchor: float(scores.get(anchor, 0.0)) for anchor in ANCHORS}),
        "evidenceRefCount": len(parsed.get("evidenceMessageRefs") or []),
    }


def run_llm(selected_windows, configs):
    results = []
    for config in configs:
        if not config.get("enabled", True):
            results.append({"name": config["name"], "skipped": "disabled"})
            continue
        windows = selected_windows[: int(config.get("maxWindows", len(selected_windows)))]
        started = time.perf_counter()
        rows = []
        with ThreadPoolExecutor(max_workers=int(config.get("concurrency", 4))) as pool:
            futures = [pool.submit(score_llm_window, config, window) for window in windows]
            for future in as_completed(futures):
                try:
                    row = future.result()
                    row["ok"] = True
                except Exception as exc:
                    row = {"ok": False, "error": f"{type(exc).__name__}: {str(exc)[:240]}"}
                row["completionMs"] = round((time.perf_counter() - started) * 1000, 1)
                rows.append(row)
        ok = [row for row in rows if row["ok"]]
        latencies = [row["latencyMs"] for row in ok]
        results.append({
            "name": config["name"],
            "provider": config["provider"],
            "model": config["model"],
            "windowCount": len(windows),
            "okCount": len(ok),
            "errorCount": len(rows) - len(ok),
            "wallMs": round((time.perf_counter() - started) * 1000, 1),
            "avgLatencyMs": round(sum(latencies) / len(latencies), 1) if latencies else None,
            "dominantCounts": dict(Counter(row.get("dominant") for row in ok)),
            "avgConfidence": round(sum(float(row.get("confidence") or 0) for row in ok) / len(ok), 3) if ok else None,
            "evidenceCoverage": round(sum(1 for row in ok if row.get("evidenceRefCount")) / len(ok), 3) if ok else None,
            "firstResultMs": min((row["completionMs"] for row in ok), default=None),
            "allResultsMs": max((row["completionMs"] for row in ok), default=None),
            "sampleErrors": [row["error"] for row in rows if not row["ok"]][:3],
        })
    return results


def run_hf(conversations, windowing, configs):
    results = []
    if not configs:
        return results
    for config in configs:
        if not config.get("enabled", True):
            results.append({"name": config["name"], "skipped": "disabled"})
            continue
        mapping = MAPPINGS[config["mapping"]]
        started = time.perf_counter()
        try:
            classifier = pipeline("text-classification", model=config["model"], return_all_scores=False)
            load_ms = round((time.perf_counter() - started) * 1000, 1)
            spec = windowing[0]
            size = int(spec["size"])
            stride = int(spec["stride"])
            rows = []
            infer_started = time.perf_counter()
            total_windows = 0
            aggregate = Counter()
            for conversation in conversations:
                scored = []
                for window in make_windows(conversation["messages"], size, stride):
                    output = classifier(window_text(window), truncation=True, top_k=None)
                    scores = collapse_labels(output, mapping)
                    scored.append({"index": window["index"], "scores": scores, "dominant": dominant(scores)})
                    total_windows += 1
                shifted = summarize_shifted(scored)
                aggregate.update(shifted["dominantCounts"])
                rows.append({"id": conversation["id"], "windowCount": shifted["windowCount"], "dominantCounts": shifted["dominantCounts"]})
            results.append({
                "name": config["name"],
                "model": config["model"],
                "loadMs": load_ms,
                "avgWindowMs": round((time.perf_counter() - infer_started) * 1000 / max(1, total_windows), 1),
                "totalWindows": total_windows,
                "dominantCounts": dict(aggregate),
                "conversations": rows,
            })
        except Exception as exc:
            results.append({"name": config["name"], "model": config["model"], "error": f"{type(exc).__name__}: {str(exc)[:400]}"})
    return results


def main():
    args = parse_args()
    config = load_config(args.config)
    OUT_DIR.mkdir(exist_ok=True)
    conversations = load_dataset(config)
    deterministic = run_deterministic(conversations, config.get("windowing", []), config.get("deterministic", []))
    selected_windows = select_llm_windows(
        conversations,
        config.get("windowing", []),
        config.get("selection", {}),
        deterministic,
    )
    result = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "runName": config.get("runName"),
        "anchors": ANCHORS,
        "privacy": "Private message text may be read locally and sent to configured LLM providers only for selected windows; persisted output omits raw private text.",
        "dataset": {
            "conversationCount": len(conversations),
            "kinds": dict(Counter(conversation["kind"] for conversation in conversations)),
        },
        "windowing": config.get("windowing", []),
        "selectedWindowCount": len(selected_windows),
        "deterministic": deterministic,
        "hf": run_hf(conversations, config.get("windowing", []), config.get("hf", [])),
        "llm": run_llm(selected_windows, config.get("llm", [])),
    }
    out_path = Path(args.out)
    out_path.parent.mkdir(exist_ok=True)
    out_path.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({
        "outPath": str(out_path),
        "runName": result["runName"],
        "dataset": result["dataset"],
        "selectedWindowCount": result["selectedWindowCount"],
        "deterministic": [
            {
                "name": row["name"],
                "window": row["window"],
                "avgWindowMs": row["avgWindowMs"],
                "dominantCounts": row["dominantCounts"],
            }
            for row in deterministic
        ],
        "hf": [
            {key: row.get(key) for key in ["name", "model", "loadMs", "avgWindowMs", "error", "skipped"]}
            for row in result["hf"]
        ],
        "llm": [
            {key: row.get(key) for key in ["name", "provider", "model", "okCount", "errorCount", "wallMs", "avgLatencyMs", "avgConfidence", "sampleErrors", "skipped"]}
            for row in result["llm"]
        ],
    }, indent=2))


if __name__ == "__main__":
    main()
