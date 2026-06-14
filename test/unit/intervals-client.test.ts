import { describe, expect, it, vi } from "vitest";
import { IntervalsApiError, IntervalsClient } from "../../src/lib/intervals-client.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function makeClient(fetchImpl: typeof fetch, maxRetries = 3) {
  return new IntervalsClient({
    apiKey: "secret",
    fetchImpl,
    maxRetries,
    sleep: async () => {}, // no real backoff delay in tests
  });
}

describe("auth + URL building", () => {
  it("uses Basic API_KEY auth and athlete 0 scoped paths", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.getWellness("2026-06-01", "2026-06-14");

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/v1/athlete/0/wellness");
    expect(url).toContain("oldest=2026-06-01");
    expect(url).toContain("newest=2026-06-14");
    const auth = (init as RequestInit).headers as Record<string, string>;
    expect(auth.Authorization).toBe("Basic " + btoa("API_KEY:secret"));
  });

  it("omits undefined query params", () => {
    const client = makeClient((async () => jsonResponse([])) as typeof fetch);
    const url = client.buildUrl("/activities", { limit: 30, oldest: undefined });
    expect(url).toContain("limit=30");
    expect(url).not.toContain("oldest");
  });
});

describe("retry/backoff", () => {
  it("retries on 429 honouring the request, then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } }))
      .mockResolvedValueOnce(jsonResponse({ id: "athlete" }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const result = await client.getAthlete();
    expect(result).toEqual({ id: "athlete" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries on 5xx up to maxRetries then throws IntervalsApiError", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch, 2);
    await expect(client.getAthlete()).rejects.toBeInstanceOf(IntervalsApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // 1 + 2 retries
  });

  it("does NOT retry on 4xx (other than 429)", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 404 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await expect(client.getAthlete()).rejects.toMatchObject({ status: 404 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries on network error", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await expect(client.getAthlete()).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("read endpoints build the right URLs", () => {
  function setup() {
    const fetchImpl = vi.fn(async () => jsonResponse([]));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    return { fetchImpl, client };
  }

  it("listActivities → athlete-scoped /activities with limit", async () => {
    const { fetchImpl, client } = setup();
    await client.listActivities({ limit: 10, oldest: "2026-01-01" });
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toContain("/athlete/0/activities?");
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toContain("limit=10");
  });

  it("getActivity → non-scoped /api/v1/activity/{id}", async () => {
    const { fetchImpl, client } = setup();
    fetchImpl.mockResolvedValueOnce(jsonResponse({ id: "i1" }));
    await client.getActivity("i1");
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toContain("/api/v1/activity/i1");
  });

  it("getActivityStreams → /activity/{id}/streams?types=", async () => {
    const { fetchImpl, client } = setup();
    fetchImpl.mockResolvedValueOnce(jsonResponse([]));
    await client.getActivityStreams("i1", ["watts", "heartrate"]);
    const url = String((fetchImpl.mock.calls[0] as unknown[])[0]);
    expect(url).toContain("/api/v1/activity/i1/streams");
    expect(url).toContain("types=watts%2Cheartrate");
  });

  it("getCurves maps hr → heartrate type", async () => {
    const { fetchImpl, client } = setup();
    fetchImpl.mockResolvedValueOnce(jsonResponse({}));
    await client.getCurves("hr", { oldest: "2026-01-01", newest: "2026-06-01" });
    const url = String((fetchImpl.mock.calls[0] as unknown[])[0]);
    expect(url).toContain("/athlete/0/activity-curves");
    expect(url).toContain("type=heartrate");
  });

  it("getEvents → /events with range", async () => {
    const { fetchImpl, client } = setup();
    await client.getEvents("2026-06-01", "2026-06-30");
    const url = String((fetchImpl.mock.calls[0] as unknown[])[0]);
    expect(url).toContain("/athlete/0/events");
    expect(url).toContain("oldest=2026-06-01");
  });

  it("returns undefined for a 204 No Content response", async () => {
    const { fetchImpl, client } = setup();
    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(client.getAthlete()).resolves.toBeUndefined();
  });

  it("requestAbsolute throws IntervalsApiError on non-ok", async () => {
    const { fetchImpl, client } = setup();
    fetchImpl.mockResolvedValueOnce(new Response("missing", { status: 404 }));
    await expect(client.getActivity("nope")).rejects.toBeInstanceOf(IntervalsApiError);
  });

  it("throws IntervalsApiError on a 200 with a non-JSON body", async () => {
    const { fetchImpl, client } = setup();
    fetchImpl.mockResolvedValueOnce(
      new Response("<html>maintenance</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );
    await expect(client.getAthlete()).rejects.toBeInstanceOf(IntervalsApiError);
  });

  it("retries absolute (getActivity) requests on 5xx", async () => {
    const { fetchImpl, client } = setup();
    fetchImpl
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(jsonResponse({ id: "i1" }));
    await expect(client.getActivity("i1")).resolves.toEqual({ id: "i1" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("writes", () => {
  it("PUTs wellness with a JSON body to the dated path", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "2026-06-14" }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.updateWellness("2026-06-14", { weight: 91.5 });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/v1/athlete/0/wellness/2026-06-14");
    expect((init as RequestInit).method).toBe("PUT");
    expect((init as RequestInit).body).toBe(JSON.stringify({ weight: 91.5 }));
  });
});
