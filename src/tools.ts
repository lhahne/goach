import { tool } from "ai";
import { scheduleSchema } from "agents/schedule";
import { z } from "zod";
import { isoDateInTimezone, weekRange } from "./utils";

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
        timezone: z.string().describe("IANA timezone, e.g. 'Europe/Helsinki'")
      }),
      execute: async ({ timezone }) => {
        return { date: isoDateInTimezone(now(), timezone) };
      }
    }),

    getCurrentWeek: tool({
      description:
        "Return the from/to ISO dates for the current week (Mon–Sun) in the user's timezone. Use this before list_days when the user asks about 'this week' or 'the past week'.",
      inputSchema: z.object({
        timezone: z.string().describe("IANA timezone, e.g. 'Europe/Helsinki'")
      }),
      execute: async ({ timezone }) => {
        return weekRange(isoDateInTimezone(now(), timezone));
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
