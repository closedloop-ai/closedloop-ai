import { describe, expect, it } from "vitest";
import {
  compactMetadataForPreview,
  MAX_METADATA_MESSAGE_TEXT_CHARS,
  MAX_METADATA_TOTAL_MESSAGE_TEXT_CHARS,
  MIN_METADATA_MESSAGE_TEXT_CHARS,
} from "./metadata-preview";

type Msg = Record<string, unknown>;

function messagesOf(result: unknown): Msg[] {
  return (result as { messages: Msg[] }).messages;
}

describe("compactMetadataForPreview (FEA-3693 shared preview contract)", () => {
  it("drops message bodies while keeping allowlisted fields + text truncation marker", () => {
    const result = compactMetadataForPreview({
      messages: [
        {
          role: "user",
          timestamp: "2026-07-16T00:00:00.000Z",
          model: "claude-opus-4-8",
          text: "hi",
          isThinking: false,
          isSynthetic: true,
          content: [{ type: "text", text: "SECRET raw prompt / source code" }],
          apiKey: "sk_live_should_not_persist",
        },
      ],
    });

    expect(result).toEqual({
      messages: [
        {
          role: "user",
          timestamp: "2026-07-16T00:00:00.000Z",
          model: "claude-opus-4-8",
          text: "hi",
          textTruncation: "complete",
          isThinking: false,
          isSynthetic: true,
        },
      ],
    });
  });

  it("marks a short, fully-retained turn as `complete`", () => {
    const out = messagesOf(
      compactMetadataForPreview({ messages: [{ role: "user", text: "short" }] })
    );
    expect(out[0].text).toBe("short");
    expect(out[0].textTruncation).toBe("complete");
  });

  it("marks an over-cap turn as `previewed` and truncates at the per-message cap", () => {
    const out = messagesOf(
      compactMetadataForPreview({
        messages: [{ role: "user", text: "z".repeat(4096) }],
      })
    );
    expect((out[0].text as string).length).toBe(
      MAX_METADATA_MESSAGE_TEXT_CHARS
    );
    expect(out[0].textTruncation).toBe("previewed");
  });

  it("OMITS absent text entirely (no `text`, no `textTruncation`, never null)", () => {
    const out = messagesOf(
      compactMetadataForPreview({
        messages: [
          { role: "assistant", timestamp: "2026-07-16T00:00:00.000Z" },
        ],
      })
    );
    expect("text" in out[0]).toBe(false);
    expect("textTruncation" in out[0]).toBe(false);
    expect(JSON.stringify(out[0])).not.toContain("null");
  });

  it("enforces the per-message FLOOR after the aggregate budget is spent (never drops later text)", () => {
    // 100 messages of 2500 chars each. The aggregate budget (60_000) is spent by
    // message ~24; every later message must still keep a floor-length preview —
    // this is the exact FEA-3693 divergence the old API sanitizer had (it emitted
    // `undefined` text for the tail while desktop kept the floor).
    const messages = Array.from({ length: 100 }, () => ({
      role: "user",
      timestamp: "2026-07-16T00:00:00.000Z",
      text: "q".repeat(3000), // over the 2500 per-message cap
    }));
    const out = messagesOf(compactMetadataForPreview({ messages }));
    expect(out.length).toBe(100);

    // Early messages keep the full per-message preview (truncated from source)...
    expect(out[0].text).toBe("q".repeat(MAX_METADATA_MESSAGE_TEXT_CHARS));
    expect(out[0].textTruncation).toBe("previewed");

    // ...and EVERY later, budget-exhausted message still keeps at least the floor
    // (never omits `text`), truthfully marked `previewed`.
    for (const msg of out) {
      expect(typeof msg.text).toBe("string");
      expect((msg.text as string).length).toBeGreaterThanOrEqual(
        MIN_METADATA_MESSAGE_TEXT_CHARS
      );
    }
    const last = out[99];
    expect(last.text).toBe("q".repeat(MIN_METADATA_MESSAGE_TEXT_CHARS));
    expect(last.textTruncation).toBe("previewed");
    expect(last.role).toBe("user");
    expect(last.timestamp).toBe("2026-07-16T00:00:00.000Z");
  });

  it("keeps the summed preview text near the aggregate budget plus the guaranteed floors", () => {
    const messages = Array.from({ length: 100 }, () => ({
      role: "user",
      text: "q".repeat(2500),
    }));
    const out = messagesOf(compactMetadataForPreview({ messages }));
    const total = out.reduce(
      (sum, m) => sum + (typeof m.text === "string" ? m.text.length : 0),
      0
    );
    // Aggregate budget + at most one floor per message is the hard ceiling.
    expect(total).toBeLessThanOrEqual(
      MAX_METADATA_TOTAL_MESSAGE_TEXT_CHARS +
        100 * MIN_METADATA_MESSAGE_TEXT_CHARS
    );
  });

  it("redacts secrets before truncation (no partial-key leak at the boundary)", () => {
    const A32 = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";
    const filler = "x".repeat(2490);
    const result = compactMetadataForPreview({
      messages: [{ role: "user", text: `${filler} sk_live_${A32}` }],
    });
    const mirror = JSON.stringify(result);
    expect(mirror.includes("sk_live_")).toBe(false);
    expect(mirror.includes("A1b2C3d4")).toBe(false);
  });

  it("returns null for non-objects and objects that compact to nothing", () => {
    expect(compactMetadataForPreview(null)).toBeNull();
    expect(compactMetadataForPreview("str")).toBeNull();
    expect(compactMetadataForPreview([1, 2, 3])).toBeNull();
    expect(compactMetadataForPreview({})).toBeNull();
    expect(compactMetadataForPreview({ tokenSeries: [1] })).toBeNull();
  });

  it("is idempotent for already-compacted metadata (incl. re-derived markers)", () => {
    const input = {
      gitBranch: "main",
      messages: [
        {
          role: "user",
          timestamp: "2026-07-16T00:00:00.000Z",
          text: "hi there",
        },
      ],
    };
    const once = compactMetadataForPreview(input);
    const twice = compactMetadataForPreview(once);
    expect(twice).toEqual(once);
  });

  it("keeps a previewed marker when compacting an already-truncated payload", () => {
    const input = {
      messages: [
        {
          role: "user",
          text: "short preview",
          textTruncation: "previewed",
        },
      ],
    };
    const out = messagesOf(compactMetadataForPreview(input));
    expect(out[0].textTruncation).toBe("previewed");
  });

  it("collapses objects beyond MAX_METADATA_DEPTH to null instead of recursing", () => {
    // Objects at depth > MAX_METADATA_DEPTH (4) collapse to null inside their parent.
    const deep: Record<string, unknown> = { f: "value" };
    // Nest MAX_METADATA_DEPTH + 1 levels: a→b→c→d→e→deep
    const input = { a: { b: { c: { d: { e: deep } } } } };
    const result = compactMetadataForPreview(input);
    expect(result).not.toBeNull();
    // "e" is at depth 5 (> MAX_METADATA_DEPTH=4) → collapsed to null
    expect((result as Record<string, unknown>)?.a).toBeDefined();
    const d = ((result as Record<string, unknown>).a as Record<string, unknown>)
      .b as { c: { d: { e: null } } };
    expect(d.c.d.e).toBeNull();
  });

  it("collapses arrays beyond MAX_METADATA_DEPTH to an empty array", () => {
    // Arrays at depth > MAX_METADATA_DEPTH (4) become [].
    const input = { a: { b: { c: { d: { e: [1, 2, 3] } } } } };
    const result = compactMetadataForPreview(input) as {
      a: { b: { c: { d: { e: unknown[] } } } };
    };
    expect(result?.a?.b?.c?.d?.e).toEqual([]);
  });

  it("preserves null, boolean, and number values in compacted objects", () => {
    const result = compactMetadataForPreview({
      active: true,
      count: 42,
      ratio: 0.5,
      empty: null,
    });
    expect(result).toEqual({
      active: true,
      count: 42,
      ratio: 0.5,
      empty: null,
    });
  });

  it("handles a non-array messages field by compacting it as a plain value", () => {
    // messages field that is not an array → compactMetadataMessages receives a
    // non-array and delegates to compactMetadataValue.
    const result = compactMetadataForPreview({ messages: "plain text" });
    expect(result).toEqual({ messages: "plain text" });
  });

  it("converts messages field to null when compactMetadataValue returns undefined", () => {
    // A messages field whose value cannot be represented (e.g. undefined) causes
    // compactMetadataValue to return undefined, which the ?? null coercion catches.
    const input: Record<string, unknown> = { messages: undefined };
    const result = compactMetadataForPreview(input);
    expect(result).toEqual({ messages: null });
  });

  it("replaces non-record items in the messages array with null", () => {
    // isRecord fails for primitives → each becomes null in the output array.
    const result = compactMetadataForPreview({
      messages: [42, "string", null, true],
    });
    expect(result).toEqual({ messages: [null, null, null, null] });
  });
});
