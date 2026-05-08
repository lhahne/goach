import type { ModelMessage } from "ai";

/**
 * Format a Date as YYYY-MM-DD in the given IANA timezone.
 * Uses Intl.DateTimeFormat with locale "en-CA" because that locale
 * already produces ISO-style YYYY-MM-DD parts.
 */
export function isoDateInTimezone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const lookup = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

/**
 * Given an ISO date (YYYY-MM-DD) treated as a calendar day, return the
 * Mon–Sun week range that contains it (also as ISO dates).
 */
export function weekRange(today: string): { from: string; to: string } {
  const [y, m, d] = today.split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  const dayOfWeek = (utc.getUTCDay() + 6) % 7; // Mon=0, Sun=6
  const monday = new Date(utc);
  monday.setUTCDate(utc.getUTCDate() - dayOfWeek);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return {
    from: monday.toISOString().slice(0, 10),
    to: sunday.toISOString().slice(0, 10)
  };
}

/**
 * The AI SDK's downloadAssets step runs `new URL(data)` on every file
 * part's string data. Data URIs parse as valid URLs, so it tries to
 * HTTP-fetch them and fails. Decode base64 data URIs to Uint8Array so
 * the SDK treats them as inline data instead.
 */
export function inlineDataUrls(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "user" || typeof msg.content === "string") return msg;
    return {
      ...msg,
      content: msg.content.map((part) => {
        if (part.type !== "file" || typeof part.data !== "string") return part;
        const match = part.data.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) return part;
        const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
        return { ...part, data: bytes, mediaType: match[1] };
      })
    };
  });
}

/**
 * Replace file (image) parts in every user message except the most
 * recent one with a small text placeholder.
 *
 * Why: persisted chat history is replayed to the model on every turn.
 * Without this, every uploaded image keeps being decoded and resent on
 * each follow-up message — making small turns exceed the 8 MB Workers
 * AI request limit and slowing down the conversation. The model still
 * sees that an image existed (so it can refer back to it conceptually)
 * but the bytes only travel once.
 */
export function dropStaleFileParts(messages: ModelMessage[]): ModelMessage[] {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return messages;
  return messages.map((msg, i) => {
    if (i === lastUserIdx) return msg;
    if (msg.role !== "user" || typeof msg.content === "string") return msg;
    return {
      ...msg,
      content: msg.content.map((part) =>
        part.type === "file"
          ? { type: "text" as const, text: "[image attachment, no longer in context]" }
          : part
      )
    };
  });
}
