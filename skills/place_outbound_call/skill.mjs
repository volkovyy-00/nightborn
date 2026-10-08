// Nightborn free-form Bland outbound skill — stdin query, stdout items
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}
const SLASH = String.fromCharCode(47);
function joinBase(baseUrl, fallbackOrigin, relPath) {
  const base = baseUrl ?? fallbackOrigin;
  const root = base.endsWith(SLASH) ? base : `${base}${SLASH}`;
  const rel = relPath.startsWith(SLASH) ? relPath.slice(1) : relPath;
  return new URL(rel, root);
}
function parseQuery(query) {
  const sep = "|||";
  if (query.includes(sep)) {
    const i = query.indexOf(sep);
    return { phone: query.slice(0, i).trim(), task: query.slice(i + sep.length).trim() };
  }
  try {
    const j = JSON.parse(query);
    if (j.phone_number && j.task) return { phone: String(j.phone_number), task: String(j.task) };
  } catch { /* fall through */ }
  return { phone: query.trim(), task: "Confirm the line works with one short greeting." };
}
/** Force Bland to stay conversational even if the briefing lists many fields. */
function conversationalTask(briefing) {
  return [
    "You are on a live phone call. Be warm, brief, and human.",
    "Ask exactly ONE question per turn. Wait for their answer before asking anything else.",
    "Never stack multiple questions in one sentence or turn.",
    'For a used-car / listing follow-up, open with: "Hi, I saw a listing of a used car online with this number mentioned — is it still available?"',
    "For other goals, open with one natural question that fits the briefing.",
    "After they answer, follow up one topic at a time (e.g. price, then condition, then mileage).",
    "Keep the call short. Thank them and end when you have enough.",
    "Briefing / goal for this call:",
    String(briefing || "").trim() || "Have a short polite conversation and learn why they listed.",
  ].join("\n");
}
const raw = await readStdin();
const input = JSON.parse(raw || "{}");
const { phone, task } = parseQuery(input.query ?? "");
const key = process.env.BLAND_API_KEY;
if (!key) { console.error("missing BLAND_API_KEY"); process.exit(1); }
const url = joinBase(input.baseUrl, "https://api.bland.ai", "v1/calls").href;
const res = await fetch(url, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ phone_number: phone, task: conversationalTask(task) }),
  signal: AbortSignal.timeout(6000),
});
if (!res.ok) { console.error("bland", res.status); process.exit(1); }
const data = await res.json();
const callId = data.call_id ?? "unknown";
process.stdout.write(JSON.stringify({
  items: [{
    title: data.status === "success" ? "Outbound call started" : "Outbound call response",
    url: "bland:call/" + callId,
  }],
}));
