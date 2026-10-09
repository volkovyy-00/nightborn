/**
 * Doctor facade — enqueue briefs and schedule async Forge off the request path.
 *
 * submit() writes the inbox file and kick()s; never awaits Forge/Warden.
 */

import { getCharterHash } from "../charter.ts";
import { appendLog } from "../log.ts";
import type { CapabilityBrief } from "./brief.ts";
import { submit as inboxSubmit } from "./inbox.ts";
import { kick, processNext } from "./worker.ts";

export type Doctor = {
  /** Non-blocking enqueue + schedule worker tick. */
  submit(brief: CapabilityBrief): Promise<{ requestId: string }>;
  /** Worker tick: forge one brief or park on missing secrets. */
  processNext(): Promise<void>;
  /** Schedule drain via setImmediate (does not block). */
  kick(): void;
  /** Patch/change request for an installed skill (sets changeOf). */
  requestChange(skill: string, brief: CapabilityBrief): Promise<{ requestId: string }>;
};

let singleton: Doctor | null = null;

export function getDoctor(): Doctor {
  if (!singleton) {
    singleton = {
      async submit(brief: CapabilityBrief) {
        const r = await inboxSubmit(brief);
        appendLog({
          actor: "doctor",
          event: "doctor",
          skill: brief.title,
          decision: "allow",
          charterHash: getCharterHash(),
          detail:
            `enqueued ${brief.requestId} → inbox · intent=${brief.intent.slice(0, 120)}` +
            (brief.defaultsHint ? ` · defaults=${brief.defaultsHint}` : ""),
        });
        kick();
        return r;
      },
      processNext,
      kick,
      async requestChange(skill: string, brief: CapabilityBrief) {
        return this.submit({ ...brief, changeOf: skill });
      },
    };
  }
  return singleton;
}

export type { CapabilityBrief } from "./brief.ts";
export { parseBrief, serializeBrief, briefsEqual } from "./brief.ts";
export { submit, take, complete, fail, doctorDirs } from "./inbox.ts";
export {
  processNext,
  kick,
  missingEnvKeys,
  retryParkedComposioBriefs,
  startComposioDoctorRetryBridge,
} from "./worker.ts";
