/**
 * Context-budget helpers (spec §6). Streams and full curves can be tens of
 * thousands of points and would overflow the model's context window, so every
 * potentially-large response is downsampled / reduced before being returned.
 */

/** Default durations (seconds) returned for power/pace/HR curves. */
export const DEFAULT_CURVE_DURATIONS = [5, 15, 30, 60, 300, 600, 1200, 3600];

/**
 * Downsample an array to at most `maxPoints` evenly-spaced samples, always
 * keeping the first and last point. Returns the input unchanged if it is
 * already small enough.
 */
export function downsample<T>(points: readonly T[], maxPoints: number): T[] {
  if (maxPoints < 2) throw new Error("maxPoints must be >= 2");
  if (points.length <= maxPoints) return [...points];
  const out: T[] = [];
  const step = (points.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) {
    out.push(points[Math.round(i * step)]);
  }
  return out;
}

/**
 * Reduce a curve (array of { secs, value }-like points) to the requested set of
 * durations, picking for each target the closest available duration <= target
 * (falling back to the nearest if none is below).
 */
export interface CurvePoint {
  secs: number;
  value: number;
}

export function selectCurveDurations(
  curve: readonly CurvePoint[],
  durations: readonly number[] = DEFAULT_CURVE_DURATIONS,
): CurvePoint[] {
  if (curve.length === 0) return [];
  const sorted = [...curve].sort((a, b) => a.secs - b.secs);
  const result: CurvePoint[] = [];
  const seen = new Set<number>();
  for (const target of durations) {
    let best: CurvePoint | undefined;
    for (const p of sorted) {
      if (p.secs <= target) best = p;
      else break;
    }
    best ??= sorted[0];
    if (!seen.has(best.secs)) {
      seen.add(best.secs);
      result.push({ secs: best.secs, value: best.value });
    }
  }
  return result;
}

/** Truncate a list to `limit` items, reporting whether truncation occurred. */
export function truncateList<T>(
  items: readonly T[],
  limit: number,
): { items: T[]; total: number; truncated: boolean } {
  const sliced = items.slice(0, limit);
  return {
    items: sliced,
    total: items.length,
    truncated: items.length > limit,
  };
}

/**
 * Project an activity object down to a compact summary row. Unknown shapes are
 * tolerated — only fields that exist are copied.
 */
const ACTIVITY_SUMMARY_FIELDS = [
  "id",
  "name",
  "type",
  "start_date_local",
  "moving_time",
  "distance",
  "icu_training_load",
  "icu_average_watts",
  "average_heartrate",
  "average_speed",
] as const;

export function summarizeActivity(
  activity: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of ACTIVITY_SUMMARY_FIELDS) {
    if (activity[field] !== undefined) out[field] = activity[field];
  }
  return out;
}
