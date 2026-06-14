import { describe, expect, it } from "vitest";
import {
  DEFAULT_CURVE_DURATIONS,
  downsample,
  selectCurveDurations,
  summarizeActivity,
  truncateList,
} from "../../src/lib/summarize.js";

describe("downsample", () => {
  it("returns the input unchanged when already small enough", () => {
    expect(downsample([1, 2, 3], 5)).toEqual([1, 2, 3]);
  });

  it("reduces to exactly maxPoints, keeping first and last", () => {
    const data = Array.from({ length: 1000 }, (_, i) => i);
    const out = downsample(data, 10);
    expect(out).toHaveLength(10);
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(999);
  });

  it("rejects maxPoints < 2", () => {
    expect(() => downsample([1, 2, 3], 1)).toThrow();
  });
});

describe("selectCurveDurations", () => {
  const curve = Array.from({ length: 3600 }, (_, i) => ({
    secs: i + 1,
    value: 400 - i * 0.05,
  }));

  it("picks the closest duration <= each target", () => {
    const out = selectCurveDurations(curve, [5, 60, 300]);
    expect(out.map((p) => p.secs)).toEqual([5, 60, 300]);
  });

  it("dedupes when targets collapse to the same point", () => {
    const tiny = [{ secs: 1, value: 100 }];
    expect(selectCurveDurations(tiny, [5, 60, 300])).toEqual([
      { secs: 1, value: 100 },
    ]);
  });

  it("returns empty for empty input and defaults durations", () => {
    expect(selectCurveDurations([])).toEqual([]);
    expect(DEFAULT_CURVE_DURATIONS).toContain(300);
  });
});

describe("truncateList", () => {
  it("reports truncation and total", () => {
    const r = truncateList([1, 2, 3, 4, 5], 3);
    expect(r.items).toEqual([1, 2, 3]);
    expect(r.total).toBe(5);
    expect(r.truncated).toBe(true);
  });

  it("does not flag truncation when within limit", () => {
    expect(truncateList([1, 2], 3).truncated).toBe(false);
  });
});

describe("summarizeActivity", () => {
  it("keeps only known summary fields that exist", () => {
    const out = summarizeActivity({
      id: "i1",
      name: "Ride",
      type: "Ride",
      icu_average_watts: 220,
      secret_field: "drop me",
    });
    expect(out).toEqual({
      id: "i1",
      name: "Ride",
      type: "Ride",
      icu_average_watts: 220,
    });
    expect(out).not.toHaveProperty("secret_field");
  });
});
