import { readFileSync, existsSync, readdirSync } from "node:fs";
import { Type } from "typebox";
import {
  createAgentSession,
  defineTool,
  SessionManager,
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Job } from "./types.ts";
import { repoPath, dataPath } from "./paths.ts";
import { listSkillDirs } from "./hash.ts";
import { ALLOWED_CAPS } from "./charter.ts";
import { createPiAuthAndRegistry, resolvePiModel } from "./pi.ts";

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
  const names = listSkillDirs(dataPath("skills"));
  return [`Capabilities: ${ALLOWED_CAPS.join(", ")}`, `Installed skills: ${names.length ? names.join(", ") : "(none)"}`].join(
    "\n",
  );
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
    description: "Request skill work (news/search). Final action.",
    promptGuidelines: [
      "Call emit_chat OR emit_job, exactly one, as your last action.",
      "For news/search: needs must include net:fetch; skill null unless reusing a named skill.",
    ],
    parameters: Type.Object({
      text: Type.String(),
      skill: Type.Union([Type.String(), Type.Null()]),
      intent: Type.String(),
      query: Type.String(),
      needs: Type.Array(Type.String()),
    }),
    async execute(_id, params) {
      captured = {
        kind: "job",
        text: params.text,
        job: {
          skill: params.skill,
          intent: params.intent,
          query: params.query,
          needs: params.needs.length ? params.needs : ["net:fetch"],
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
    "Never install. Never write files. Only emit_chat or emit_job.",
    soul,
    "",
    "Snapshot:",
    snapshot(),
  ].join("\n");

  const { auth, registry } = createPiAuthAndRegistry();
  const model = resolvePiModel(registry);
  const loader = new DefaultResourceLoader({
    systemPromptOverride: () => system,
    skillsOverride: () => ({ skills: [], diagnostics: [] }),
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    promptsOverride: () => ({ prompts: [], diagnostics: [] }),
  });
  await loader.reload();

  const { session } = await createAgentSession({
    authStorage: auth,
    modelRegistry: registry,
    model,
    thinkingLevel: "off",
    noTools: "builtin",
    customTools: [emitChat, emitJob],
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
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
  forge?: { name: string; purpose: string; query: string; capabilities: string[] };
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
