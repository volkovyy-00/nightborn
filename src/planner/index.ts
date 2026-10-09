import { cursorPlanner } from "./cursor.ts";
import { piPlanner } from "./pi.ts";
import { resolvePlannerName, type PlannerBackend, type PlannerName } from "./types.ts";

export type { PlannerBackend, PlannerName } from "./types.ts";
export { resolvePlannerName } from "./types.ts";

/** Select Talk/Forge planner backend via PLANNER=pi|cursor (default pi). */
export function getPlanner(): PlannerBackend {
  return resolvePlannerName() === "cursor" ? cursorPlanner : piPlanner;
}
