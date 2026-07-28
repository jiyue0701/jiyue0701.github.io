from __future__ import annotations

import argparse
import json
from fractions import Fraction
from pathlib import Path

import av
from PIL import Image, ImageOps, ImageSequence


ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATH = ROOT / "app" / "src" / "data" / "motion_catalog.json"
PUBLIC = ROOT / "app" / "public"
VIDEO_DIR = PUBLIC / "media" / "actions" / "videos"


EXTRA_ACTIONS = {
    "dumbbell-lateral-raise": ("Dumbbell lateral raise", "肩部与三角肌中束", "站立哑铃侧平举"),
    "dumbbell-biceps-curl": ("Dumbbell biceps curl", "上臂与肱二头肌", "站立哑铃弯举"),
    "dead-bug": ("Dead bug", "核心稳定与腹横肌", "死虫式"),
    "forearm-plank": ("Forearm plank", "核心稳定", "前臂平板支撑"),
    "chair-knee-raise": ("Chair-assisted knee raise", "髋屈肌与核心", "椅子辅助抬膝"),
    "standing-calf-raise": ("Standing calf raise", "小腿", "站姿提踵"),
    "wall-push-up": ("Wall push-up", "胸部与三角肌前束", "墙壁俯卧撑"),
    "chair-supported-hip-abduction": ("Chair-supported hip abduction", "髋稳定与臀中肌", "椅子辅助站姿髋外展"),
    "chair-hamstring-curl": ("Chair-assisted hamstring curl", "腿后侧", "椅子辅助站姿腿弯举"),
    "chair-seated-knee-extension": ("Seated chair knee extension", "大腿前侧", "椅子坐姿膝伸展"),
    "seated-chair-march": ("Seated chair march", "核心与髋屈肌", "椅子坐姿交替抬膝"),
    "dumbbell-bent-over-row": ("Dumbbell bent-over row", "背部与上臂", "双臂哑铃俯身划船"),
    "dumbbell-farmer-carry": ("Dumbbell farmer carry", "核心抗侧屈与握力", "哑铃农夫走"),
    "dumbbell-fly": ("Dumbbell fly", "胸部与肩前束", "哑铃飞鸟"),
    "dumbbell-bench-press": ("Dumbbell bench press", "胸部与肱三头肌", "哑铃卧推"),
    "dumbbell-floor-press": ("Dumbbell floor press", "胸部与肱三头肌", "哑铃地板卧推"),
}


def local_path(uri: str) -> Path:
    return PUBLIC / uri.lstrip("/").replace("/", "\\")


def normalize_image(image: Image.Image) -> Image.Image:
    image = image.convert("RGB")
    width = image.width - (image.width % 2)
    height = image.height - (image.height % 2)
    if image.size != (width, height):
        image = image.resize((width, height), Image.Resampling.LANCZOS)
    return image


def gif_frames(path: Path):
    with Image.open(path) as source:
        frames: list[Image.Image] = []
        durations: list[float] = []
        for frame in ImageSequence.Iterator(source):
            frames.append(normalize_image(frame.copy()))
            duration_ms = max(20, int(frame.info.get("duration", 100)))
            durations.append(duration_ms / 1000.0)
        return frames, durations


def keyframe_frames(entry: dict):
    frames = [normalize_image(Image.open(local_path(uri))) for uri in entry.get("frameUris", [])]
    durations = entry.get("frameDurations") or [entry["loopDuration"] / max(1, len(frames))] * len(frames)
    return frames, [float(value) for value in durations]


