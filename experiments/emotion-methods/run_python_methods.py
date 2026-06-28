import argparse
import json
import math
import re
import subprocess
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from afinn import Afinn
from nrclex import NRCLex
from textblob import TextBlob
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

ANCHORS = ["warmth_affection", "joy_playfulness", "stress_anxiety", "anger_friction", "sadness_distance", "neutral_logistical"]
WINDOW_SIZE = 8
STRIDE = 4
OUT_DIR = Path("out")
PRIVATE_LIMIT = 8

SYNTHETIC_ARCS = [
    {
        "id": "synthetic_warm_tense_distant",
        "expected": ["warmth_affection", "anger_friction", "sadness_distance"],
        "messages": [
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
        "id": "synthetic_logistical_affectionate",
        "expected": ["neutral_logistical", "warmth_affection", "joy_playfulness"],
        "messages": [
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
        "id": "synthetic_conflict_repair",
        "expected": ["anger_friction", "warmth_affection"],
        "messages": [
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
]

GOEMOTIONS_TO_ANCHOR = {
    "admiration": "warmth_affection",
    "amusement": "joy_playfulness",
    "anger": "anger_friction",
    "annoyance": "anger_friction",
    "approval": "warmth_affection",
    "caring": "warmth_affection",
    "confusion": "stress_anxiety",
    "curiosity": "neutral_logistical",
    "desire": "warmth_affection",
    "disappointment": "sadness_distance",
    "disapproval": "anger_friction",
    "disgust": "anger_friction",
    "embarrassment": "stress_anxiety",
    "excitement": "joy_playfulness",
    "fear": "stress_anxiety",
    "gratitude": "warmth_affection",
    "grief": "sadness_distance",
    "joy": "joy_playfulness",
    "love": "warmth_affection",
    "nervousness": "stress_anxiety",
    "optimism": "joy_playfulness",
    "pride": "joy_playfulness",
    "realization": "neutral_logistical",
    "relief": "warmth_affection",
    "remorse": "sadness_distance",
    "sadness": "sadness_distance",
    "surprise": "joy_playfulness",
    "neutral": "neutral_logistical",
}

EKMAN_TO_ANCHOR = {
    "anger": "anger_friction",
    "disgust": "anger_friction",
    "fear": "stress_anxiety",
    "joy": "joy_playfulness",
    "neutral": "neutral_logistical",
    "sadness": "sadness_distance",
    "surprise": "joy_playfulness",
}

SENTIMENT_TO_ANCHOR = {
    "positive": "warmth_affection",
    "pos": "warmth_affection",
    "label_2": "warmth_affection",
    "negative": "anger_friction",
    "neg": "anger_friction",
    "label_0": "anger_friction",
    "neutral": "neutral_logistical",
    "neu": "neutral_logistical",
    "label_1": "neutral_logistical",
}

TWITTER_EMOTION_TO_ANCHOR = {
    "anger": "anger_friction",
    "disgust": "anger_friction",
    "fear": "stress_anxiety",
    "joy": "joy_playfulness",
    "optimism": "joy_playfulness",
    "pessimism": "sadness_distance",
    "sadness": "sadness_distance",
    "surprise": "joy_playfulness",
    "love": "warmth_affection",
    "trust": "warmth_affection",
    "anticipation": "stress_anxiety",
    "neutral": "neutral_logistical",
}

DAIR_TO_ANCHOR = {
    "anger": "anger_friction",
    "fear": "stress_anxiety",
    "joy": "joy_playfulness",
    "love": "warmth_affection",
    "sadness": "sadness_distance",
    "surprise": "joy_playfulness",
}

NRC_TO_ANCHOR = {
    "anger": "anger_friction",
    "anticipation": "stress_anxiety",
    "disgust": "anger_friction",
    "fear": "stress_anxiety",
    "joy": "joy_playfulness",
    "negative": "sadness_distance",
    "positive": "warmth_affection",
    "sadness": "sadness_distance",
    "surprise": "joy_playfulness",
    "trust": "warmth_affection",
}

VAD_WORDS = {
    "love": (0.95, 0.65, 0.75),
    "miss": (0.55, 0.55, 0.45),
    "thanks": (0.85, 0.35, 0.65),
    "thank": (0.85, 0.35, 0.65),
    "happy": (0.9, 0.7, 0.65),
    "calm": (0.8, 0.2, 0.7),
    "sorry": (0.45, 0.5, 0.35),
    "hurt": (0.2, 0.7, 0.25),
    "mad": (0.1, 0.85, 0.5),
    "frustrated": (0.15, 0.8, 0.45),
    "angry": (0.1, 0.9, 0.55),
    "anxious": (0.2, 0.85, 0.2),
    "worried": (0.25, 0.75, 0.25),
    "ok": (0.48, 0.15, 0.45),
    "sure": (0.5, 0.18, 0.5),
    "later": (0.42, 0.2, 0.45),
    "busy": (0.4, 0.55, 0.5),
}


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--private", action="store_true")
    parser.add_argument("--hf", action="store_true")
    parser.add_argument("--hf-extended", action="store_true")
    parser.add_argument("--pysentimiento", action="store_true")
    parser.add_argument("--keybert", action="store_true")
    parser.add_argument("--private-limit", type=int, default=PRIVATE_LIMIT)
    return parser.parse_args()


def cued_sql(sql):
    raw = subprocess.check_output(["cued", "sql", sql], text=True)
    raw = re.sub(r"^\(node:[^\n]+\)\s+ExperimentalWarning:[\s\S]*?\n(?=[\[{])", "", raw)
    return json.loads(raw)


def load_private_conversations(limit=PRIVATE_LIMIT):
    sql = f"""
      select c.id, count(m.id) as messages,
             sum(case when m.is_from_me then 1 else 0 end) as from_me,
             sum(case when not m.is_from_me then 1 else 0 end) as from_other,
             max(m.sent_at) as last_at
      from conversations c
      join messages m on m.conversation_id = c.id
      where c.platform='imessage'
        and c.type='dm'
        and m.content is not null
        and length(trim(m.content)) > 0
      group by c.id
      having messages >= 120 and from_me >= 30 and from_other >= 30
      order by last_at desc
      limit {limit}
    """
    return cued_sql(sql)


def load_private_messages(conversation_id):
    safe_id = conversation_id.replace("'", "''")
    sql = f"""
      select id, is_from_me as isFromMe, sent_at as sentAt, content
      from messages
      where conversation_id = '{safe_id}'
        and content is not null
        and length(trim(content)) > 0
      order by sent_at asc
      limit 600
    """
    return [
        {
            "id": row["id"],
            "isFromMe": bool(row["isFromMe"]),
            "sentAt": row["sentAt"],
            "content": str(row["content"])[:500],
        }
        for row in cued_sql(sql)
    ]


def rolling_windows(messages):
    windows = []
    for start in range(0, len(messages), STRIDE):
        chunk = messages[start : start + WINDOW_SIZE]
        if len(chunk) >= 4:
            windows.append({"index": len(windows), "messages": chunk})
    return windows


def normalize(scores):
    max_value = max(1.0, *scores.values())
    return {anchor: round(min(1.0, scores.get(anchor, 0.0) / max_value), 3) for anchor in ANCHORS}


def dominant(scores):
    return max(scores.items(), key=lambda item: item[1])[0]


def mean_scores(score_rows):
    return {anchor: sum(row[anchor] for row in score_rows) / len(score_rows) for anchor in ANCHORS}


def score_windows(messages, score_message):
    rows = []
    for window in rolling_windows(messages):
        totals = {anchor: 0.0 for anchor in ANCHORS}
        for message in window["messages"]:
            scores = score_message(message["content"])
            for anchor in ANCHORS:
                totals[anchor] += scores[anchor]
        scores = {anchor: round(totals[anchor] / len(window["messages"]), 3) for anchor in ANCHORS}
        rows.append({"index": window["index"], "scores": scores, "dominant": dominant(scores)})
    return rows


def score_windows_from_message_scores(messages, message_scores):
    rows = []
    for window in rolling_windows(messages):
        totals = {anchor: 0.0 for anchor in ANCHORS}
        for offset, _message in enumerate(window["messages"], start=window["index"] * STRIDE):
            scores = message_scores[offset]
            for anchor in ANCHORS:
                totals[anchor] += scores[anchor]
        scores = {anchor: round(totals[anchor] / len(window["messages"]), 3) for anchor in ANCHORS}
        rows.append({"index": window["index"], "scores": scores, "dominant": dominant(scores)})
    return rows


def shift_rows(rows):
    shifted = []
    for i, row in enumerate(rows):
        if i == 0:
            shifted.append({**row, "shiftMagnitude": 0.0, "deltas": {anchor: 0.0 for anchor in ANCHORS}, "zMax": 0.0})
            continue
        baseline = mean_scores([prior["scores"] for prior in rows[:i]])
        deltas = {anchor: round(row["scores"][anchor] - baseline[anchor], 3) for anchor in ANCHORS}
        zmax = 0.0
        for anchor in ANCHORS:
            values = [prior["scores"][anchor] for prior in rows[:i]]
            if len(values) >= 2:
                avg = sum(values) / len(values)
                variance = sum((value - avg) ** 2 for value in values) / len(values)
                sd = math.sqrt(variance)
                if sd > 0.001:
                    zmax = max(zmax, abs((row["scores"][anchor] - avg) / sd))
        shifted.append({
            **row,
            "shiftMagnitude": round(math.sqrt(sum(delta * delta for delta in deltas.values())), 3),
            "deltas": deltas,
            "zMax": round(zmax, 3),
        })
    return shifted


def score_vader():
    analyzer = SentimentIntensityAnalyzer()

    def score(text):
        compound = analyzer.polarity_scores(text)["compound"]
        scores = {anchor: 0.0 for anchor in ANCHORS}
        scores["warmth_affection"] = max(0.0, compound)
        scores["joy_playfulness"] = max(0.0, compound) * 0.8
        scores["anger_friction"] = max(0.0, -compound)
        scores["sadness_distance"] = max(0.0, -compound) * 0.6
        scores["neutral_logistical"] = 0.8 if abs(compound) < 0.15 else 0.1
        return normalize(scores)

    return score


def score_textblob():
    def score(text):
        sentiment = TextBlob(text).sentiment
        polarity = sentiment.polarity
        subjectivity = sentiment.subjectivity
        scores = {anchor: 0.0 for anchor in ANCHORS}
        scores["warmth_affection"] = max(0.0, polarity)
        scores["joy_playfulness"] = max(0.0, polarity) * max(0.4, subjectivity)
        scores["anger_friction"] = max(0.0, -polarity) * max(0.4, subjectivity)
        scores["sadness_distance"] = max(0.0, -polarity) * (1.0 - min(0.8, subjectivity / 2))
        scores["neutral_logistical"] = 0.8 if abs(polarity) < 0.12 else 0.1
        return normalize(scores)

    return score


def score_afinn():
    afinn = Afinn()

    def score(text):
        value = max(-5.0, min(5.0, afinn.score(text))) / 5.0
        scores = {anchor: 0.0 for anchor in ANCHORS}
        scores["warmth_affection"] = max(0.0, value)
        scores["joy_playfulness"] = max(0.0, value) * 0.8
        scores["anger_friction"] = max(0.0, -value)
        scores["sadness_distance"] = max(0.0, -value) * 0.7
        scores["neutral_logistical"] = 0.8 if abs(value) < 0.1 else 0.1
        return normalize(scores)

    return score


def score_nrclex():
    def score(text):
        analyzer = NRCLex()
        analyzer.load_raw_text(text)
        raw = analyzer.raw_emotion_scores
        scores = {anchor: 0.0 for anchor in ANCHORS}
        for emotion, value in raw.items():
            anchor = NRC_TO_ANCHOR.get(emotion)
            if anchor:
                scores[anchor] += value
        if not raw:
            scores["neutral_logistical"] = 0.8
        return normalize(scores)

    return score


def score_vad_proxy():
    token_re = re.compile(r"[a-z']+")

    def score(text):
        triples = []
        for token in token_re.findall(text.lower()):
            if token in VAD_WORDS:
                triples.append(VAD_WORDS[token])
        if not triples:
            return normalize({"neutral_logistical": 0.8})
        valence = sum(item[0] for item in triples) / len(triples)
        arousal = sum(item[1] for item in triples) / len(triples)
        dominance = sum(item[2] for item in triples) / len(triples)
        scores = {
            "warmth_affection": max(0.0, valence - 0.45) + max(0.0, dominance - 0.5) * 0.3,
            "joy_playfulness": max(0.0, valence - 0.55) + max(0.0, arousal - 0.55) * 0.5,
            "stress_anxiety": max(0.0, arousal - 0.55) + max(0.0, 0.45 - dominance) * 0.5,
            "anger_friction": max(0.0, 0.4 - valence) + max(0.0, arousal - 0.65),
            "sadness_distance": max(0.0, 0.5 - valence) + max(0.0, 0.45 - arousal) * 0.3,
            "neutral_logistical": 0.2 if arousal > 0.45 else 0.6,
        }
        return normalize(scores)

    return score


def score_features():
    emoji_warm = re.compile(r"[❤️💕😍😘🥰😊🙂😄😂]")
    emoji_tense = re.compile(r"[😬😕😟😢😭😡]")

    def score(text):
        lowered = text.lower().strip()
        scores = {anchor: 0.0 for anchor in ANCHORS}
        scores["warmth_affection"] += len(emoji_warm.findall(text)) * 1.0
        scores["joy_playfulness"] += text.count("!") * 0.15 + len(re.findall(r"\b(lol|haha|lmao)\b", lowered)) * 0.8
        scores["anger_friction"] += len(emoji_tense.findall(text)) * 0.7 + lowered.count("?") * 0.08
        scores["sadness_distance"] += 0.8 if lowered in {"ok", "k", "sure", "fine"} else 0.0
        scores["neutral_logistical"] += 0.8 if re.search(r"\b(today|tomorrow|train|time|where|when|call|send|pick|drop|meeting)\b", lowered) else 0.0
        return normalize(scores)

    return score


def score_relationship_features():
    warm = re.compile(r"\b(love|miss|thanks|thank you|appreciate|proud|care|support|sweet|kind|glad)\b")
    play = re.compile(r"\b(lol|haha|lmao|funny|joke|wild|iconic)\b")
    stress = re.compile(r"\b(worried|anxious|stressed|scared|confused|idk|uncertain|overwhelmed|busy)\b")
    conflict = re.compile(r"\b(hurt|mad|angry|frustrated|annoyed|dismissed|upset|unfair|whatever)\b")
    repair = re.compile(r"\b(sorry|apologize|reset|repair|talk through|i hear you|my bad|understand)\b")
    distant = re.compile(r"\b(ok|k|sure|fine|later|nvm|nevermind)\b")
    logistics = re.compile(r"\b(today|tomorrow|time|where|when|call|send|pick|drop|meeting|train|uber|flight|address|calendar)\b")

    def score(text):
        lowered = text.lower().strip()
        scores = {anchor: 0.0 for anchor in ANCHORS}
        scores["warmth_affection"] += len(warm.findall(lowered)) * 0.8 + len(re.findall(r"\b(we|us|our)\b", lowered)) * 0.08
        scores["joy_playfulness"] += len(play.findall(lowered)) * 0.8 + text.count("!") * 0.1
        scores["stress_anxiety"] += len(stress.findall(lowered)) * 0.8 + lowered.count("?") * 0.05
        scores["anger_friction"] += len(conflict.findall(lowered)) * 0.9
        scores["sadness_distance"] += len(distant.findall(lowered)) * 0.5
        scores["neutral_logistical"] += len(logistics.findall(lowered)) * 0.6
        if repair.search(lowered):
            scores["warmth_affection"] += 0.45
            scores["anger_friction"] += 0.2
        if not any(scores.values()):
            scores["neutral_logistical"] = 0.4
        return normalize(scores)

    return score


def score_node_sentiment_messages(messages):
    script = """
const Sentiment = require('sentiment');
const sentiment = new Sentiment();
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const texts = JSON.parse(input);
  const rows = texts.map(text => {
    const result = sentiment.analyze(String(text || ''));
    return { score: result.score || 0, comparative: result.comparative || 0 };
  });
  process.stdout.write(JSON.stringify(rows));
});
"""
    texts = [message["content"] for message in messages]
    raw = subprocess.check_output(["node", "-e", script], input=json.dumps(texts), text=True)
    rows = []
    for item in json.loads(raw):
        value = max(-1.0, min(1.0, float(item.get("comparative", 0.0)) * 4))
        scores = {anchor: 0.0 for anchor in ANCHORS}
        scores["warmth_affection"] = max(0.0, value)
        scores["joy_playfulness"] = max(0.0, value) * 0.7
        scores["anger_friction"] = max(0.0, -value)
        scores["sadness_distance"] = max(0.0, -value) * 0.6
        scores["neutral_logistical"] = 0.8 if abs(value) < 0.1 else 0.1
        rows.append(normalize(scores))
    return rows


def collapse_labels(outputs, mapping):
    scores = {anchor: 0.0 for anchor in ANCHORS}
    if isinstance(outputs, list) and outputs and isinstance(outputs[0], list):
        outputs = outputs[0]
    if isinstance(outputs, dict):
        outputs = [outputs]
    for item in outputs:
        label = str(item.get("label", "")).lower()
        score = float(item.get("score", 0.0))
        anchor = mapping.get(label)
        if anchor:
            scores[anchor] += score
    if not any(scores.values()):
        scores["neutral_logistical"] = 0.8
    return normalize(scores)


def run_hf_methods(sample_texts, private_message_sets=None, extended=False):
    from transformers import pipeline

    methods = {}
    specs = [
        ("goemotions_student", "joeddav/distilbert-base-uncased-go-emotions-student", GOEMOTIONS_TO_ANCHOR, {"top_k": None}),
        ("ekman_distilroberta", "j-hartmann/emotion-english-distilroberta-base", EKMAN_TO_ANCHOR, {"top_k": None}),
    ]
    if extended:
        specs.extend([
            ("samlowe_roberta_goemotions", "SamLowe/roberta-base-go_emotions", GOEMOTIONS_TO_ANCHOR, {"top_k": None}),
            ("emoroberta_goemotions", "arpanghoshal/EmoRoBERTa", GOEMOTIONS_TO_ANCHOR, {"top_k": None}),
            ("cardiff_twitter_sentiment", "cardiffnlp/twitter-roberta-base-sentiment-latest", SENTIMENT_TO_ANCHOR, {"top_k": None}),
            ("cardiff_twitter_emotion", "cardiffnlp/twitter-roberta-base-emotion-latest", TWITTER_EMOTION_TO_ANCHOR, {"top_k": None}),
            ("cardiff_twitter_emotion_multilabel", "cardiffnlp/twitter-roberta-base-emotion-multilabel-latest", TWITTER_EMOTION_TO_ANCHOR, {"top_k": None}),
            ("dair_distilbert_emotion", "bhadresh-savani/distilbert-base-uncased-emotion", DAIR_TO_ANCHOR, {"top_k": None}),
            ("empathetic_dialogue_classifier", "bdotloh/just-another-emotion-classifier", GOEMOTIONS_TO_ANCHOR, {"top_k": None}),
            ("conv_emotion_roberta", "Sidharthan/roberta-base-conv-emotion", GOEMOTIONS_TO_ANCHOR, {"top_k": None}),
        ])
    for name, model, mapping, call_kwargs in specs:
        started = time.perf_counter()
        try:
            classifier = pipeline("text-classification", model=model, return_all_scores=False)
            load_ms = round((time.perf_counter() - started) * 1000, 1)
            infer_started = time.perf_counter()
            rows = []
            for text in sample_texts:
                output = classifier(text, truncation=True, **call_kwargs)
                rows.append({
                    "redactedSample": redact(text),
                    "scores": collapse_labels(output, mapping),
                    "rawTop": redact_model_output(output),
                })
            infer_ms = round((time.perf_counter() - infer_started) * 1000 / max(1, len(sample_texts)), 1)
            private_rows = []
            private_infer_ms = None
            if private_message_sets:
                private_started = time.perf_counter()
                private_window_count = 0
                for private_set in private_message_sets:
                    scored = []
                    for window in rolling_windows(private_set["messages"]):
                        window_text = "\n".join(message["content"] for message in window["messages"])[:2000]
                        output = classifier(window_text, truncation=True, **call_kwargs)
                        scores = collapse_labels(output, mapping)
                        scored.append({"index": window["index"], "scores": scores, "dominant": dominant(scores)})
                        private_window_count += 1
                    shifted = shift_rows(scored)
                    private_rows.append({
                        "id": private_set["id"],
                        "windowCount": len(shifted),
                        "dominantDistribution": dict(Counter(row["dominant"] for row in shifted)),
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
                        )[:5],
                        "changeDetection": change_detection(shifted),
                    })
                private_infer_ms = round((time.perf_counter() - private_started) * 1000 / max(1, private_window_count), 1)
            methods[name] = {
                "model": model,
                "loadMs": load_ms,
                "avgInferMs": infer_ms,
                "rows": rows,
                "privateAvgWindowInferMs": private_infer_ms,
                "privateAggregate": private_rows,
            }
        except Exception as exc:
            methods[name] = {"model": model, "error": f"{type(exc).__name__}: {str(exc)[:400]}"}
    return methods


def run_pysentimiento(private_message_sets=None):
    try:
        from pysentimiento import create_analyzer
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {str(exc)[:400]}"}

    started = time.perf_counter()
    try:
        analyzer = create_analyzer(task="sentiment", lang="en")
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {str(exc)[:400]}"}
    load_ms = round((time.perf_counter() - started) * 1000, 1)

    def score_from_output(output):
        probas = getattr(output, "probas", {}) or {}
        scores = {anchor: 0.0 for anchor in ANCHORS}
        scores["warmth_affection"] = float(probas.get("POS", 0.0))
        scores["joy_playfulness"] = float(probas.get("POS", 0.0)) * 0.7
        scores["anger_friction"] = float(probas.get("NEG", 0.0))
        scores["sadness_distance"] = float(probas.get("NEG", 0.0)) * 0.6
        scores["neutral_logistical"] = float(probas.get("NEU", 0.0))
        return normalize(scores)

    private_rows = []
    private_infer_ms = None
    if private_message_sets:
        infer_started = time.perf_counter()
        private_window_count = 0
        for private_set in private_message_sets:
            scored = []
            for window in rolling_windows(private_set["messages"]):
                text = "\n".join(message["content"] for message in window["messages"])[:2000]
                output = analyzer.predict(text)
                scores = score_from_output(output)
                scored.append({"index": window["index"], "scores": scores, "dominant": dominant(scores)})
                private_window_count += 1
            shifted = shift_rows(scored)
            private_rows.append({
                "id": private_set["id"],
                "windowCount": len(shifted),
                "dominantDistribution": dict(Counter(row["dominant"] for row in shifted)),
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
                )[:5],
                "changeDetection": change_detection(shifted),
            })
        private_infer_ms = round((time.perf_counter() - infer_started) * 1000 / max(1, private_window_count), 1)

    return {
        "model": "pysentimiento sentiment/en",
        "loadMs": load_ms,
        "privateAvgWindowInferMs": private_infer_ms,
        "privateAggregate": private_rows,
    }


def redact(text):
    return re.sub(r"\b[A-Z][a-z]+\b", "[name]", text)[:120]


def redact_model_output(output):
    if isinstance(output, list):
        output = output[:6]
    return output


def change_detection(rows):
    result = {"rollingThreshold": [], "ruptures": {}, "riverAdwin": {}}
    result["rollingThreshold"] = [
        {"index": row["index"], "shiftMagnitude": row["shiftMagnitude"], "zMax": row["zMax"], "dominant": row["dominant"]}
        for row in rows
        if row["shiftMagnitude"] >= 0.6 or row["zMax"] >= 2.5
    ][:8]
    try:
        import numpy as np
        import ruptures as rpt

        signal = np.array([[row["scores"][anchor] for anchor in ANCHORS] for row in rows], dtype=float)
        if len(signal) >= 8:
            algo = rpt.Pelt(model="rbf").fit(signal)
            result["ruptures"] = {"breakpoints": [int(x) for x in algo.predict(pen=2.0)]}
        else:
            result["ruptures"] = {"skipped": "needs at least 8 windows"}
    except Exception as exc:
        result["ruptures"] = {"error": f"{type(exc).__name__}: {str(exc)[:200]}"}
    try:
        from river.drift import ADWIN

        detector = ADWIN(delta=0.01)
        events = []
        for row in rows:
            detector.update(row["shiftMagnitude"])
            if detector.drift_detected:
                events.append({"index": row["index"], "shiftMagnitude": row["shiftMagnitude"]})
        result["riverAdwin"] = {"events": events[:8]}
    except Exception as exc:
        result["riverAdwin"] = {"error": f"{type(exc).__name__}: {str(exc)[:200]}"}
    return result


def keyphrases_for_synthetic(arcs):
    try:
        from sklearn.feature_extraction.text import TfidfVectorizer
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {str(exc)[:200]}"}
    docs = [" ".join(arc["messages"]) for arc in arcs]
    vectorizer = TfidfVectorizer(stop_words="english", ngram_range=(1, 2), max_features=40)
    matrix = vectorizer.fit_transform(docs)
    terms = vectorizer.get_feature_names_out()
    rows = []
    for i, arc in enumerate(arcs):
        scored = sorted(zip(terms, matrix[i].toarray()[0]), key=lambda item: item[1], reverse=True)
        rows.append({"id": arc["id"], "phrases": [term for term, score in scored[:8] if score > 0]})
    return {"method": "sklearn_tfidf", "rows": rows, "privatePolicy": "not persisted for private messages to avoid leaking raw topics"}


def summarize_method(name, messages, scorer):
    started = time.perf_counter()
    rows = shift_rows(score_windows(messages, scorer))
    elapsed = time.perf_counter() - started
    return {
        "method": name,
        "avgWindowMs": round((elapsed * 1000) / max(1, len(rows)), 3),
        "dominantDistribution": dict(Counter(row["dominant"] for row in rows)),
        "topShifts": sorted(
            [
                {
                    "index": row["index"],
                    "dominant": row["dominant"],
                    "shiftMagnitude": row["shiftMagnitude"],
                    "zMax": row["zMax"],
                    "deltas": row["deltas"],
                }
                for row in rows
            ],
            key=lambda row: row["shiftMagnitude"],
            reverse=True,
        )[:5],
        "changeDetection": change_detection(rows),
    }


def summarize_batch_message_method(name, messages, batch_scorer):
    started = time.perf_counter()
    message_scores = batch_scorer(messages)
    rows = shift_rows(score_windows_from_message_scores(messages, message_scores))
    elapsed = time.perf_counter() - started
    return {
        "method": name,
        "avgWindowMs": round((elapsed * 1000) / max(1, len(rows)), 3),
        "dominantDistribution": dict(Counter(row["dominant"] for row in rows)),
        "topShifts": sorted(
            [
                {
                    "index": row["index"],
                    "dominant": row["dominant"],
                    "shiftMagnitude": row["shiftMagnitude"],
                    "zMax": row["zMax"],
                    "deltas": row["deltas"],
                }
                for row in rows
            ],
            key=lambda row: row["shiftMagnitude"],
            reverse=True,
        )[:5],
        "changeDetection": change_detection(rows),
    }


def synthetic_eval(summary_by_arc):
    rows = []
    for arc in SYNTHETIC_ARCS:
        expected = set(arc["expected"])
        for method_row in summary_by_arc[arc["id"]]:
            actual = set(method_row["dominantDistribution"].keys())
            hits = len(expected & actual)
            rows.append({
                "arc": arc["id"],
                "method": method_row["method"],
                "expected": sorted(expected),
                "actualDominants": sorted(actual),
                "hitRate": round(hits / len(expected), 3),
                "passed": hits >= min(2, len(expected)),
            })
    return rows


def main():
    args = parse_args()
    OUT_DIR.mkdir(exist_ok=True)
    methods = {
        "vader": score_vader(),
        "textblob": score_textblob(),
        "afinn": score_afinn(),
        "nrclex": score_nrclex(),
        "vad_proxy": score_vad_proxy(),
        "emoji_keyword_features": score_features(),
        "relationship_proxy_features": score_relationship_features(),
    }
    batch_methods = {
        "node_sentiment": score_node_sentiment_messages,
    }
    synthetic_summaries = {}
    for arc in SYNTHETIC_ARCS:
        messages = [{"content": text} for text in arc["messages"]]
        synthetic_summaries[arc["id"]] = [
            summarize_method(name, messages, scorer) for name, scorer in methods.items()
        ] + [
            summarize_batch_message_method(name, messages, scorer) for name, scorer in batch_methods.items()
        ]

    private_summaries = []
    private_message_sets = []
    if args.private:
        for index, conversation in enumerate(load_private_conversations(args.private_limit), start=1):
            messages = load_private_messages(conversation["id"])
            private_message_sets.append({"id": f"private_c{index:02}", "messages": messages})
            private_summaries.append({
                "id": f"private_c{index:02}",
                "messageCount": len(messages),
                "methods": [summarize_method(name, messages, scorer) for name, scorer in methods.items()]
                + [summarize_batch_message_method(name, messages, scorer) for name, scorer in batch_methods.items()],
            })

    hf_samples = [text for arc in SYNTHETIC_ARCS for text in arc["messages"][:4]]
    hf = run_hf_methods(
        hf_samples,
        private_message_sets if args.private else [],
        extended=args.hf_extended,
    ) if args.hf else {"skipped": "pass --hf to download and run local HF classifiers"}
    pysentimiento = run_pysentimiento(private_message_sets if args.private else []) if args.pysentimiento else {"skipped": "pass --pysentimiento"}

    result = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "anchors": ANCHORS,
        "windowSize": WINDOW_SIZE,
        "stride": STRIDE,
        "synthetic": synthetic_summaries,
        "syntheticEval": synthetic_eval(synthetic_summaries),
        "privateAggregate": private_summaries,
        "hfClassifiers": hf,
        "pysentimiento": pysentimiento,
        "keyphrases": keyphrases_for_synthetic(SYNTHETIC_ARCS),
        "notes": {
            "goEmotionsCollapse": GOEMOTIONS_TO_ANCHOR,
            "ekmanCollapse": EKMAN_TO_ANCHOR,
            "twitterEmotionCollapse": TWITTER_EMOTION_TO_ANCHOR,
            "dairCollapse": DAIR_TO_ANCHOR,
            "privateDataPolicy": "private message text used only in memory; output is anonymized aggregate scores and shifts",
        },
    }
    out_path = OUT_DIR / "python-method-results.json"
    out_path.write_text(json.dumps(result, indent=2) + "\n")
    hf_summary = hf
    if isinstance(hf, dict):
        hf_summary = {
            name: ({key: value for key, value in row.items() if key in {"model", "loadMs", "avgInferMs", "error"}} if isinstance(row, dict) else row)
            for name, row in hf.items()
        }
    print(json.dumps({
        "outPath": str(out_path),
        "syntheticPassRates": dict(Counter(row["method"] for row in result["syntheticEval"] if row["passed"])),
        "privateConversations": len(private_summaries),
        "hf": hf_summary,
        "pysentimiento": {key: value for key, value in pysentimiento.items() if key in {"model", "loadMs", "privateAvgWindowInferMs", "error", "skipped"}} if isinstance(pysentimiento, dict) else pysentimiento,
    }, indent=2))


if __name__ == "__main__":
    main()
