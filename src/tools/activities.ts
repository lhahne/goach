import { getActivityShape, listActivitiesShape } from "../lib/schemas.js";
import { downsample, summarizeActivity, truncateList } from "../lib/summarize.js";
import { READ_ONLY, type ToolDef } from "./types.js";

export const activityTools: ToolDef[] = [
  {
    name: "list_activities",
    description:
      "List activities, most recent first, as compact summary rows (id, name, type, " +
      "date, duration, distance, load, average power/HR). Use get_activity for the full " +
      "detail of one activity. Returns at most `limit` rows and reports the total found.",
    inputSchema: listActivitiesShape,
    annotations: { ...READ_ONLY, title: "List activities" },
    handler: async (client, input) => {
      const limit = (input.limit as number) ?? 30;
      const activities = (await client.listActivities({
        oldest: input.oldest as string | undefined,
        newest: input.newest as string | undefined,
        limit,
      })) as Record<string, unknown>[];
      const { items, total, truncated } = truncateList(activities, limit);
      return {
        total,
        truncated,
        activities: items.map(summarizeActivity),
      };
    },
  },
  {
    name: "get_activity",
    description:
      "Get full details and the interval list for one activity. Per-second streams " +
      "(power/HR/etc.) are NOT included unless include_streams is true, and when " +
      "included they are downsampled to keep the response small.",
    inputSchema: getActivityShape,
    annotations: { ...READ_ONLY, title: "Get activity detail" },
    handler: async (client, input) => {
      const id = input.id as string;
      const activity = await client.getActivity(id);
      if (!input.include_streams) return { activity };

      const types = input.stream_types as string[];
      const maxPoints = input.max_stream_points as number;
      const raw = (await client.getActivityStreams(id, types)) as
        | { type: string; data: unknown[] }[]
        | Record<string, unknown[]>;

      // Intervals.icu returns either an array of {type,data} or a keyed object;
      // normalise to a map and downsample each channel.
      const channels: Record<string, unknown[]> = {};
      if (Array.isArray(raw)) {
        for (const s of raw) {
          if (s && typeof s === "object" && "type" in s && Array.isArray(s.data)) {
            channels[s.type] = downsample(s.data, maxPoints);
          }
        }
      } else {
        for (const [k, v] of Object.entries(raw)) {
          if (Array.isArray(v)) channels[k] = downsample(v, maxPoints);
        }
      }
      return { activity, streams: channels, downsampled_to: maxPoints };
    },
  },
];
