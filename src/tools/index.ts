import { activityTools } from "./activities.js";
import { athleteTools } from "./athlete.js";
import { calendarTools } from "./calendar.js";
import { curveTools } from "./curves.js";
import { wellnessTools } from "./wellness.js";
import type { ToolDef } from "./types.js";

/** All MVP tools (spec §6, High Priority). */
export const allTools: ToolDef[] = [
  ...athleteTools,
  ...wellnessTools,
  ...activityTools,
  ...curveTools,
  ...calendarTools,
];

export type { ToolDef } from "./types.js";
