import argparse
import json
import re
from pathlib import Path

import matplotlib.colors as mcolors
import matplotlib.pyplot as plt
import numpy as np


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
    parser.add_argument("--input", default="out/harness-ax-large-results.json")
    parser.add_argument("--conversation", required=True)
    parser.add_argument("--source", choices=["deterministic", "llm"], default="deterministic")
    parser.add_argument("--method", default="roberta_emotion")
    parser.add_argument("--window-size", type=int, default=16)
    parser.add_argument("--stride", type=int, default=8)
    parser.add_argument("--llm-run")
    parser.add_argument("--chart", choices=["heatmap", "line"], default="line")
    parser.add_argument("--out", required=True)
    return parser.parse_args()


def deterministic_rows(result, args):
    method = next(
        (
            row
            for row in result.get("deterministic", [])
            if row.get("name") == args.method
            and row.get("window", {}).get("size") == args.window_size
            and row.get("window", {}).get("stride") == args.stride
        ),
        None,
    )
    if not method:
        raise SystemExit(f"No deterministic method={args.method} window={args.window_size}/{args.stride}")
    conversation = next((row for row in method.get("conversations", []) if row.get("id") == args.conversation), None)
    if not conversation:
        raise SystemExit(f"No conversation {args.conversation} in deterministic result")
    return conversation.get("rows", []), f"{args.method} {args.window_size}/{args.stride}"


def llm_rows(result, args):
    run = next(
        (
            row
            for row in result.get("llm", [])
            if (args.llm_run and row.get("name") == args.llm_run)
            or (
                not args.llm_run
                and row.get("runMode") == "all_windows"
                and row.get("window", {}).get("size") == args.window_size
                and row.get("window", {}).get("stride") == args.stride
            )
        ),
        None,
    )
    if not run:
        raise SystemExit("No matching LLM all-window run. Pass --llm-run to choose one.")
    rows = []
    prefix = f"{args.conversation}_w"
    for row in run.get("rows", []):
        if not row.get("ok") or not str(row.get("windowRef", "")).startswith(prefix):
            continue
        match = re.search(r"_w(\d+)$", row["windowRef"])
        if not match:
            continue
        rows.append(
            {
                "index": int(match.group(1)),
                "scores": row.get("scores", {}),
                "dominant": row.get("dominant"),
                "confidence": row.get("confidence"),
            }
        )
    rows.sort(key=lambda row: row["index"])
    if not rows:
        raise SystemExit(f"No LLM rows for {args.conversation} in {run.get('name')}")
    return rows, run.get("name", "llm")


def matrix(rows):
    scores = np.array([[float(row.get("scores", {}).get(anchor, 0)) for row in rows] for anchor in ANCHORS])
    dominant = [row.get("dominant") or ANCHORS[int(np.argmax(scores[:, idx]))] for idx, row in enumerate(rows)]
    return scores, dominant


def smooth(values, width=5):
    if width <= 1 or len(values) < 3:
        return values
    radius = width // 2
    smoothed = []
    for index in range(len(values)):
        start = max(0, index - radius)
        end = min(len(values), index + radius + 1)
        smoothed.append(sum(values[start:end]) / (end - start))
    return smoothed


def dominant_segments(dominant):
    if not dominant:
        return []
    segments = []
    start = 0
    current = dominant[0]
    for index, anchor in enumerate(dominant[1:], start=1):
        if anchor == current:
            continue
        segments.append((start, index - 1, current))
        start = index
        current = anchor
    segments.append((start, len(dominant) - 1, current))
    return segments


def shift_indexes(scores):
    if scores.shape[1] < 2:
        return []
    deltas = np.linalg.norm(np.diff(scores, axis=1), axis=0)
    if len(deltas) == 0:
        return []
    threshold = float(np.quantile(deltas, 0.9))
    return [index + 1 for index, value in enumerate(deltas) if value >= threshold and value > 0]


def plot_heatmap(rows, title, out):
    scores, dominant = matrix(rows)
    windows = [row.get("index", idx) for idx, row in enumerate(rows)]
    dominant_rgb = np.array([[mcolors.to_rgb(COLORS.get(anchor, "#999999")) for anchor in dominant]])

    width = max(12, min(24, len(windows) * 0.18))
    fig = plt.figure(figsize=(width, 7.5))
    grid = fig.add_gridspec(3, 1, height_ratios=[0.35, 4.8, 1.35], hspace=0.12)

    strip = fig.add_subplot(grid[0])
    strip.imshow(dominant_rgb, aspect="auto")
    strip.set_yticks([])
    strip.set_xticks([])
    strip.set_title(f"{title}: dominant emotion strip", fontsize=12, pad=8)

    heat = fig.add_subplot(grid[1])
    image = heat.imshow(scores, aspect="auto", interpolation="nearest", cmap="YlOrRd", vmin=0, vmax=1)
    heat.set_yticks(range(len(ANCHORS)))
    heat.set_yticklabels([anchor.replace("_", " ") for anchor in ANCHORS])
    heat.set_ylabel("Emotion anchor")
    heat.set_title("Chunked-window emotion intensity heatmap", fontsize=13)
    heat.grid(which="minor", color="white", linewidth=0.2)
    fig.colorbar(image, ax=heat, label="Score")

    if len(windows) <= 40:
        ticks = range(len(windows))
    else:
        step = max(1, len(windows) // 16)
        ticks = range(0, len(windows), step)
    heat.set_xticks(list(ticks))
    heat.set_xticklabels([str(windows[idx]) for idx in ticks])

    bars = fig.add_subplot(grid[2], sharex=heat)
    bottoms = np.zeros(len(windows))
    xs = np.arange(len(windows))
    for anchor_index, anchor in enumerate(ANCHORS):
        values = scores[anchor_index]
        bars.bar(xs, values, bottom=bottoms, width=1.0, color=COLORS[anchor], label=anchor.replace("_", " "))
        bottoms += values
    bars.set_ylabel("Stacked\nscore")
    bars.set_xlabel("Chunked window index over conversation time")
    bars.set_xlim(-0.5, len(windows) - 0.5)
    bars.legend(ncols=3, fontsize=8, loc="upper right")

    fig.suptitle(title, fontsize=15, y=0.985)
    fig.tight_layout(rect=[0, 0, 1, 0.96])
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, dpi=180)
    plt.close(fig)


