import { mkdirSync, writeFileSync, readFileSync, copyFileSync, unlinkSync, existsSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../src/paths.ts";
import { charterHashFromBytes } from "../src/hash.ts";
import { tripwireMatch, DENIED_PROMPT } from "../src/tripwire.ts";

const results: { name: string; status: "Works" | "Simulated" | "Incomplete"; detail: string }[] = [];

// Charter pin recipe
{
  const bytes = readFileSync(path.join(REPO_ROOT, "charter.md"));
  const h = charterHashFromBytes(bytes);
  results.push({ name: "charter_hash_recipe", status: "Works", detail: h.slice(0, 8) });
}

// Tripwire
{
  const ok = tripwireMatch(DENIED_PROMPT) && !tripwireMatch("News on Microsoft");
  results.push({
    name: "tripwire_email",
    status: ok ? "Works" : "Incomplete",
    detail: ok ? "email matches; news does not" : "tripwire failed",
  });
}

// Byte-flip charter copy (never write real charter)
{
  const src = path.join(REPO_ROOT, "charter.md");
  const tmp = path.join(REPO_ROOT, "staging", "validate-charter-copy.md");
  mkdirSync(path.dirname(tmp), { recursive: true });
  copyFileSync(src, tmp);
  const orig = readFileSync(tmp);
  const flipped = Buffer.from(orig);
  flipped[0] = flipped[0] ^ 0x01;
  writeFileSync(tmp, flipped);
  const h1 = charterHashFromBytes(orig);
  const h2 = charterHashFromBytes(flipped);
  unlinkSync(tmp);
  results.push({
    name: "charter_byte_flip",
    status: h1 !== h2 ? "Works" : "Incomplete",
    detail: "copy-only flip changes hash",
  });
}

results.push({
  name: "pi_talk_forge",
  status: "Simulated",
  detail: "Talk/Forge via Pi terminating tools; JUDGE_MODE fixtures available",
});

const outDir = path.join(REPO_ROOT, "validation");
mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, "results.json");
writeFileSync(out, `${JSON.stringify({ ts: new Date().toISOString(), results }, null, 2)}\n`);
console.log("wrote", out);
if (!existsSync(path.join(REPO_ROOT, "templates", "email_send", "skill.mjs"))) {
  console.warn("missing email_send template");
}
