import { curvesShape } from "../lib/schemas.js";
import {
  DEFAULT_CURVE_DURATIONS,
  selectCurveDurations,
  type CurvePoint,
} from "../lib/summarize.js";
import { READ_ONLY, type ToolDef } from "./types.js";

/** Normalise the various curve payload shapes into [{secs,value}]. */
function toCurvePoints(raw: unknown): CurvePoint[] {
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  // Intervals.icu typically returns parallel arrays: secs[] + the metric[].
  const secs = (obj.secs ?? obj.secsList) as number[] | undefined;
  const values = (obj.values ?? obj.watts ?? obj.list) as number[] | undefined;
  if (Array.isArray(secs) && Array.isArray(values)) {
    return secs.map((s, i) => ({ secs: s, value: values[i] }));
  }
  if (Array.isArray(raw)) {
    return (raw as Record<string, number>[])
      .filter((p) => typeof p.secs === "number")
      .map((p) => ({ secs: p.secs, value: (p.value ?? p.watts) as number }));
  }
  return [];
}

function curveTool(
  name: string,
  metric: "power" | "pace" | "hr",
  label: string,
): ToolDef {
  return {
    name,
    description:
      `Get the best ${label} curve over a date range, reported only at a selected set ` +
      `of durations (defaults to ${DEFAULT_CURVE_DURATIONS.join(", ")} seconds) to keep ` +
      `the response compact. Pass \`durations\` to choose your own.`,
    inputSchema: curvesShape,
    annotations: { ...READ_ONLY, title: `Get ${label} curve` },
    handler: async (client, input) => {
      const raw = await client.getCurves(metric, {
        oldest: input.oldest as string,
        newest: input.newest as string,
      });
      const durations = (input.durations as number[] | undefined) ?? DEFAULT_CURVE_DURATIONS;
      return {
        metric,
        oldest: input.oldest,
        newest: input.newest,
        points: selectCurveDurations(toCurvePoints(raw), durations),
      };
    },
  };
}

export const curveTools: ToolDef[] = [
  curveTool("get_power_curves", "power", "power"),
  curveTool("get_pace_curves", "pace", "pace"),
  curveTool("get_hr_curves", "hr", "heart rate"),
];
