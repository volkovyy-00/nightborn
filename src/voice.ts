// Spoken replies (SPEC §10 "Voice"): ElevenLabs TTS of Talk's `say` line. Server only; the key never reaches a hand.
// Any failure → null → the route answers 204 and the page stays silent. No log line, no raw error to the client.

const MODEL = "eleven_flash_v2_5";
const MAX_CHARS = 600;
const TIMEOUT_MS = 8000;

export async function speak(text: string): Promise<ArrayBuffer | null> {
  const key = process.env.ELEVENLABS_API_KEY?.trim();
  const voiceId = process.env.ELEVENLABS_VOICE_ID?.trim();
  const t = text.trim().slice(0, MAX_CHARS);
  if (!key || !voiceId || process.env.OFFLINE === "1" || !t) return null;
  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text: t, model_id: MODEL }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!res.ok) {
      console.error(`voice: elevenlabs ${res.status}`); // server console only
      return null;
    }
    return await res.arrayBuffer();
  } catch (e) {
    console.error(`voice: ${(e as Error).name}`);
    return null;
  }
}
