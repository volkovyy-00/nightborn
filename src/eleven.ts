/** ElevenLabs TTS + Instant Voice Clone for the voice-note demo beat. */

const TTS_MODEL = "eleven_multilingual_v2";
const DEFAULT_NOTE =
  "Nightborn here. The digest is ready — three items worth your eyes tonight.";

let learnedVoiceId: string | null = null;

export function getCreatureVoiceId(): string {
  return (process.env.ELEVENLABS_VOICE_ID ?? "JgMBD2CZ0VSURf6BgyOt").trim();
}

export function getLearnedVoiceId(): string | null {
  return learnedVoiceId;
}

export function voiceStatus(): { creatureVoiceId: string; learned: boolean; learnedVoiceId: string | null } {
  return {
    creatureVoiceId: getCreatureVoiceId(),
    learned: Boolean(learnedVoiceId),
    learnedVoiceId,
  };
}

function apiKey(): string {
  const k = process.env.ELEVENLABS_API_KEY?.trim();
  if (!k) throw new Error("ELEVENLABS_API_KEY missing");
  return k;
}

export async function synthesizeNote(
  which: "creature" | "learned",
  text = DEFAULT_NOTE,
): Promise<{ bytes: Buffer; contentType: string; voiceId: string }> {
  const voiceId = which === "learned" ? learnedVoiceId : getCreatureVoiceId();
  if (!voiceId) throw new Error("No learned voice yet — teach Nightborn your voice first.");

  if (process.env.OFFLINE === "1") {
    // Tiny valid silent-ish WAV so the UI can still play a note offline
    return { bytes: minimalWav(), contentType: "audio/wav", voiceId };
  }

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey(),
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: TTS_MODEL,
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ElevenLabs TTS ${res.status}: ${body.slice(0, 200)}`);
  }
  const ab = await res.arrayBuffer();
  return { bytes: Buffer.from(ab), contentType: "audio/mpeg", voiceId };
}

export async function learnVoiceFromSample(
  file: { data: Buffer; filename: string; type?: string },
  name = "nightborn-learned",
): Promise<{ voiceId: string }> {
  if (process.env.OFFLINE === "1") {
    learnedVoiceId = "offline-learned-voice";
    return { voiceId: learnedVoiceId };
  }

  const form = new FormData();
  form.append("name", name);
  form.append("description", "Nightborn learned voice from demo sample");
  const blob = new Blob([file.data], { type: file.type || "audio/webm" });
  form.append("files", blob, file.filename || "sample.webm");

  const res = await fetch("https://api.elevenlabs.io/v1/voices/add", {
    method: "POST",
    headers: { "xi-api-key": apiKey() },
    body: form,
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ElevenLabs IVC ${res.status}: ${body.slice(0, 240)}`);
  }
  const json = (await res.json()) as { voice_id?: string };
  if (!json.voice_id) throw new Error("ElevenLabs IVC: no voice_id");
  learnedVoiceId = json.voice_id;
  return { voiceId: learnedVoiceId };
}

/** Minimal 0.2s mono 8kHz WAV (silence) for OFFLINE demos. */
function minimalWav(): Buffer {
  const sampleRate = 8000;
  const samples = 1600;
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

export { DEFAULT_NOTE };
