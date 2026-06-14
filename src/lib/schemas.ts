import { z } from "zod";

/** Intervals.icu uses local calendar dates in YYYY-MM-DD form. */
export const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format");

export const dateRangeShape = {
  oldest: dateString.describe("Start of the date range, inclusive (YYYY-MM-DD)."),
  newest: dateString.describe("End of the date range, inclusive (YYYY-MM-DD)."),
};

export const listActivitiesShape = {
  oldest: dateString
    .optional()
    .describe("Only include activities on or after this date (YYYY-MM-DD)."),
  newest: dateString
    .optional()
    .describe("Only include activities on or before this date (YYYY-MM-DD)."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(30)
    .describe("Maximum number of activities to return (most recent first)."),
};

export const getActivityShape = {
  id: z.string().min(1).describe("Intervals.icu activity id, e.g. 'i123456789'."),
  include_streams: z
    .boolean()
    .default(false)
    .describe(
      "If true, include downsampled per-second streams. Off by default because streams are large.",
    ),
  stream_types: z
    .array(z.enum(["watts", "heartrate", "velocity_smooth", "cadence", "altitude"]))
    .default(["watts", "heartrate"])
    .describe("Which stream channels to include when include_streams is true."),
  max_stream_points: z
    .number()
    .int()
    .min(2)
    .max(2000)
    .default(500)
    .describe("Downsample each stream to at most this many points."),
};

export const curvesShape = {
  ...dateRangeShape,
  durations: z
    .array(z.number().int().positive())
    .optional()
    .describe(
      "Durations in seconds to report (e.g. [5,60,300,1200]). Defaults to a standard set.",
    ),
};

export const updateWellnessShape = {
  date: dateString.describe("The date of the wellness record to upsert (YYYY-MM-DD)."),
  weight: z.number().positive().optional().describe("Body weight in kilograms."),
  restingHR: z.number().int().positive().optional().describe("Resting heart rate (bpm)."),
  hrv: z.number().positive().optional().describe("Heart rate variability (ms)."),
  sleepSecs: z.number().int().nonnegative().optional().describe("Sleep duration in seconds."),
  sleepScore: z.number().optional().describe("Sleep score (0-100)."),
};

/** Map the friendly update_wellness input to Intervals.icu field names. */
export function wellnessFields(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (input.weight !== undefined) fields.weight = input.weight;
  if (input.restingHR !== undefined) fields.restingHR = input.restingHR;
  if (input.hrv !== undefined) fields.hrv = input.hrv;
  if (input.sleepSecs !== undefined) fields.sleepSecs = input.sleepSecs;
  if (input.sleepScore !== undefined) fields.sleepScore = input.sleepScore;
  return fields;
}
