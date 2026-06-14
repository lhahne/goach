import { dateRangeShape, updateWellnessShape, wellnessFields } from "../lib/schemas.js";
import { READ_ONLY, type ToolDef } from "./types.js";

export const wellnessTools: ToolDef[] = [
  {
    name: "get_wellness",
    description:
      "Get daily wellness records over a date range. Each record includes metrics " +
      "such as weight, resting HR, HRV and sleep, plus the fitness values Intervals.icu " +
      "stores per day (CTL/fitness, ATL/fatigue, and form/TSB). Prefer this over " +
      "computing CTL/ATL/TSB yourself.",
    inputSchema: dateRangeShape,
    annotations: { ...READ_ONLY, title: "Get wellness & fitness trend" },
    handler: (client, input) =>
      client.getWellness(input.oldest as string, input.newest as string),
  },
  {
    name: "update_wellness",
    description:
      "Create or update (upsert) the wellness record for a single date. Only the " +
      "fields you provide are changed. Idempotent: calling it again with the same " +
      "values has no additional effect. Confirm with the user before writing.",
    inputSchema: updateWellnessShape,
    annotations: {
      title: "Update wellness entry",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: (client, input) =>
      client.updateWellness(input.date as string, wellnessFields(input)),
  },
];
