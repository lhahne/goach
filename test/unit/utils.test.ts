import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import {
  dropStaleFileParts,
  inlineDataUrls,
  isoDateInTimezone,
  weekRange
} from "../../src/utils";

describe("isoDateInTimezone", () => {
  it("formats UTC midnight in UTC", () => {
    expect(isoDateInTimezone(new Date("2026-05-03T00:00:00Z"), "UTC")).toBe(
      "2026-05-03"
    );
  });

  it("rolls forward when the local timezone is east of UTC", () => {
    // 23:30 UTC is already 02:30 next day in Helsinki (UTC+3 in May, DST)
    expect(
      isoDateInTimezone(new Date("2026-05-03T23:30:00Z"), "Europe/Helsinki")
    ).toBe("2026-05-04");
  });

  it("rolls backward when the local timezone is west of UTC", () => {
    // 02:00 UTC is still 22:00 previous day in New York (UTC-4 in May, DST)
    expect(
      isoDateInTimezone(new Date("2026-05-03T02:00:00Z"), "America/New_York")
    ).toBe("2026-05-02");
  });

  it("zero-pads single-digit months and days", () => {
    expect(isoDateInTimezone(new Date("2026-01-05T12:00:00Z"), "UTC")).toBe(
      "2026-01-05"
    );
  });

  it("handles year boundaries", () => {
    // 23:30 UTC on Dec 31 is Jan 1 in Tokyo (UTC+9)
    expect(
      isoDateInTimezone(new Date("2025-12-31T23:30:00Z"), "Asia/Tokyo")
    ).toBe("2026-01-01");
  });
});

describe("weekRange", () => {
  it("returns Mon–Sun for a Wednesday", () => {
    // 2026-05-06 is a Wednesday
    expect(weekRange("2026-05-06")).toEqual({
      from: "2026-05-04",
      to: "2026-05-10"
    });
  });

  it("returns Mon–Sun when given the Monday", () => {
    expect(weekRange("2026-05-04")).toEqual({
      from: "2026-05-04",
      to: "2026-05-10"
    });
  });

  it("returns Mon–Sun when given the Sunday", () => {
    expect(weekRange("2026-05-10")).toEqual({
      from: "2026-05-04",
      to: "2026-05-10"
    });
  });

  it("crosses a month boundary backwards (Sunday belongs to previous-month week)", () => {
    // 2026-05-03 is a Sunday → its week is Apr 27 – May 3
    expect(weekRange("2026-05-03")).toEqual({
      from: "2026-04-27",
      to: "2026-05-03"
    });
  });

  it("crosses a month boundary forwards", () => {
    // 2026-04-30 is a Thursday → week is Apr 27 – May 3
    expect(weekRange("2026-04-30")).toEqual({
      from: "2026-04-27",
      to: "2026-05-03"
    });
  });

  it("crosses a year boundary", () => {
    // 2026-01-01 is a Thursday → week is Dec 29 2025 – Jan 4 2026
    expect(weekRange("2026-01-01")).toEqual({
      from: "2025-12-29",
      to: "2026-01-04"
    });
  });
});