def encode_video(entry: dict, source_mode: str, codec: str, output: Path):
    if source_mode == "gif":
        frames, durations = gif_frames(local_path(entry["loop"]))
    else:
        frames, durations = keyframe_frames(entry)
    if not frames:
        raise RuntimeError(f"No frames for {entry['id']}")

    width, height = frames[0].size
    for frame in frames:
        if frame.size != (width, height):
            raise RuntimeError(f"Mixed frame size in {entry['id']}: {frame.size} != {(width, height)}")

    output.parent.mkdir(parents=True, exist_ok=True)
    container_format = "webm" if codec == "libvpx-vp9" else "mp4"
    container = av.open(str(output), mode="w", format=container_format)
    try:
        stream = container.add_stream(codec, rate=30)
        stream.width = width
        stream.height = height
        stream.pix_fmt = "yuv420p"
        stream.time_base = Fraction(1, 30)
        if codec == "libvpx-vp9":
            stream.options = {"crf": "32", "b": "0", "deadline": "good"}
        else:
            stream.options = {"crf": "28", "preset": "fast"}
        frame_index = 0
        for source_frame, duration in zip(frames, durations):
            repeat = max(1, round(duration * 30))
            for _ in range(repeat):
                video_frame = av.VideoFrame.from_image(source_frame)
                video_frame.pts = frame_index
                video_frame.time_base = Fraction(1, 30)
                frame_index += 1
                for packet in stream.encode(video_frame):
                    container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)
    finally:
        container.close()


def update_catalog() -> list[dict]:
    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    by_exercise = {entry["exercise"]: entry for entry in catalog}
    for exercise_id, (_english, target, label) in EXTRA_ACTIONS.items():
        if exercise_id in by_exercise:
            continue
        poster = f"/media/actions/posters/{exercise_id}-poster.png"
        setup = f"/media/actions/frames/{exercise_id}-setup.png"
        peak = f"/media/actions/frames/{exercise_id}-peak.png"
        entry = {
            "id": f"{exercise_id}.v1",
            "exercise": exercise_id,
            "character": "wriothesley-coach",
            "assetType": "video",
            "loop": f"/media/actions/videos/{exercise_id}.webm",
            "webm": f"/media/actions/videos/{exercise_id}.webm",
            "mp4": f"/media/actions/videos/{exercise_id}.mp4",
            "poster": poster,
            "frameUris": [setup, peak, setup],
            "frameDurations": [1.25, 1.5, 1.25],
            "width": 0,
            "height": 0,
            "fps": 30,
            "loopDuration": 4.0,
            "loopSeam": {"startFrame": 0, "endFrame": 2},
            "phases": [
                {"id": "setup", "start": 0.0, "end": 0.31},
                {"id": "working", "start": 0.31, "end": 0.69},
                {"id": "return", "start": 0.69, "end": 1.0},
            ],
            "cues": [{"time": 0.69, "type": "rep_checkpoint"}],
            "accessibility": {"altText": f"莱欧斯利训练教练演示{label}"},
            "target": target,
        }
        catalog.append(entry)
        by_exercise[exercise_id] = entry

    for entry in catalog:
        exercise_id = entry["exercise"]
        entry["assetType"] = "video"
        entry["webm"] = f"/media/actions/videos/{exercise_id}.webm"
        entry["mp4"] = f"/media/actions/videos/{exercise_id}.mp4"
        if entry.get("frameUris"):
            first = local_path(entry["frameUris"][0])
            with Image.open(first) as image:
                entry["width"], entry["height"] = image.width, image.height
        if exercise_id in EXTRA_ACTIONS:
            entry["loop"] = entry["webm"]
            entry["poster"] = f"/media/actions/posters/{exercise_id}-poster.png"
            entry["frameUris"] = [
                f"/media/actions/frames/{exercise_id}-setup.png",
                f"/media/actions/frames/{exercise_id}-peak.png",
                f"/media/actions/frames/{exercise_id}-setup.png",
            ]
            entry["frameDurations"] = [1.25, 1.5, 1.25]
            with Image.open(local_path(entry["frameUris"][0])) as image:
                entry["width"], entry["height"] = image.width, image.height

    CATALOG_PATH.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return catalog


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", nargs="*", help="Only encode these exercise ids")
    parser.add_argument("--skip-catalog", action="store_true")
    args = parser.parse_args()
    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8")) if args.skip_catalog else update_catalog()
    selected = set(args.only or [entry["exercise"] for entry in catalog])
    for entry in catalog:
        if entry["exercise"] not in selected:
            continue
        mode = "gif" if entry.get("loop", "").endswith(".gif") else "keyframes"
        encode_video(entry, mode, "libvpx-vp9", VIDEO_DIR / f"{entry['exercise']}.webm")
        encode_video(entry, mode, "libx264", VIDEO_DIR / f"{entry['exercise']}.mp4")
        print(f"encoded {entry['exercise']} ({mode})")


if __name__ == "__main__":
    main()
