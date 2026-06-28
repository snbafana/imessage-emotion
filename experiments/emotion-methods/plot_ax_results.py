import argparse
import json
from collections import Counter
from pathlib import Path

import matplotlib.pyplot as plt


ANCHORS = [
    "anger",
    "disgust",
    "fear",
    "joy",
    "neutral",
    "sadness",
    "surprise",
]

COLORS = {
    "anger": "#B23A48",
    "disgust": "#8F5A3C",
    "fear": "#7A6FF0",
    "joy": "#E6A23C",
    "neutral": "#6A737D",
    "sadness": "#4C78A8",
    "surprise": "#2CA58D",
}


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--out-dir", required=True)
    return parser.parse_args()


def save(fig, out_dir, name):
    path = out_dir / name
    fig.tight_layout()
    fig.savefig(path, dpi=180)
    plt.close(fig)
    return str(path)


def deterministic_distribution(result, out_dir):
    rows = result.get("deterministic", [])
    labels = [f"{row['name']}\n{row['window']['size']}/{row['window']['stride']}" for row in rows]
    bottoms = [0] * len(rows)
    fig, ax = plt.subplots(figsize=(max(10, len(rows) * 1.2), 6))
    for anchor in ANCHORS:
        values = [row.get("dominantCounts", {}).get(anchor, 0) for row in rows]
        ax.bar(labels, values, bottom=bottoms, label=anchor, color=COLORS[anchor])
        bottoms = [bottom + value for bottom, value in zip(bottoms, values)]
    ax.set_title("Deterministic dominant anchors across larger private sample")
    ax.set_ylabel("Window count")
    ax.tick_params(axis="x", rotation=45, labelsize=8)
    ax.legend(ncols=3, fontsize=8)
    return save(fig, out_dir, "deterministic_dominant_distribution.png")


def deterministic_trajectories(result, out_dir):
    method = next(
        (
            row
            for row in result.get("deterministic", [])
            if row.get("name") == "roberta_emotion"
            and row.get("window", {}).get("size") == 16
        ),
        None,
    )
    if not method:
        return None
    conversations = method.get("conversations", [])[:4]
    fig, axes = plt.subplots(len(conversations), 1, figsize=(12, max(3, 2.4 * len(conversations))), sharex=False)
    if len(conversations) == 1:
        axes = [axes]
    for ax, conversation in zip(axes, conversations):
        rows = conversation.get("rows", [])
        xs = [row["index"] for row in rows]
        for anchor in ANCHORS:
            ax.plot(xs, [row["scores"].get(anchor, 0) for row in rows], label=anchor, color=COLORS[anchor], linewidth=1.4)
        ax.set_title(f"{conversation['id']} 16/8 deterministic anchor trajectory")
        ax.set_ylabel("Score")
        ax.set_ylim(0, 1.02)
        ax.grid(alpha=0.2)
    axes[-1].set_xlabel("Window index")
    axes[0].legend(ncols=3, fontsize=8, loc="upper right")
    return save(fig, out_dir, "deterministic_anchor_trajectories.png")


def llm_latency(result, out_dir):
    rows = [row for row in result.get("llm", []) if not row.get("skipped")]
    labels = [row["name"].replace("large_", "").replace("_", "\n") for row in rows]
    wall = [row.get("wallMs", 0) / 1000 for row in rows]
    avg = [(row.get("avgLatencyMs") or 0) / 1000 for row in rows]
    fig, ax = plt.subplots(figsize=(max(12, len(rows) * 1.3), 6))
    xs = range(len(rows))
    ax.bar([x - 0.2 for x in xs], wall, width=0.4, label="wall seconds", color="#4C78A8")
    ax.bar([x + 0.2 for x in xs], avg, width=0.4, label="avg request seconds", color="#F58518")
    ax.set_title("LLM latency by run")
    ax.set_ylabel("Seconds")
    ax.set_xticks(list(xs))
    ax.set_xticklabels(labels, rotation=45, ha="right", fontsize=8)
    ax.legend()
    return save(fig, out_dir, "llm_latency_by_run.png")


def llm_dominant_distribution(result, out_dir):
    rows = [row for row in result.get("llm", []) if not row.get("skipped")]
    labels = [row["name"].replace("large_", "").replace("_", "\n") for row in rows]
    bottoms = [0] * len(rows)
    fig, ax = plt.subplots(figsize=(max(12, len(rows) * 1.3), 6))
    for anchor in ANCHORS:
        values = [row.get("dominantCounts", {}).get(anchor, 0) for row in rows]
        ax.bar(labels, values, bottom=bottoms, label=anchor, color=COLORS[anchor])
        bottoms = [bottom + value for bottom, value in zip(bottoms, values)]
    ax.set_title("LLM dominant anchors by run")
    ax.set_ylabel("Scored target count")
    ax.tick_params(axis="x", rotation=45, labelsize=8)
    ax.legend(ncols=3, fontsize=8)
    return save(fig, out_dir, "llm_dominant_distribution.png")


def llm_confidence_latency(result, out_dir):
    rows = []
    for run in result.get("llm", []):
        for row in run.get("rows", []):
            if row.get("ok"):
                rows.append(
                    {
                        "run": run["name"].replace("large_", ""),
                        "dominant": row.get("dominant"),
                        "confidence": row.get("confidence", 0),
                        "latency": row.get("latencyMs", 0) / 1000,
                    }
                )
    if not rows:
        return None
    fig, ax = plt.subplots(figsize=(10, 6))
    for anchor in ANCHORS:
        points = [row for row in rows if row["dominant"] == anchor]
        if not points:
            continue
        ax.scatter(
            [row["latency"] for row in points],
            [row["confidence"] for row in points],
            label=anchor,
            color=COLORS[anchor],
            alpha=0.75,
            s=28,
        )
    ax.set_title("LLM window confidence vs latency")
    ax.set_xlabel("Latency seconds")
    ax.set_ylabel("Confidence")
    ax.set_ylim(0, 1.05)
    ax.grid(alpha=0.2)
    ax.legend(ncols=2, fontsize=8)
    return save(fig, out_dir, "llm_confidence_vs_latency.png")


def summary(result):
    llm = []
    for row in result.get("llm", []):
        llm.append(
            {
                "name": row.get("name"),
                "mode": row.get("runMode"),
                "context": row.get("contextMode"),
                "window": row.get("window"),
                "ok": row.get("okCount"),
                "errors": row.get("errorCount"),
                "wallSeconds": round((row.get("wallMs") or 0) / 1000, 2),
                "avgLatencySeconds": round((row.get("avgLatencyMs") or 0) / 1000, 2),
                "dominantCounts": row.get("dominantCounts", {}),
            }
        )
    deterministic = [
        {
            "name": row.get("name"),
            "window": row.get("window"),
            "totalWindows": row.get("totalWindows"),
            "dominantCounts": row.get("dominantCounts", {}),
        }
        for row in result.get("deterministic", [])
    ]
    return {"dataset": result.get("dataset"), "llm": llm, "deterministic": deterministic}


def main():
    args = parse_args()
    result = json.loads(Path(args.input).read_text())
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = [
        deterministic_distribution(result, out_dir),
        deterministic_trajectories(result, out_dir),
        llm_latency(result, out_dir),
        llm_dominant_distribution(result, out_dir),
        llm_confidence_latency(result, out_dir),
    ]
    summary_path = out_dir / "summary.json"
    summary_path.write_text(json.dumps(summary(result), indent=2) + "\n")
    print(json.dumps({"graphs": [path for path in paths if path], "summary": str(summary_path)}, indent=2))


if __name__ == "__main__":
    main()