describe("inlineDataUrls", () => {
  it("returns the same array when there are no user messages", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "hi" },
      { role: "assistant", content: "yo" }
    ];
    expect(inlineDataUrls(messages)).toEqual(messages);
  });

  it("leaves user messages with string content untouched", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "hello" }];
    expect(inlineDataUrls(messages)).toEqual(messages);
  });

  it("leaves text parts untouched", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] }
    ];
    expect(inlineDataUrls(messages)).toEqual(messages);
  });

  it("converts a base64 data: URL on a file part to Uint8Array", () => {
    const png = "iVBORw0KGgo="; // arbitrary base64
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "file",
            data: `data:image/png;base64,${png}`,
            mediaType: "image/png"
          }
        ]
      }
    ];
    const out = inlineDataUrls(messages);
    const part = (out[0].content as Array<{ data: unknown; mediaType: string }>)[0];
    expect(part.data).toBeInstanceOf(Uint8Array);
    expect((part.data as Uint8Array).length).toBe(8); // decoded length of "iVBORw0KGgo="
    expect(part.mediaType).toBe("image/png");
  });

  it("preserves the mediaType from the data URL prefix", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "file",
            data: "data:application/pdf;base64,JVBERi0=",
            mediaType: "application/octet-stream"
          }
        ]
      }
    ];
    const out = inlineDataUrls(messages);
    const part = (out[0].content as Array<{ mediaType: string }>)[0];
    expect(part.mediaType).toBe("application/pdf");
  });

  it("leaves non-data: file URLs untouched", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "file",
            data: "https://example.com/cat.jpg",
            mediaType: "image/jpeg"
          }
        ]
      }
    ];
    expect(inlineDataUrls(messages)).toEqual(messages);
  });

  it("leaves file parts whose data is already a Uint8Array untouched", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [{ type: "file", data: bytes, mediaType: "image/png" }]
      }
    ];
    const out = inlineDataUrls(messages);
    const part = (out[0].content as Array<{ data: Uint8Array }>)[0];
    expect(part.data).toBe(bytes);
  });

  it("converts each file part inside a multi-part user message independently", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "what is in these?" },
          {
            type: "file",
            data: "data:image/png;base64,iVBORw0KGgo=",
            mediaType: "image/png"
          },
          {
            type: "file",
            data: "https://example.com/x.png",
            mediaType: "image/png"
          }
        ]
      }
    ];
    const out = inlineDataUrls(messages);
    const parts = out[0].content as Array<{ type: string; data?: unknown }>;
    expect(parts[0].type).toBe("text");
    expect(parts[1].data).toBeInstanceOf(Uint8Array);
    expect(parts[2].data).toBe("https://example.com/x.png");
  });
});

describe("dropStaleFileParts", () => {
  it("returns the array unchanged when there are no user messages", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "x" },
      { role: "assistant", content: "y" }
    ];
    expect(dropStaleFileParts(messages)).toEqual(messages);
  });

  it("keeps the latest user message untouched (including its file parts)", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const messages: ModelMessage[] = [
      { role: "user", content: [{ type: "file", data: bytes, mediaType: "image/png" }] }
    ];
    expect(dropStaleFileParts(messages)).toEqual(messages);
  });

  it("replaces file parts in older user messages with text placeholders", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "file", data: bytes, mediaType: "image/png" }
        ]
      },
      { role: "assistant", content: "ok" },
      { role: "user", content: "and now this" }
    ];
    const out = dropStaleFileParts(messages);
    const firstUserContent = out[0].content as Array<{ type: string; text?: string; data?: unknown }>;
    expect(firstUserContent[0]).toEqual({ type: "text", text: "look at this" });
    expect(firstUserContent[1]).toMatchObject({ type: "text" });
    expect(firstUserContent[1].text).toMatch(/no longer in context/);
    // The newer message keeps its plain string content untouched
    expect(out[2]).toEqual({ role: "user", content: "and now this" });
  });

  it("does not touch assistant messages", () => {
    const messages: ModelMessage[] = [
      { role: "assistant", content: "earlier reply" },
      { role: "user", content: "newer" }
    ];
    expect(dropStaleFileParts(messages)[0]).toEqual(messages[0]);
  });

  it("preserves text parts in older messages while only stripping file parts", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "keep this" },
          { type: "file", data: new Uint8Array([0]), mediaType: "image/png" },
          { type: "text", text: "and this" }
        ]
      },
      { role: "user", content: "newest" }
    ];
    const out = dropStaleFileParts(messages);
    const parts = out[0].content as Array<{ type: string; text?: string }>;
    expect(parts.map((p) => p.type)).toEqual(["text", "text", "text"]);
    expect(parts[0].text).toBe("keep this");
    expect(parts[2].text).toBe("and this");
  });
});
