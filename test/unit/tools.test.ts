import { describe, expect, it, vi } from "vitest";
import type { ToolCallOptions } from "ai";
import { buildCoachTools, type CoachToolDeps } from "../../src/tools";

function makeDeps(overrides: Partial<CoachToolDeps> = {}): CoachToolDeps {
  return {
    schedule: vi.fn(),
    getSchedules: vi.fn(() => []),
    cancelSchedule: vi.fn(),
    ...overrides
  };
}

const fakeCtx = {
  toolCallId: "test",
  messages: [],
  abortSignal: new AbortController().signal
} as unknown as ToolCallOptions;

async function run<T>(
  exec: ((args: T, ctx: ToolCallOptions) => unknown) | undefined,
  args: T
): Promise<unknown> {
  if (!exec) throw new Error("tool has no execute function");
  return await exec(args, fakeCtx);
}

describe("buildCoachTools", () => {
  it("exposes the expected tool names", () => {
    const tools = buildCoachTools(makeDeps());
    expect(Object.keys(tools).sort()).toEqual(
      [
        "cancelScheduledTask",
        "getCurrentWeek",
        "getRecentDays",
        "getScheduledTasks",
        "getToday",
        "getUserTimezone",
        "scheduleTask"
      ].sort()
    );
  });

  it("getUserTimezone has no execute (handled by the browser)", () => {
    const tools = buildCoachTools(makeDeps());
    expect(tools.getUserTimezone.execute).toBeUndefined();
  });

  it("every other tool has a description and inputSchema", () => {
    const tools = buildCoachTools(makeDeps());
    for (const [name, t] of Object.entries(tools)) {
      expect(t.description, `${name} description`).toBeTruthy();
      expect(t.inputSchema, `${name} inputSchema`).toBeDefined();
    }
  });
});

