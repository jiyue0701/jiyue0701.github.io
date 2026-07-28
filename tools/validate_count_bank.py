import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, r"D:\codex\projects\audio-voice-studio")
from src.transcriber import transcribe_audio


ROOT = Path(r"D:\codex\projects\视频大模型")
CANDIDATE_ROOT = Path(os.environ.get("COUNT_BANK_ROOT", str(ROOT / "work/2026-07-28/audio/cloned-candidates/qwen-xvector-pure")))
RESULT_PATH = ROOT / "work/2026-07-28/audio/qwen-xvector-asr-results.json"
EXPECTED = [str(index) for index in range(1, 41)]
CHINESE_TO_ARABIC = {
    "一": "1", "二": "2", "三": "3", "四": "4", "五": "5", "六": "6", "七": "7", "八": "8", "九": "9", "十": "10",
    "十一": "11", "十二": "12", "十三": "13", "十四": "14", "十五": "15", "十六": "16", "十七": "17", "十八": "18", "十九": "19", "二十": "20",
    "二十一": "21", "二十二": "22", "二十三": "23", "二十四": "24", "二十五": "25", "二十六": "26", "二十七": "27", "二十八": "28", "二十九": "29", "三十": "30",
    "三十一": "31", "三十二": "32", "三十三": "33", "三十四": "34", "三十五": "35", "三十六": "36", "三十七": "37", "三十八": "38", "三十九": "39", "四十": "40",
}
PUNCTUATION = re.compile(r"[\s，。！？、；：,.!?;:\"“”‘’（）()\[\]{}<>《》]+")


def normalize(text: str) -> str:
    cleaned = PUNCTUATION.sub("", text.strip()).replace("〇", "零").replace("○", "零")
    return CHINESE_TO_ARABIC.get(cleaned, cleaned)


def main() -> int:
    results = []
    for index, expected in enumerate(EXPECTED, start=1):
        for suffix, label in (("", "v1"), ("-v2", "v2")):
            path = CANDIDATE_ROOT / f"count-low-{index:02d}{suffix}.wav"
            raw = ""
            error = None
            try:
                transcript = transcribe_audio(path)
                if isinstance(transcript, dict):
                    segments = transcript.get("segments", [])
                    raw = "".join(
                        segment.get("text", "") if isinstance(segment, dict) else str(segment)
                        for segment in segments
                    )
                else:
                    raw = str(transcript)
            except Exception as exc:  # keep the full bank auditable even if one file fails
                error = repr(exc)
                raw = f"ERROR:{exc}"
            normalized = normalize(raw)
            ok = normalized == expected
            results.append(
                {
                    "index": index,
                    "variant": label,
                    "file": path.name,
                    "raw": raw,
                    "normalized": normalized,
                    "expected": expected,
                    "ok": ok,
                    "error": error,
                }
            )
            print(
                f"{index:02d} {label}: {'PASS' if ok else 'FAIL'} | "
                f"{raw!r} -> {normalized!r} (want {expected!r})"
            )
    RESULT_PATH.parent.mkdir(parents=True, exist_ok=True)
    RESULT_PATH.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    passed = sum(item["ok"] for item in results)
    print(f"SUMMARY {passed}/{len(results)}")
    return 0 if passed == len(results) else 2


if __name__ == "__main__":
    raise SystemExit(main())
