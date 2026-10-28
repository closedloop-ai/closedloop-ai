import { describe, expect, it } from "vitest";
import { parseDesktopAgentSessionsPayload } from "../desktop-agent-sessions-schema";
import { validDesktopAgentSessionsPayload as validPayload } from "./desktop-agent-sessions-handler-fixtures";

/**
 * ISS-10177. Session and agent `metadata` were validated by `z.record`, which
 * assigns onto a plain object and so silently loses an own `__proto__` key —
 * `ok: true`, no diagnostic, the entry simply gone. The desktop deliberately
 * PRESERVES that key (ISS-8565, ISS-8883), so the cloud dropped it at PARSE
 * time, before `sanitizeMetadataForPersist` ever ran.
 *
 * Driven through `parseDesktopAgentSessionsPayload` rather than the schema
 * alone: that is the production entry, and it runs the FEA-2258 sanitize pass
 * (which already preserved the key via `Object.defineProperty`) immediately
 * before the schema that was undoing that work.
 *
 * Fixtures come from `JSON.parse` — a quoted `"__proto__"` in an object literal
 * is the prototype-setter form and creates no own key to preserve.
 */
function parseWithSessionMetadata(metadata: unknown) {
  return parseDesktopAgentSessionsPayload({
    ...validPayload,
    sessions: [{ ...validPayload.sessions[0], metadata }],
  });
}

describe("desktop payload parse preserves a __proto__ metadata key (ISS-10177)", () => {
  it("keeps a top-level __proto__ on session metadata", () => {
    const result = parseWithSessionMetadata(
      JSON.parse('{"source":"desktop","__proto__":{"deep":1}}')
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const stored = result.payload.sessions[0]?.metadata as Record<
        string,
        unknown
      >;
      // The key SET, not `ok`: the drop left `ok` true, so asserting the parse
      // succeeded is the false green this regression exists to avoid.
      expect(Object.keys(stored).sort()).toEqual(["__proto__", "source"]);
      // biome-ignore lint/suspicious/noProto: ISS-10177 regression — the hostile key IS the subject under test
      expect(stored.__proto__).toEqual({ deep: 1 });
      expect(Object.getPrototypeOf(stored)).toBe(Object.prototype);
    }
  });

  it("keeps a NESTED __proto__, which a top-level-only guard would miss", () => {
    const result = parseWithSessionMetadata(
      JSON.parse('{"outer":{"__proto__":{"deep":1},"keep":2}}')
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const stored = result.payload.sessions[0]?.metadata as Record<
        string,
        unknown
      >;
      // Measured before the fix this came back as {"outer":{"keep":2}} — the
      // value schema recursed through z.record for every nested object.
      const outer = stored.outer as Record<string, unknown>;
      expect(Object.keys(outer).sort()).toEqual(["__proto__", "keep"]);
      // biome-ignore lint/suspicious/noProto: ISS-10177 regression — the hostile key IS the subject under test
      expect(outer.__proto__).toEqual({ deep: 1 });
    }
  });

  it("never pollutes Object.prototype while doing so", () => {
    parseWithSessionMetadata(JSON.parse('{"__proto__":{"polluted":true}}'));

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