describe("getToday", () => {
  it("returns the date in the requested timezone using the injected clock", async () => {
    const fixed = new Date("2026-05-03T22:00:00Z");
    const tools = buildCoachTools(makeDeps(), () => fixed);
    expect(await run(tools.getToday.execute, { timezone: "UTC" })).toEqual({
      date: "2026-05-03"
    });
    expect(
      await run(tools.getToday.execute, { timezone: "Europe/Helsinki" })
    ).toEqual({ date: "2026-05-04" }); // 22:00 UTC = 01:00 next day in Helsinki summer
    expect(
      await run(tools.getToday.execute, { timezone: "America/Los_Angeles" })
    ).toEqual({ date: "2026-05-03" });
  });

  it("uses real clock by default", async () => {
    const tools = buildCoachTools(makeDeps());
    const result = (await run(tools.getToday.execute, { timezone: "UTC" })) as {
      date: string;
    };
    expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("getCurrentWeek", () => {
  it("returns Mon–Sun for 'today' in the given timezone", async () => {
    const fixed = new Date("2026-05-06T12:00:00Z"); // Wednesday UTC
    const tools = buildCoachTools(makeDeps(), () => fixed);
    expect(
      await run(tools.getCurrentWeek.execute, { timezone: "UTC" })
    ).toEqual({ from: "2026-05-04", to: "2026-05-10" });
  });

  it("respects timezone when computing 'today'", async () => {
    // 22:00 UTC Sunday is 00:00 Monday in Helsinki summer (UTC+3)
    const fixed = new Date("2026-05-03T22:00:00Z");
    const tools = buildCoachTools(makeDeps(), () => fixed);
    expect(
      await run(tools.getCurrentWeek.execute, { timezone: "UTC" })
    ).toEqual({ from: "2026-04-27", to: "2026-05-03" });
    expect(
      await run(tools.getCurrentWeek.execute, { timezone: "Europe/Helsinki" })
    ).toEqual({ from: "2026-05-04", to: "2026-05-10" });
  });
});

describe("getRecentDays", () => {
  it("returns a rolling window ending today (inclusive)", async () => {
    const fixed = new Date("2026-05-06T12:00:00Z"); // Wednesday UTC
    const tools = buildCoachTools(makeDeps(), () => fixed);
    expect(
      await run(tools.getRecentDays.execute, { days: 7, timezone: "UTC" })
    ).toEqual({ from: "2026-04-30", to: "2026-05-06" });
  });

  it("days=1 means today only", async () => {
    const fixed = new Date("2026-05-06T12:00:00Z");
    const tools = buildCoachTools(makeDeps(), () => fixed);
    expect(
      await run(tools.getRecentDays.execute, { days: 1, timezone: "UTC" })
    ).toEqual({ from: "2026-05-06", to: "2026-05-06" });
  });

  it("crosses month boundaries correctly", async () => {
    const fixed = new Date("2026-05-03T12:00:00Z");
    const tools = buildCoachTools(makeDeps(), () => fixed);
    expect(
      await run(tools.getRecentDays.execute, { days: 7, timezone: "UTC" })
    ).toEqual({ from: "2026-04-27", to: "2026-05-03" });
  });

  it("respects timezone when computing 'today'", async () => {
    // 22:00 UTC = 01:00 next day in Helsinki summer
    const fixed = new Date("2026-05-03T22:00:00Z");
    const tools = buildCoachTools(makeDeps(), () => fixed);
    expect(
      await run(tools.getRecentDays.execute, {
        days: 7,
        timezone: "Europe/Helsinki"
      })
    ).toEqual({ from: "2026-04-28", to: "2026-05-04" });
  });
});

describe("scheduleTask", () => {
  it("schedules a delayed task and returns a confirmation string", async () => {
    const deps = makeDeps();
    const tools = buildCoachTools(deps);
    const out = await run(tools.scheduleTask.execute, {
      when: { type: "delayed", delayInSeconds: 60 },
      description: "drink water"
    });
    expect(out).toBe('Task scheduled: "drink water" (delayed: 60)');
    expect(deps.schedule).toHaveBeenCalledWith(60, "drink water");
  });

  it("schedules a scheduled-date task", async () => {
    const deps = makeDeps();
    const tools = buildCoachTools(deps);
    const date = "2026-05-04T08:00:00Z";
    const out = await run(tools.scheduleTask.execute, {
      when: { type: "scheduled", date },
      description: "weigh in"
    });
    expect(out).toBe(`Task scheduled: "weigh in" (scheduled: ${date})`);
    expect(deps.schedule).toHaveBeenCalledWith(date, "weigh in");
  });

  it("schedules a cron task", async () => {
    const deps = makeDeps();
    const tools = buildCoachTools(deps);
    const out = await run(tools.scheduleTask.execute, {
      when: { type: "cron", cron: "0 8 * * *" },
      description: "weigh in daily"
    });
    expect(out).toBe(
      'Task scheduled: "weigh in daily" (cron: 0 8 * * *)'
    );
    expect(deps.schedule).toHaveBeenCalledWith("0 8 * * *", "weigh in daily");
  });

  it("returns a friendly message for no-schedule input", async () => {
    const deps = makeDeps();
    const tools = buildCoachTools(deps);
    const out = await run(tools.scheduleTask.execute, {
      when: { type: "no-schedule" },
      description: "anything"
    });
    expect(out).toBe("Not a valid schedule input");
    expect(deps.schedule).not.toHaveBeenCalled();
  });

  it("catches errors thrown by the underlying scheduler", async () => {
    const deps = makeDeps({
      schedule: () => {
        throw new Error("durable object asleep");
      }
    });
    const tools = buildCoachTools(deps);
    const out = await run(tools.scheduleTask.execute, {
      when: { type: "delayed", delayInSeconds: 5 },
      description: "x"
    });
    expect(out).toMatch(/^Error scheduling task: /);
    expect(out).toMatch(/durable object asleep/);
  });
});

describe("getScheduledTasks", () => {
  it("returns the list when there are tasks", async () => {
    const tasks = [{ id: "a" }, { id: "b" }];
    const deps = makeDeps({ getSchedules: () => tasks });
    const tools = buildCoachTools(deps);
    const out = await run(tools.getScheduledTasks.execute, {});
    expect(out).toBe(tasks);
  });

  it("returns a friendly empty-state string", async () => {
    const tools = buildCoachTools(makeDeps());
    const out = await run(tools.getScheduledTasks.execute, {});
    expect(out).toBe("No scheduled tasks found.");
  });
});

describe("cancelScheduledTask", () => {
  it("cancels and returns a confirmation", async () => {
    const deps = makeDeps();
    const tools = buildCoachTools(deps);
    const out = await run(tools.cancelScheduledTask.execute, { taskId: "abc" });
    expect(out).toBe("Task abc cancelled.");
    expect(deps.cancelSchedule).toHaveBeenCalledWith("abc");
  });

  it("catches errors thrown by the underlying canceller", async () => {
    const deps = makeDeps({
      cancelSchedule: () => {
        throw new Error("not found");
      }
    });
    const tools = buildCoachTools(deps);
    const out = await run(tools.cancelScheduledTask.execute, { taskId: "x" });
    expect(out).toBe("Error cancelling task: Error: not found");
  });
});
