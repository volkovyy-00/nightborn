# Nightborn_UI artifact (PI branch)

Saved Claude design artifact used as UI reference for the PI experiment.
Not the SPEC §7 `public/index.html` surface — do not treat this as the production host UI until adapted.

**Source:** `~/Downloads/Nightborn_UI.html` (+ `_files`), saved from  
`https://claude.ai/artifact/Ur3sYuPbnzpsWx4xMf5pL1` (2026-10-08).

## Layout

| Path | What |
|------|------|
| `extracted/Main.dc.html` | Interactive demo screen (prototype logic, simulated pipeline) |
| `extracted/Frames.dc.html` | 9-frame reference (Boot → Broken); closer to SPEC wording |
| `raw/` | Browser save shell + srcdoc wrappers (Claude chrome stripped) |

## Prefer for SPEC alignment

Start from **`extracted/Frames.dc.html`**: chips are Microsoft / OpenAI / email digest; label is `+N FORGED`; voice is static `VOICE · WAV`; no Reset button in the frame set.

`Main.dc.html` still has cut-list items (Reset, Voice toggle, Kestrel/table/careers chips, `read_company_page`, speechSynthesis). Treat as earlier wireframe.

## PI note

This artifact is **offline / self-driving** (no `/api/talk` or `/api/log`). Wiring to the host merge contract is a separate step once the PI surface plan lands.
