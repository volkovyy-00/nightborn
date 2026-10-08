#!/usr/bin/env python3
"""Split golem source.wav on silence into named chunks (stdlib only)."""
from __future__ import annotations

import json
import math
import struct
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "fixtures/voice/golem/source.wav"
OUT = ROOT / "fixtures/voice/golem/chunks"
LABELS = ROOT / "fixtures/voice/golem/labels.json"

# Frame window for RMS (ms) and silence threshold relative to peak
WIN_MS = 20
SILENCE_RATIO = 0.08  # below this * peak_rms → silence
MIN_SILENCE_MS = 120
MIN_CHUNK_MS = 80
PAD_MS = 40


def rms_series(pcm: bytes, rate: int, nch: int, win_ms: int) -> list[float]:
    samp_per_win = max(1, int(rate * win_ms / 1000))
    frame_bytes = 2 * nch
    win_bytes = samp_per_win * frame_bytes
    out: list[float] = []
    for i in range(0, len(pcm) - win_bytes + 1, win_bytes):
        chunk = pcm[i : i + win_bytes]
        n = len(chunk) // 2
        if n == 0:
            out.append(0.0)
            continue
        # unpack little-endian int16
        samples = struct.unpack("<" + "h" * n, chunk)
        # mix to mono for energy
        if nch == 2:
            mono = [(samples[j] + samples[j + 1]) / 2 for j in range(0, len(samples), 2)]
        else:
            mono = list(samples)
        s = sum(x * x for x in mono) / len(mono)
        out.append(math.sqrt(s))
    return out


def find_segments(
    rms: list[float], win_ms: int
) -> list[tuple[float, float]]:
    peak = max(rms) if rms else 1.0
    thr = peak * SILENCE_RATIO
    min_sil_wins = max(1, int(MIN_SILENCE_MS / win_ms))
    min_chunk_wins = max(1, int(MIN_CHUNK_MS / win_ms))

    # boolean voiced
    voiced = [r >= thr for r in rms]
    # merge short silence inside bursts: treat < min_sil as voiced
    i = 0
    while i < len(voiced):
        if not voiced[i]:
            j = i
            while j < len(voiced) and not voiced[j]:
                j += 1
            if 0 < i and j < len(voiced) and (j - i) < min_sil_wins:
                for k in range(i, j):
                    voiced[k] = True
            i = j
        else:
            i += 1

    segs: list[tuple[int, int]] = []
    i = 0
    while i < len(voiced):
        if voiced[i]:
            j = i
            while j < len(voiced) and voiced[j]:
                j += 1
            if (j - i) >= min_chunk_wins:
                segs.append((i, j))
            i = j
        else:
            i += 1

    pad_wins = max(0, int(PAD_MS / win_ms))
    out: list[tuple[float, float]] = []
    for a, b in segs:
        a2 = max(0, a - pad_wins)
        b2 = min(len(rms), b + pad_wins)
        out.append((a2 * win_ms / 1000.0, b2 * win_ms / 1000.0))
    return out


def write_chunk(
    pcm: bytes, rate: int, nch: int, start_s: float, end_s: float, path: Path
) -> None:
    frame_bytes = 2 * nch
    start_f = int(start_s * rate)
    end_f = int(end_s * rate)
    start_b = start_f * frame_bytes
    end_b = end_f * frame_bytes
    data = pcm[start_b:end_b]
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(nch)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(data)


def main() -> None:
    with wave.open(str(SRC), "rb") as w:
        assert w.getsampwidth() == 2, "expected 16-bit PCM"
        rate = w.getframerate()
        nch = w.getnchannels()
        pcm = w.readframes(w.getnframes())

    rms = rms_series(pcm, rate, nch, WIN_MS)
    segs = find_segments(rms, WIN_MS)
    OUT.mkdir(parents=True, exist_ok=True)
    # clear old auto chunks
    for p in OUT.glob("*.wav"):
        p.unlink()

    labels: dict[str, dict] = {
        "_meta": {
            "source": "source.wav",
            "license": "CC0 — freesound.org/people/marlonnnnnn/sounds/319140/",
            "split": "silence-gate",
            "count": len(segs),
        }
    }

    # provisional names by index + duration hint; human relabels later
    for i, (start, end) in enumerate(segs, start=1):
        dur = end - start
        kind = "hit" if dur < 0.35 else ("grunt" if dur < 1.2 else "growl")
        name = f"{i:02d}_{kind}_{dur:.2f}s"
        fname = f"{name}.wav"
        write_chunk(pcm, rate, nch, start, end, OUT / fname)
        labels[name] = {
            "file": f"chunks/{fname}",
            "start_s": round(start, 3),
            "end_s": round(end, 3),
            "duration_s": round(dur, 3),
            "label": kind,  # provisional — edit after listen
            "notes": "",
        }
        print(f"{fname}  {start:.2f}-{end:.2f}s  ({dur:.2f}s)  provisional={kind}")

    LABELS.write_text(json.dumps(labels, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(segs)} chunks → {OUT}")
    print(f"labels → {LABELS}")


if __name__ == "__main__":
    main()
