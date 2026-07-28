import os
import re
import sys
from pathlib import Path

sys.path.insert(0, r"D:\codex\projects\audio-voice-studio")
from src.transcriber import transcribe_audio
from validate_count_bank import normalize


ROOT = Path(os.environ["COUNT_BANK_ROOT"])
for path in sorted(ROOT.glob("count-low-*.wav")):
    match = re.search(r"count-low-(\d+)", path.name)
    if not match:
        continue
    expected = str(int(match.group(1)))
    result = transcribe_audio(path)
    raw = "".join(segment.get("text", "") for segment in result.get("segments", []))
    normalized = normalize(raw)
    print(f"{path.name}: {'PASS' if normalized == expected else 'FAIL'} | {raw!r} -> {normalized!r} (want {expected})")
