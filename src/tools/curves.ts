import { curvesShape } from "../lib/schemas.js";
import {
  DEFAULT_CURVE_DURATIONS,
  selectCurveDurations,
  type CurvePoint,
} from "../lib/summarize.js";
import { READ_ONLY, type ToolDef } from "./types.js";

/** Only keep points whose secs and value are both finite numbers. */
function isValidPoint(p: { secs: unknown; value: unknown }): p is CurvePoint {
  return Number.isFinite(p.secs as number) && Number.isFinite(p.value as number);
}

/** Normalise the various curve payload shapes into [{secs,value}]. */
function toCurvePoints(raw: unknown): CurvePoint[] {
  // Array-of-points shape, e.g. [{ secs, value|watts }].
  if (Array.isArray(raw)) {
    return raw
      .map((p) => ({ secs: (p as any)?.secs, value: (p as any)?.value ?? (p as any)?.watts }))
      .filter(isValidPoint);
  }
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  // Parallel-arrays shape: secs[] + the metric[]. Clamp to the shared length.
  const secs = (obj.secs ?? obj.secsList) as unknown[] | undefined;
  const values = (obj.values ?? obj.watts ?? obj.list) as unknown[] | undefined;
  if (Array.isArray(secs) && Array.isArray(values)) {
    const n = Math.min(secs.length, values.length);
    const points: CurvePoint[] = [];
    for (let i = 0; i < n; i++) {
      const point = { secs: secs[i], value: values[i] };
      if (isValidPoint(point)) points.push(point);
    }
    return points;
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
