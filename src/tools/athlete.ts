import { READ_ONLY, type ToolDef } from "./types.js";

export const athleteTools: ToolDef[] = [
  {
    name: "get_athlete",
    description:
      "Get the athlete profile and current fitness metrics (FTP, training zones, " +
      "and the latest CTL/ATL/form if present). Use this for the user's settings " +
      "and overall fitness state rather than per-day data.",
    inputSchema: {},
    annotations: { ...READ_ONLY, title: "Get athlete profile" },
    handler: (client) => client.getAthlete(),
  },
];
