import json
from pathlib import Path


path = Path(__file__).resolve().parents[1] / "app/src/data/motion_catalog.json"
catalog = json.loads(path.read_text(encoding="utf-8"))
for item in catalog:
    checkpoints = [cue for cue in item.get("cues", []) if cue.get("type") == "rep_checkpoint"]
    if not checkpoints:
        continue
    checkpoints[0]["time"] = 0.0
    if len(checkpoints) > 1:
        checkpoints[1]["time"] = 0.5
    for cue in checkpoints[2:]:
        cue["time"] = round(cue["time"], 3)
path.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"normalized {len(catalog)} motion cue sets")
