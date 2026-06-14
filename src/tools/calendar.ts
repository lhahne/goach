import { dateRangeShape } from "../lib/schemas.js";
import { READ_ONLY, type ToolDef } from "./types.js";

export const calendarTools: ToolDef[] = [
  {
    name: "list_calendar_events",
    description:
      "List calendar events over a date range, including planned/future workouts and " +
      "notes. Use this to see what is scheduled; use list_activities for completed efforts.",
    inputSchema: dateRangeShape,
    annotations: { ...READ_ONLY, title: "List calendar events" },
    handler: (client, input) =>
      client.getEvents(input.oldest as string, input.newest as string),
  },
];
