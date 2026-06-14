import { describe, expect, it, vi } from "vitest";
import type { IntervalsClient } from "../../src/lib/intervals-client.js";
import { allTools } from "../../src/tools/index.js";

function tool(name: string) {
  const t = allTools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

function fakeClient(overrides: Partial<Record<keyof IntervalsClient, unknown>>): IntervalsClient {
  return overrides as unknown as IntervalsClient;
}

describe("tool catalogue", () => {
  it("exposes the MVP high-priority tools with annotations", () => {
    const names = allTools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "get_athlete",
        "get_wellness",
        "update_wellness",
        "list_activities",
        "get_activity",
        "get_power_curves",
        "get_pace_curves",
        "get_hr_curves",
        "list_calendar_events",
      ]),
    );
    for (const t of allTools) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.annotations).toBeDefined();
    }
  });

  it("marks reads readOnly and the write as non-readonly + idempotent", () => {
    expect(tool("get_wellness").annotations.readOnlyHint).toBe(true);
    const w = tool("update_wellness").annotations;
    expect(w.readOnlyHint).toBe(false);
    expect(w.idempotentHint).toBe(true);
  });
});

describe("list_activities", () => {
  it("summarises rows and reports truncation", async () => {
    const activities = Array.from({ length: 5 }, (_, i) => ({
      id: `i${i}`,
      name: `Act ${i}`,
      type: "Ride",
      icu_average_watts: 200 + i,
      raw_blob: "should be dropped",
    }));
    const client = fakeClient({ listActivities: vi.fn(async () => activities) });
    const result = (await tool("list_activities").handler(client, { limit: 3 })) as {
      total: number;
      truncated: boolean;
      activities: Record<string, unknown>[];
    };
    expect(result.total).toBe(5);
    expect(result.truncated).toBe(true);
    expect(result.activities).toHaveLength(3);
    expect(result.activities[0]).not.toHaveProperty("raw_blob");
  });
});

describe("get_activity", () => {
  it("omits streams by default", async () => {
    const client = fakeClient({
      getActivity: vi.fn(async () => ({ id: "i1" })),
      getActivityStreams: vi.fn(),
    });
    const result = (await tool("get_activity").handler(client, {
      id: "i1",
      include_streams: false,
    })) as Record<string, unknown>;
    expect(result).toEqual({ activity: { id: "i1" } });
    expect((client.getActivityStreams as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("downsamples streams when requested (array shape)", async () => {
    const data = Array.from({ length: 1000 }, (_, i) => i);
    const client = fakeClient({
      getActivity: vi.fn(async () => ({ id: "i1" })),
      getActivityStreams: vi.fn(async () => [{ type: "watts", data }]),
    });
    const result = (await tool("get_activity").handler(client, {
      id: "i1",
      include_streams: true,
      stream_types: ["watts"],
      max_stream_points: 100,
    })) as { streams: Record<string, unknown[]> };
    expect(result.streams.watts).toHaveLength(100);
  });
});

describe("curves", () => {
  it("selects the requested durations from parallel arrays", async () => {
    const client = fakeClient({
      getCurves: vi.fn(async () => ({
        secs: [1, 5, 60, 300],
        values: [500, 450, 350, 300],
      })),
    });
    const result = (await tool("get_power_curves").handler(client, {
      oldest: "2026-01-01",
      newest: "2026-06-01",
      durations: [5, 300],
    })) as { points: { secs: number; value: number }[] };
    expect(result.points).toEqual([
      { secs: 5, value: 450 },
      { secs: 300, value: 300 },
    ]);
  });
});

describe("curves (alternate payload shapes)", () => {
  it("handles an array-of-points shape with watts", async () => {
    const client = fakeClient({
      getCurves: vi.fn(async () => [
        { secs: 5, watts: 450 },
        { secs: 60, watts: 350 },
      ]),
    });
    const result = (await tool("get_power_curves").handler(client, {
      oldest: "2026-01-01",
      newest: "2026-06-01",
      durations: [60],
    })) as { points: { secs: number; value: number }[] };
    expect(result.points).toEqual([{ secs: 60, value: 350 }]);
  });

  it("returns no points for an unrecognised shape", async () => {
    const client = fakeClient({ getCurves: vi.fn(async () => 42) });
    const result = (await tool("get_hr_curves").handler(client, {
      oldest: "2026-01-01",
      newest: "2026-06-01",
    })) as { points: unknown[] };
    expect(result.points).toEqual([]);
  });
});

describe("list_calendar_events", () => {
  it("passes the date range through to the client", async () => {
    const getEvents = vi.fn(async () => [{ id: 1, category: "WORKOUT" }]);
    const client = fakeClient({ getEvents });
    const result = await tool("list_calendar_events").handler(client, {
      oldest: "2026-06-01",
      newest: "2026-06-30",
    });
    expect(getEvents).toHaveBeenCalledWith("2026-06-01", "2026-06-30");
    expect(result).toEqual([{ id: 1, category: "WORKOUT" }]);
  });
});

describe("update_wellness", () => {
  it("calls the client with mapped fields", async () => {
    const updateWellness = vi.fn(async () => ({ id: "2026-06-14" }));
    const client = fakeClient({ updateWellness });
    await tool("update_wellness").handler(client, {
      date: "2026-06-14",
      weight: 91.5,
      restingHR: 48,
    });
    expect(updateWellness).toHaveBeenCalledWith("2026-06-14", {
      weight: 91.5,
      restingHR: 48,
    });
  });
});
