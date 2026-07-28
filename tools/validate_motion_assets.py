import json
from datetime import datetime, timezone
from pathlib import Path

import av


ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "app/public"
CATALOG_PATH = ROOT / "app/src/data/motion_catalog.json"
MANIFEST_PATH = PUBLIC / "media/actions/asset-manifest.json"
REPORT_PATH = ROOT / "audit/motion-assets-report.json"


def local_path(uri: str) -> Path:
    return PUBLIC / uri.lstrip("/").replace("/", "\u005c")


def inspect_video(path: Path) -> dict:
    with av.open(str(path)) as container:
        stream = container.streams.video[0]
        frame_count = 0
        width = stream.width
        height = stream.height
        for frame in container.decode(stream):
            frame_count += 1
            width = frame.width
            height = frame.height
        rate = float(stream.average_rate) if stream.average_rate else 0.0
        return {
            "framesDecoded": frame_count,
            "width": width,
            "height": height,
            "fps": rate,
            "codec": str(stream.codec_context.name),
        }


def main() -> int:
    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    failures = []
    actions = []
    for item in catalog:
        entry = {"id": item["id"], "files": {}, "ok": True}
        for field in ("poster", "webm", "mp4"):
            uri = item.get(field)
            if not uri:
                entry["ok"] = False
                failures.append(f"{item['id']}: missing catalog field {field}")
                continue
            path = local_path(uri)
            entry["files"][field] = str(path)
            if not path.exists() or path.stat().st_size < 1024:
                entry["ok"] = False
                failures.append(f"{item['id']}: missing or tiny {field}: {path}")
        for frame_uri in item.get("frameUris", []):
            path = local_path(frame_uri)
            if not path.exists():
                entry["ok"] = False
                failures.append(f"{item['id']}: missing frame {path}")
        for field, expected_codec in (("webm", "vp9"), ("mp4", "h264")):
            path = local_path(item[field])
            if not path.exists():
                continue
            try:
                details = inspect_video(path)
                entry[field] = details
                if details["framesDecoded"] < 2 or details["fps"] != 30.0:
                    entry["ok"] = False
                    failures.append(f"{item['id']}: {field} is not a decodable 30fps stream: {details}")
                if expected_codec not in details["codec"]:
                    entry["ok"] = False
                    failures.append(f"{item['id']}: unexpected {field} codec {details['codec']}")
            except Exception as exc:
                entry["ok"] = False
                failures.append(f"{item['id']}: failed decoding {field}: {exc!r}")
        actions.append(entry)

    approved = manifest.get("approvedFrameSequences", [])
    report = {
        "schemaVersion": "fitness-motion-validation.v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "catalogCount": len(catalog),
        "manifestApprovedCount": len(approved),
        "pendingActionRequests": manifest.get("pendingActionRequests", []),
        "candidatePosters": manifest.get("posterCandidates", []),
        "actions": actions,
        "failures": failures,
        "status": "approved" if len(catalog) == len(approved) and not failures else "blocked",
    }
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"MOTION VALIDATION: {report['status']}")
    print(f"ACTIONS {len(catalog)} | APPROVED MANIFEST {len(approved)} | FAILURES {len(failures)}")
    for failure in failures:
        print(f"FAIL {failure}")
    return 0 if report["status"] == "approved" else 2


if __name__ == "__main__":
    raise SystemExit(main())
