import { tool } from "ai";
import { scheduleSchema } from "agents/schedule";
import { z } from "zod";
import { isoDateInTimezone, weekRange } from "./utils";

/**
 * Reject invalid IANA timezones at the schema layer so the AI SDK can
 * surface a structured validation error to the model (which can then
 * retry with a corrected zone), instead of letting Intl.DateTimeFormat
 * throw a RangeError that fails the whole tool call.
 */
export const timezoneSchema = z
  .string()
  .describe("IANA timezone, e.g. 'Europe/Helsinki'")
  .refine(
    (tz) => {
      try {
        new Intl.DateTimeFormat("en-CA", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    },
    {
      message:
        "Invalid IANA timezone. Use a name like 'UTC', 'Europe/Helsinki', or 'America/Los_Angeles'."
    }
  );

/**
 * Pre-bound dependencies the coach tools need from the surrounding agent.
 * Closures rather than methods so the agent's strict `keyof this` callback
 * type doesn't leak in here, and tests can pass plain fakes.
 */
export interface CoachToolDeps {
  schedule: (when: Date | string | number, description: string) => unknown;
  getSchedules: () => unknown[];
  cancelSchedule: (id: string) => void;
}

/**
 * Build the non-MCP tools the coach exposes to the LLM.
 *
 * `now` is injectable so tests can fix the clock for getToday / getCurrentWeek.
 */
export function buildCoachTools(
  deps: CoachToolDeps,
  now: () => Date = () => new Date()
) {
  return {
    // Client-side tool: the browser fills in the user's IANA timezone.
    getUserTimezone: tool({
      description:
        "Get the user's IANA timezone from their browser. Call before getToday or getCurrentWeek if you don't already know it.",
      inputSchema: z.object({})
    }),

    getToday: tool({
      description:
        "Return today's date as an ISO string (YYYY-MM-DD) in the user's timezone. Use this before querying habit-MCP tools that take a `date` argument.",
      inputSchema: z.object({
        timezone: timezoneSchema
      }),
      execute: async ({ timezone }) => {
        return { date: isoDateInTimezone(now(), timezone) };
      }
    }),

    getCurrentWeek: tool({
      description:
        "Return the from/to ISO dates for the current calendar week (Monday through Sunday) in the user's timezone. Use this when the user asks about 'this week'. For 'the past week', 'the last 7 days', or any rolling window, use getRecentDays instead.",
      inputSchema: z.object({
        timezone: timezoneSchema
      }),
      execute: async ({ timezone }) => {
        return weekRange(isoDateInTimezone(now(), timezone));
      }
    }),

    getRecentDays: tool({
      description:
        "Return the from/to ISO dates for the last N days ending today (rolling window) in the user's timezone. Use this for 'the past week' (days=7), 'the last month' (days=30), 'last 3 days' (days=3), etc. Pair with list_days from a habit MCP.",
      inputSchema: z.object({
        days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .describe("Number of days back from today, inclusive of today."),
        timezone: timezoneSchema
      }),
      execute: async ({ days, timezone }) => {
        const today = isoDateInTimezone(now(), timezone);
        const [y, m, d] = today.split("-").map(Number);
        const utc = new Date(Date.UTC(y, m - 1, d));
        const from = new Date(utc);
        from.setUTCDate(utc.getUTCDate() - (days - 1));
        return { from: from.toISOString().slice(0, 10), to: today };
      }
    }),

    scheduleTask: tool({
      description:
        "Schedule a task to be executed at a later time. Use this when the user asks to be reminded or wants something done later.",
      inputSchema: scheduleSchema,
      execute: async ({ when, description }) => {
        if (when.type === "no-schedule") {
          return "Not a valid schedule input";
        }
        const input =
          when.type === "scheduled"
            ? when.date
            : when.type === "delayed"
              ? when.delayInSeconds
              : when.type === "cron"
                ? when.cron
                : null;
        if (input === null || input === undefined) return "Invalid schedule type";
        try {
          deps.schedule(input, description);
          return `Task scheduled: "${description}" (${when.type}: ${input})`;
        } catch (error) {
          return `Error scheduling task: ${error}`;
        }
      }
    }),

    getScheduledTasks: tool({
      description: "List all tasks that have been scheduled",
      inputSchema: z.object({}),
      execute: async () => {
        const tasks = deps.getSchedules();
        return tasks.length > 0 ? tasks : "No scheduled tasks found.";
      }
    }),

    cancelScheduledTask: tool({
      description: "Cancel a scheduled task by its ID",
      inputSchema: z.object({
        taskId: z.string().describe("The ID of the task to cancel")
      }),
      execute: async ({ taskId }) => {
        try {
          deps.cancelSchedule(taskId);
          return `Task ${taskId} cancelled.`;
        } catch (error) {
          return `Error cancelling task: ${error}`;
        }
      }
    })
  };
}
