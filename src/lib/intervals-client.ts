import { INTERVALS_BASE_URL, SELF_ATHLETE_ID } from "../config.js";

export interface IntervalsClientOptions {
  apiKey: string;
  /** Injected for testing; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** Max retry attempts for 429/5xx (in addition to the first try). */
  maxRetries?: number;
  /** Sleep function (injected for testing so backoff is instant). */
  sleep?: (ms: number) => Promise<void>;
}

export class IntervalsApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Intervals.icu API error ${status}: ${body.slice(0, 200)}`);
    this.name = "IntervalsApiError";
  }
}

type Query = Record<string, string | number | boolean | undefined>;

/**
 * Typed, retrying wrapper around the Intervals.icu REST API.
 *
 * - Authenticates with HTTP Basic Auth, username "API_KEY", password = the key.
 * - Uses athlete id 0 (Intervals.icu resolves it to the key owner).
 * - Retries 429 and 5xx with exponential backoff, honouring `Retry-After`.
 */
export class IntervalsClient {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: IntervalsClientOptions) {
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = (opts.baseUrl ?? INTERVALS_BASE_URL).replace(/\/$/, "");
    this.maxRetries = opts.maxRetries ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private authHeader(): string {
    // btoa is available in Workers and Node 18+.
    return "Basic " + btoa(`API_KEY:${this.apiKey}`);
  }

  /** Build a full URL for an athlete-scoped path with optional query params. */
  buildUrl(path: string, query?: Query): string {
    const url = new URL(
      `${this.baseUrl}/api/v1/athlete/${SELF_ATHLETE_ID}${path}`,
    );
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  private backoffMs(attempt: number, retryAfter: string | null): number {
    if (retryAfter) {
      const secs = Number(retryAfter);
      if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
    }
    return Math.min(2 ** attempt * 500, 8000);
  }

  /** Core request: retry/backoff loop + safe JSON parsing for any URL. */
  private async send<T>(method: string, url: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: this.authHeader(),
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        // Network error — retry with backoff.
        lastError = err;
        if (attempt < this.maxRetries) {
          await this.sleep(this.backoffMs(attempt, null));
          continue;
        }
        throw err;
      }

      if (res.ok) {
        if (res.status === 204) return undefined as T;
        const text = await res.text();
        if (!text) return undefined as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new IntervalsApiError(
            res.status,
            `Invalid JSON response: ${text.slice(0, 200)}`,
          );
        }
      }

      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < this.maxRetries) {
        await this.sleep(this.backoffMs(attempt, res.headers.get("Retry-After")));
        continue;
      }
      throw new IntervalsApiError(res.status, await res.text());
    }
    // Unreachable in practice, but satisfies the type checker.
    throw lastError ?? new Error("Intervals.icu request failed");
  }

  /** Athlete-scoped request (/api/v1/athlete/0/...). */
  private request<T>(
    method: string,
    path: string,
    opts: { query?: Query; body?: unknown } = {},
  ): Promise<T> {
    return this.send<T>(method, this.buildUrl(path, opts.query), opts.body);
  }

  // --- Read endpoints ---

  getAthlete(): Promise<unknown> {
    // The athlete profile lives at /api/v1/athlete/{id} (no trailing segment).
    return this.request("GET", "");
  }

  getWellness(oldest: string, newest: string): Promise<unknown[]> {
    return this.request("GET", "/wellness", { query: { oldest, newest } });
  }

  listActivities(query: {
    oldest?: string;
    newest?: string;
    limit?: number;
  }): Promise<unknown[]> {
    return this.request("GET", "/activities", { query });
  }

  getActivity(id: string): Promise<unknown> {
    // Non athlete-scoped path; reuse fetch with an absolute override.
    return this.requestAbsolute("GET", `/api/v1/activity/${id}`);
  }

  getActivityStreams(id: string, types: string[]): Promise<unknown> {
    return this.requestAbsolute("GET", `/api/v1/activity/${id}/streams`, {
      types: types.join(","),
    });
  }

  getCurves(
    type: "power" | "pace" | "hr",
    query: { oldest?: string; newest?: string },
  ): Promise<unknown> {
    const param =
      type === "power" ? "power" : type === "pace" ? "pace" : "heartrate";
    return this.request("GET", "/activity-curves", {
      query: { type: param, ...query },
    });
  }

  getEvents(oldest: string, newest: string): Promise<unknown[]> {
    return this.request("GET", "/events", { query: { oldest, newest } });
  }

  // --- Write endpoints ---

  /** Idempotent upsert of a wellness record for a single date (YYYY-MM-DD). */
  updateWellness(date: string, fields: Record<string, unknown>): Promise<unknown> {
    return this.request("PUT", `/wellness/${date}`, { body: fields });
  }

  /** Helper for the few non athlete-scoped endpoints (shares retry/backoff). */
  private requestAbsolute<T>(method: string, path: string, query?: Query): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    return this.send<T>(method, url.toString());
  }
}
