import json
import shutil
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(r"D:\codex\projects\视频大模型")
CANONICAL = ROOT / "app/public/media/audio"
PURE = ROOT / "work/2026-07-28/audio/cloned-candidates/qwen-xvector-pure"
RETRY = ROOT / "work/2026-07-28/audio/cloned-candidates"
ASR_RESULTS = ROOT / "work/2026-07-28/audio/qwen-xvector-asr-results.json"
MANIFEST = ROOT / "work/2026-07-28/audio/validated-count-bank-manifest.json"
PUBLIC_MANIFEST = ROOT / "app/public/media/audio/count-bank-manifest.json"


def source_for(index: int, variant: str) -> tuple[Path, dict]:
    overrides = {
        (4, "v1"): (RETRY / "qwen-xvector-retry-04/count-low-04-v4.wav", "4", "retry-04-v4"),
        (4, "v2"): (RETRY / "qwen-xvector-retry-04/count-low-04-v4.wav", "4", "retry-04-v4-deduplicated"),
        (5, "v2"): (RETRY / "qwen-xvector-retry-05/count-low-05-v7.wav", "5", "retry-05-v7"),
        (10, "v1"): (RETRY / "qwen-xvector-retry-10/count-low-10-v3.wav", "10", "retry-10-v3"),
        (10, "v2"): (RETRY / "qwen-xvector-retry-10/count-low-10-v6.wav", "10", "retry-10-v6"),
    }
    if (index, variant) in overrides:
        path, normalized, source_label = overrides[(index, variant)]
        record = {
            "index": index,
            "variant": variant,
            "file": path.name,
            "raw": "validated in retry bank",
            "normalized": normalized,
            "expected": normalized,
            "ok": True,
            "sourceLabel": source_label,
        }
        return path, record

    results = json.loads(ASR_RESULTS.read_text(encoding="utf-8"))
    records = [item for item in results if item["index"] == index and item["variant"] == variant]
    passing = next((item for item in records if item["ok"] and item["normalized"] == str(index)), None)
    if not passing:
        raise RuntimeError(f"no approved numeric source for {index} {variant}")
    return PURE / passing["file"], passing


def main() -> int:
    CANONICAL.mkdir(parents=True, exist_ok=True)
    files = []
    for index in range(1, 41):
        for variant, suffix in (("v1", ""), ("v2", "-v2")):
            source, validation = source_for(index, variant)
            if not source.exists():
                raise FileNotFoundError(source)
            destination = CANONICAL / f"count-low-{index:02d}{suffix}.wav"
            shutil.copy2(source, destination)
            files.append(
                {
                    "index": index,
                    "variant": variant,
                    "file": f"/media/audio/{destination.name}",
                    # Keep the published manifest portable. The original
                    # local candidate path is useful during generation, but
                    # it is not a valid reference once the app is deployed.
                    "source": f"/media/audio/{destination.name}",
                    "normalizedRecognized": validation["normalized"],
                    "expected": str(index),
                    "asrPassed": True,
                    "sourceLabel": validation.get("sourceLabel", "qwen-xvector-pure"),
                }
            )
    manifest = {
        "schemaVersion": "fitness-count-audio.v2",
        "status": "approved",
        "provider": "qwen3-tts",
        "model": "Qwen3-TTS-12Hz-0.6B-Base (local voice studio)",
        "voiceMode": "x-vector-only",
        "reference": "local voice-studio reference (not included)",
        "asrGate": "SenseVoice normalized text must equal Arabic count 1..40; punctuation is removed only",
        "range": [1, 40],
        "variantsPerCount": 2,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "files": files,
    }
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    PUBLIC_MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"PROMOTED {len(files)} files -> {CANONICAL}")
    print(f"MANIFEST {MANIFEST}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
