import { readFileSync, existsSync, readdirSync } from "node:fs";
import { Type } from "typebox";
import {
  createAgentSession,
  defineTool,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ForgeArtifact, Job } from "./types.ts";
import { repoPath, dataPath, REPO_ROOT } from "./paths.ts";
import { listSkillDirs } from "./hash.ts";
import { ALLOWED_CAPS } from "./charter.ts";
import { createPiAuthAndRegistry, createPiResourceLoader, piAgentDir, resolvePiModel } from "./pi.ts";

export type TalkEmit =
  | { kind: "chat"; text: string }
  | { kind: "job"; text: string; job: Job };

type Turn = { role: "user" | "assistant"; text: string };

const history: Turn[] = [];

export function pushHistory(role: "user" | "assistant", text: string): void {
  history.push({ role, text });
  while (history.length > 10) history.shift();
}

function snapshot(): string {
  const names = listSkillDirs(dataPath("skills")).filter((n) => n !== "hand_probe");
  return [
    `Capabilities (needs may only use these): ${ALLOWED_CAPS.join(", ")}`,
    `Installed skills: ${names.length ? names.join(", ") : "(none)"}`,
    "Same kind of job as an installed skill (e.g. another company news): skill=null → Reuse.",
    "Different job (forums, deals, listings) or grow/forge/don't reuse X: skill=new_snake_case NOT installed → Create (free-form Forge).",
    "Never set skill to hand_probe.",
  ].join("\n");
}

export async function talkViaPi(userText: string): Promise<TalkEmit> {
  let captured: TalkEmit | null = null;

  const emitChat = defineTool({
    name: "emit_chat",
    label: "Emit Chat",
    description: "Reply with chat only (no skill work). Final action.",
    promptGuidelines: ["Call emit_chat OR emit_job, exactly one, as your last action."],
    parameters: Type.Object({
      text: Type.String(),
    }),
    async execute(_id, params) {
      captured = { kind: "chat", text: params.text };
      return {
        content: [{ type: "text", text: params.text }],
        details: captured,
        terminate: true,
      };
    },
  });

  const emitJob = defineTool({
    name: "emit_job",
    label: "Emit Job",
    description:
      "Request skill work or growth (news/search/deals). Final action. Use for grow/forge/make-an-arm requests too.",
    promptGuidelines: [
      "Call emit_chat OR emit_job, exactly one, as your last action.",
      "Grow / forge / make an arm / extend / don't use <skill> / forums / deals / listings unlike installed skills → skill=new_snake_case not installed.",
      "Same-class news (e.g. News on OpenAI after a news skill exists) → skill=null.",
      "needs = charter capabilities only (usually [\"net:fetch\"]). Never hand_probe.",
      "query = the search string (topic), not the whole user sentence.",
    ],
    parameters: Type.Object({
      text: Type.String(),
      skill: Type.Union([Type.String(), Type.Null()]),
      intent: Type.String(),
      query: Type.String(),
      needs: Type.Array(Type.String()),
    }),
    async execute(_id, params) {
      let skill: string | null = params.skill;
      // Reject probes / cap-as-name / string "null" — but keep proposed names that are not installed yet (explicit grow).
      if (
        !skill ||
        skill === "hand_probe" ||
        skill === "null" ||
        skill === "undefined" ||
        (ALLOWED_CAPS as readonly string[]).includes(skill)
      ) {
        skill = null;
      }
      const needs = params.needs.filter((n) => (ALLOWED_CAPS as readonly string[]).includes(n));
      captured = {
        kind: "job",
        text: params.text,
        job: {
          skill,
          intent: params.intent,
          query: params.query,
          needs: needs.length ? needs : ["net:fetch"],
        },
      };
      return {
        content: [{ type: "text", text: params.text }],
        details: captured,
        terminate: true,
      };
    },
  });

  const soul = existsSync(repoPath("soul.md"))
    ? readFileSync(repoPath("soul.md"), "utf8")
    : "You are Nightborn.";

  const system = [
    "You are Nightborn's Talk layer.",
    "You never write skills yourself — emit_job requests work; the host Create/Reuse.",
    "Do not refuse growth in chat. Same-class news: skill=null. Distinct jobs / explicit grow: new snake_case skill name (Create → free-form Forge).",
    "Only emit_chat or emit_job. needs ⊆ charter caps (net:fetch for web).",
    soul,
    "",
    "Snapshot:",
    snapshot(),
  ].join("\n");

  const { auth, registry } = createPiAuthAndRegistry();
  const model = resolvePiModel(registry);
  const loader = createPiResourceLoader({ systemPrompt: system });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: REPO_ROOT,
    agentDir: piAgentDir(),
    authStorage: auth,
    modelRegistry: registry,
    model,
    thinkingLevel: "off",
    noTools: "builtin",
    customTools: [emitChat, emitJob],
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(REPO_ROOT),
    settingsManager: SettingsManager.inMemory(),
  });

  try {
    session.subscribe((event) => {
      if (
        event.type === "tool_execution_end" &&
        (event.toolName === "emit_chat" || event.toolName === "emit_job")
      ) {
        const d = (event.result as { details?: TalkEmit } | undefined)?.details;
        if (d) captured = d;
      }
    });

    const hist = history
      .slice(-10)
      .map((t) => `${t.role}: ${t.text}`)
      .join("\n");
    const prompt = [hist && `Recent turns:\n${hist}`, `Current user: ${userText}`, "Call emit_chat or emit_job now."]
      .filter(Boolean)
      .join("\n\n");

    await session.prompt(prompt);
  } finally {
    session.dispose();
  }

  if (!captured) {
    return { kind: "chat", text: "I heard you, but could not shape a reply." };
  }
  return captured;
}

export type TalkFixture = {
  match: string;
  talk: TalkEmit;
  forge?: ForgeArtifact;
};

export function loadTalkFixture(filename: string): TalkFixture | null {
  const p = repoPath("fixtures", "talk", filename);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as TalkFixture;
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export function findJudgeFixture(text: string): TalkFixture | null {
  if (process.env.JUDGE_MODE !== "1") return null;
  const dir = repoPath("fixtures", "talk");
  if (!existsSync(dir)) return null;
  const norm = normalize(text);
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const fx = loadTalkFixture(f);
    if (fx && normalize(fx.match) === norm) return fx;
  }
  return null;
}
