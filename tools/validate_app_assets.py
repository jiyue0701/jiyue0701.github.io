import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "app/public"
PLAN_SOURCE = ROOT / "app/src/data/plan.ts"
CATALOG = json.loads((ROOT / "app/src/data/motion_catalog.json").read_text(encoding="utf-8"))
MANIFEST = json.loads((PUBLIC / "media/actions/asset-manifest.json").read_text(encoding="utf-8"))


def main() -> int:
    source = PLAN_SOURCE.read_text(encoding="utf-8")
    catalog_start = source.index("const exerciseCatalog")
    preset_start = source.index("export const planPresets")
    catalog_source = source[catalog_start:preset_start]
    exercise_ids = re.findall(r"^\s*id: '([^']+)'", catalog_source, re.MULTILINE)
    catalog_ids = [item["exercise"] for item in CATALOG]
    video_files = list((PUBLIC / "media/actions/videos").glob("*.webm")) + list((PUBLIC / "media/actions/videos").glob("*.mp4"))
    poster_files = list((PUBLIC / "media/actions/posters").glob("*.png"))
    audio_files = list((PUBLIC / "media/audio").glob("count-low-*.wav"))
    failures = []
    if len(exercise_ids) != 28:
        failures.append(f"exercise catalog count is {len(exercise_ids)}, expected 28")
    if sorted(exercise_ids) != sorted(catalog_ids):
        failures.append("exercise ids and motion catalog ids differ")
    if len(video_files) != 56:
        failures.append(f"formal video count is {len(video_files)}, expected 56")
    if len(poster_files) != 28:
        failures.append(f"poster count is {len(poster_files)}, expected 28")
    if len(audio_files) != 80:
        failures.append(f"count audio count is {len(audio_files)}, expected 80")
    if MANIFEST.get("pendingActionRequests") or MANIFEST.get("posterCandidates"):
        failures.append("asset manifest still contains pending/candidate entries")
    stale = re.findall(r"pending|candidate|待补|待接入|待验收|占位", source, re.IGNORECASE)
    if stale:
        failures.append(f"stale asset markers remain in plan source: {len(stale)}")
    print(f"APP ASSET VALIDATION: {'approved' if not failures else 'blocked'}")
    print(f"EXERCISES {len(exercise_ids)} | MOTIONS {len(CATALOG)} | VIDEOS {len(video_files)} | POSTERS {len(poster_files)} | AUDIO {len(audio_files)}")
    for failure in failures:
        print(f"FAIL {failure}")
    return 0 if not failures else 2


if __name__ == "__main__":
    raise SystemExit(main())