def plot_line(rows, title, out):
    scores, dominant = matrix(rows)
    windows = np.array([row.get("index", idx) for idx, row in enumerate(rows)])
    shifts = shift_indexes(scores)

    fig = plt.figure(figsize=(16, 8.5))
    grid = fig.add_gridspec(4, 1, height_ratios=[0.35, 4.8, 1.2, 0.45], hspace=0.08)

    strip = fig.add_subplot(grid[0])
    dominant_rgb = np.array([[mcolors.to_rgb(COLORS.get(anchor, "#999999")) for anchor in dominant]])
    strip.imshow(dominant_rgb, aspect="auto")
    strip.set_yticks([])
    strip.set_xticks([])
    strip.set_title("Dominant anchor by chunk", fontsize=10, pad=5)

    ax = fig.add_subplot(grid[1], sharex=strip)
    for start, end, anchor in dominant_segments(dominant):
        ax.axvspan(windows[start] - 0.5, windows[end] + 0.5, color=COLORS[anchor], alpha=0.045, linewidth=0)
    for anchor_index, anchor in enumerate(ANCHORS):
        raw = scores[anchor_index]
        smoothed = smooth(list(raw), 5)
        ax.plot(windows, raw, color=COLORS[anchor], alpha=0.18, linewidth=1)
        ax.plot(windows, smoothed, color=COLORS[anchor], linewidth=2.2, label=anchor.replace("_", " "))
    for shift in shifts:
        ax.axvline(windows[shift], color="#111111", alpha=0.12, linewidth=1)
    ax.set_title("Emotion scores over conversation chunks", fontsize=14)
    ax.set_ylabel("Score")
    ax.set_ylim(-0.03, 1.03)
    ax.grid(alpha=0.18)
    ax.legend(ncols=3, fontsize=9, loc="upper right")

    confidence = [row.get("confidence") for row in rows if row.get("confidence") is not None]
    conf_ax = fig.add_subplot(grid[2], sharex=ax)
    if len(confidence) == len(rows):
        conf_ax.plot(windows, confidence, color="#222222", linewidth=1.8)
        conf_ax.fill_between(windows, confidence, 0, color="#222222", alpha=0.08)
        conf_ax.set_ylim(0, 1.03)
        conf_ax.set_ylabel("Confidence")
    else:
        totals = scores.sum(axis=0)
        conf_ax.plot(windows, totals, color="#222222", linewidth=1.8)
        conf_ax.fill_between(windows, totals, 0, color="#222222", alpha=0.08)
        conf_ax.set_ylabel("Total\nsignal")
    conf_ax.grid(alpha=0.18)

    label_ax = fig.add_subplot(grid[3], sharex=ax)
    label_ax.set_ylim(0, 1)
    label_ax.set_yticks([])
    label_ax.set_xlabel("Chunked window index over conversation time")
    for shift in shifts:
        label_ax.axvline(windows[shift], color="#111111", alpha=0.18, linewidth=1)
    label_ax.text(
        0,
        0.5,
        f"{len(rows)} chunks | dark vertical marks = largest score changes | faint background = dominant anchor",
        va="center",
        fontsize=9,
        color="#333333",
    )

    for axis in [strip, ax, conf_ax]:
        plt.setp(axis.get_xticklabels(), visible=False)
    fig.suptitle(title, fontsize=16, y=0.985)
    fig.tight_layout(rect=[0, 0, 1, 0.955])
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, dpi=180)
    plt.close(fig)


def main():
    args = parse_args()
    result = json.loads(Path(args.input).read_text())
    if args.source == "deterministic":
        rows, label = deterministic_rows(result, args)
    else:
        rows, label = llm_rows(result, args)
    title = f"{args.conversation} {label} ({len(rows)} chunks)"
    if args.chart == "heatmap":
        plot_heatmap(rows, title, args.out)
    else:
        plot_line(rows, title, args.out)
    print(json.dumps({"out": args.out, "conversation": args.conversation, "source": args.source, "chart": args.chart, "chunks": len(rows)}, indent=2))


if __name__ == "__main__":
    main()
