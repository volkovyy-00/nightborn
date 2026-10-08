# Golem voice sample (CC0)

Source: [VG Voice - Golem.wav](https://freesound.org/people/marlonnnnnn/sounds/319140/) by **marlonnnnnn** on Freesound.

- License: **CC0** (public domain dedication) — no attribution required; we keep credit here anyway.
- Content: large-monster / golem vocalizations (grunts, hits) — **not** the 1931 film.

| File | Notes |
|------|--------|
| `source.wav` | Full 39.3s sample |
| `319140__marlonnnnnn__vg-voice-golem.wav` | Original Freesound filename (provenance) |
| `chunks/` | 40 silence-split WAVs, named `NN_{hit\|grunt\|growl}_D.DDs.wav` (provisional) |
| `labels.json` | Timecodes + provisional labels — edit `label` / `notes` after you listen |

Re-split: `python3 scripts/split_golem_chunks.py`

Listen (example): `ffplay -nodisp -autoexit fixtures/voice/golem/chunks/01_grunt_0.82s.wav` or open the folder in a file manager.
