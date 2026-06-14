import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  dateString,
  listActivitiesShape,
  updateWellnessShape,
  wellnessFields,
} from "../../src/lib/schemas.js";

describe("dateString", () => {
  it("accepts YYYY-MM-DD", () => {
    expect(dateString.parse("2026-06-14")).toBe("2026-06-14");
  });

  it("rejects other formats", () => {
    expect(() => dateString.parse("14/06/2026")).toThrow();
    expect(() => dateString.parse("2026-6-1")).toThrow();
  });
});

describe("listActivitiesShape", () => {
  it("defaults limit to 30 and bounds it", () => {
    const schema = z.object(listActivitiesShape);
    expect(schema.parse({}).limit).toBe(30);
    expect(() => schema.parse({ limit: 0 })).toThrow();
    expect(() => schema.parse({ limit: 999 })).toThrow();
  });
});

describe("updateWellnessShape + wellnessFields", () => {
  it("requires a valid date and accepts partial fields", () => {
    const schema = z.object(updateWellnessShape);
    const parsed = schema.parse({ date: "2026-06-14", weight: 91.5, restingHR: 48 });
    expect(parsed.weight).toBe(91.5);
  });

  it("rejects non-positive weight", () => {
    const schema = z.object(updateWellnessShape);
    expect(() => schema.parse({ date: "2026-06-14", weight: -1 })).toThrow();
  });

  it("maps only provided fields and omits the date", () => {
    const fields = wellnessFields({ date: "2026-06-14", weight: 91.5, hrv: 70 });
    expect(fields).toEqual({ weight: 91.5, hrv: 70 });
    expect(fields).not.toHaveProperty("date");
  });
});
