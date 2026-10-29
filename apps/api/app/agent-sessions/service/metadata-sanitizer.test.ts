import { AGENT_TURN_TIMESTAMPS_METADATA_KEY } from "@repo/lib/agent-sessions/agent-turn-timestamps";
import { HUMAN_TURN_TIMESTAMPS_METADATA_KEY } from "@repo/lib/agent-sessions/human-turn-timestamps";
import { compactMetadataForPreview } from "@repo/lib/agent-sessions/metadata-preview";
import { describe, expect, it } from "vitest";
import { sanitizeMetadataForPersist } from "./metadata-sanitizer";

describe("sanitizeMetadataForPersist (FEA-3033)", () => {
  it("drops message bodies (`content`) while keeping the allowlisted fields", () => {
    const result = sanitizeMetadataForPersist({
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

  it("caps message count at 100", () => {
    const messages = Array.from({ length: 150 }, (_, i) => ({
      role: "user",
      text: `m${i}`,
    }));
    const result = sanitizeMetadataForPersist({ messages });
    expect(result).not.toBeNull();
    expect((result as { messages: unknown[] }).messages.length).toBe(100);
  });

  it("truncates message text to 2500 chars and other strings to 1024", () => {
    const result = sanitizeMetadataForPersist({
      gitBranch: "b".repeat(2000),
      messages: [{ role: "user", text: "t".repeat(5000) }],
    });
    expect(result).not.toBeNull();
    expect(result?.gitBranch).toBe("b".repeat(1024));
    expect((result as { messages: { text: string }[] }).messages[0].text).toBe(
      "t".repeat(2500)
    );
  });

  describe("FEAT 019f881c: secret redaction at the persist boundary", () => {
    const A32 = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";

    it("redacts secrets in the stored messages[].text mirror", () => {
      const result = sanitizeMetadataForPersist({
        messages: [
          {
            role: "user",
            text: `deploy with sk_live_${A32} and ghp_${A32}0000 now`,
          },
        ],
      });
      const stored = (result as { messages: { text: string }[] }).messages[0]
        .text;
      expect(stored).toBe(
        "deploy with [REDACTED:sk_live] and [REDACTED:ghp] now"
      );
      // Assert the whole stored blob is byte-clean, not just this field.
      const mirror = JSON.stringify(result);
      expect(mirror.includes(A32)).toBe(false);
      expect(mirror.includes("sk_live_")).toBe(false);
    });

    it("redacts a secret sitting at the truncation boundary (no partial leak)", () => {
      // Secret placed so its tail would fall past the per-message cap; redaction
      // runs BEFORE truncation, so no partial-key fragment survives.
      const filler = "x".repeat(2490);
      const result = sanitizeMetadataForPersist({
        messages: [{ role: "user", text: `${filler} sk_live_${A32}` }],
      });
      const mirror = JSON.stringify(result);
      expect(mirror.includes("sk_live_")).toBe(false);
      expect(mirror.includes("A1b2C3d4")).toBe(false);
    });

    it("does not over-redact benign snake_case prose", () => {
      const prose = "reads user_id and live_config from the test_suite";
      const result = sanitizeMetadataForPersist({
        messages: [{ role: "user", text: prose }],
      });
      const stored = (result as { messages: { text: string }[] }).messages[0]
        .text;
      expect(stored).toBe(prose);
    });
  });

  describe("FEA-3672: raised human-turn preview cap (was 160)", () => {
    it("preserves a >160-char human turn in full (no longer cut at 160)", () => {
      const text = `${"x".repeat(200)} end`; // 204 chars, well over the old 160 cap
      const result = sanitizeMetadataForPersist({
        messages: [
          { role: "user", timestamp: "2026-07-16T00:00:00.000Z", text },
        ],
      });
      const stored = (result as { messages: { text: string }[] }).messages[0]
        .text;
      expect(stored).toBe(text);
      expect(stored.length).toBe(204);
    });

    it("preserves a ~p95-length human turn (1361 chars) without truncation", () => {
      const text = "p".repeat(1361); // measured golden-corpus p95
      const result = sanitizeMetadataForPersist({
        messages: [
          { role: "user", timestamp: "2026-07-16T00:00:00.000Z", text },
        ],
      });
      expect(
        (result as { messages: { text: string }[] }).messages[0].text.length
      ).toBe(1361);
    });

    it("truncates a turn longer than the 2500 cap cleanly at 2500", () => {
      const result = sanitizeMetadataForPersist({
        messages: [{ role: "user", text: "z".repeat(4096) }],
      });
      const stored = (result as { messages: { text: string }[] }).messages[0]
        .text;
      expect(stored.length).toBe(2500);
      expect(stored).toBe("z".repeat(2500));
    });

    it("bounds aggregate preview text but keeps a per-message FLOOR on later turns (FEA-3693)", () => {
      // 100 messages each at the 2500 per-message cap would be ~250 KiB and
      // dead-letter the session on the desktop lane. The aggregate budget
      // (60_000 chars) keeps early messages full-length; once it is spent, later
      // messages fall back to the per-message FLOOR (160) rather than dropping
      // `text`. FEA-3693: this used to emit `undefined` text on the API lane
      // (while the desktop kept the floor), which is exactly the divergence this
      // change removes — both lanes now share ONE policy.
      const messages = Array.from({ length: 100 }, () => ({
        role: "user",
        timestamp: "2026-07-16T00:00:00.000Z",
        text: "q".repeat(2500),
      }));
      const result = sanitizeMetadataForPersist({ messages });
      const out = (result as { messages: Record<string, unknown>[] }).messages;
      expect(out.length).toBe(100);
      // The first messages keep their full 2500-char preview (source == cap, so
      // nothing was cut → `complete`)...
      expect(out[0].text).toBe("q".repeat(2500));
      expect(out[0].textTruncation).toBe("complete");
      // ...and a later, budget-exhausted message keeps a floor-length preview
      // (never silently drops `text`); its source (2500) is longer than the
      // stored floor slice (160), so it is truthfully marked `previewed`.
      const last = out[99];
      expect(last.role).toBe("user");
      expect(last.timestamp).toBe("2026-07-16T00:00:00.000Z");
      expect(last.text).toBe("q".repeat(160));
      expect(last.textTruncation).toBe("previewed");
    });

    it("delegates to the shared FEA-3693 preview contract (identical to compactMetadataForPreview)", () => {
      // The API persist strip and the shared SSOT must be byte-identical for the
      // same input — that is what keeps the cloud and desktop lanes aligned.
      const fixture = {
        gitBranch: "main",
        messages: [
          { role: "user", timestamp: "t1", text: "z".repeat(4096) },
          { role: "assistant", timestamp: "t2" },
          ...Array.from({ length: 60 }, () => ({
            role: "user",
            text: "q".repeat(2500),
          })),
        ],
      };
      expect(sanitizeMetadataForPersist(fixture)).toEqual(
        compactMetadataForPreview(fixture)
      );
    });

    it("still strips secrets/non-allowlisted fields across the full longer preview", () => {
      // A secret that sits past the old 160-char boundary (offset 300) must not
      // be re-exposed by the larger cap: it lives in a dropped field, and the
      // allowlist strip runs regardless of text length.
      const result = sanitizeMetadataForPersist({
        messages: [
          {
            role: "user",
            timestamp: "2026-07-16T00:00:00.000Z",
            text: `${"a".repeat(300)} visible prompt tail`,
            content: [
              { type: "text", text: `${"a".repeat(300)}sk_live_LEAKED_SECRET` },
            ],
            apiKey: "sk_live_should_not_persist",
          },
        ],
      });
      const message = (result as { messages: Record<string, unknown>[] })
        .messages[0];
      // Only allowlisted fields survive — content/apiKey are dropped whole.
      // `textTruncation` is the FEA-3693 derived marker for the retained preview.
      expect(Object.keys(message).sort()).toEqual([
        "role",
        "text",
        "textTruncation",
        "timestamp",
      ]);
      expect(JSON.stringify(result)).not.toContain("sk_live");
      expect(JSON.stringify(result)).not.toContain("LEAKED_SECRET");
      // The allowlisted text preview itself is preserved past the old 160 cap.
      expect((message.text as string).length).toBe(320);
    });
  });

  it("drops the omitted `tokenSeries` key", () => {
    const result = sanitizeMetadataForPersist({
      tokenSeries: [1, 2, 3],
      gitBranch: "main",
    });
    expect(result).toEqual({ gitBranch: "main" });
  });

  it("caps nesting depth at 4", () => {
    const result = sanitizeMetadataForPersist({
      l1: { l2: { l3: { l4: { l5: { l6: "too deep" } } } } },
    });
    // The object nested below the depth cap collapses to null.
    expect(result).toEqual({ l1: { l2: { l3: { l4: { l5: null } } } } });
  });

  it("caps array items at 100", () => {
    const result = sanitizeMetadataForPersist({
      values: Array.from({ length: 250 }, (_, i) => i),
    });
    expect(result).not.toBeNull();
    expect((result as { values: unknown[] }).values.length).toBe(100);
  });

  it("returns null for non-objects", () => {
    expect(sanitizeMetadataForPersist(null)).toBeNull();
    expect(sanitizeMetadataForPersist(undefined)).toBeNull();
    expect(sanitizeMetadataForPersist("a string")).toBeNull();
    expect(sanitizeMetadataForPersist([1, 2, 3])).toBeNull();
  });

  it("returns null when the object compacts to nothing", () => {
    expect(sanitizeMetadataForPersist({})).toBeNull();
    expect(sanitizeMetadataForPersist({ tokenSeries: [1] })).toBeNull();
  });

  it("is idempotent for already-compliant metadata", () => {
    const compliant = {
      gitBranch: "main",
      messages: [
        {
          role: "assistant",
          timestamp: "2026-07-16T00:00:00.000Z",
          text: "short",
          isThinking: false,
        },
      ],
    };
    const once = sanitizeMetadataForPersist(compliant);
    const twice = sanitizeMetadataForPersist(once);
    // Re-running is a fixed point (the derived `textTruncation` marker re-derives
    // to the same value), so a second pass never changes the output.
    expect(twice).toEqual(once);
    expect(once).toEqual({
      gitBranch: "main",
      messages: [
        {
          role: "assistant",
          timestamp: "2026-07-16T00:00:00.000Z",
          text: "short",
          textTruncation: "complete",
          isThinking: false,
        },
      ],
    });
  });
});

// ISS-7775 + ISS-8014 — WHAT THE CLOUD SIDE DOES WITH THE NARROWED CONTRACT.
//
// `compactMetadataForPreview` gained a content policy so the DESKTOP can stop
// shipping prompt-class text below the `full` data-sync level. That module is
// shared with this persist boundary by construction (FEA-3693), so the change
// reaches here whether or not anyone intended it to — which is exactly why the
// decision is written down as a test rather than left to the default.
//
// THIS BOUNDARY DELIBERATELY KEEPS THE PERMISSIVE POLICY. Two reasons, and both
// are about what this function actually is:
//
//  · It has no user tier to read. It runs on a payload that has ALREADY left
//    some machine. The batch envelope's `dataSyncLevel` (ISS-7516) is
//    SELF-REPORTED by the client, so it cannot decide egress at a trust
//    boundary; treating it as authority would let a caller pick its own policy.
//  · Narrowing unconditionally would delete the turn previews of `full`-tier
//    users, whose consent card says that text syncs, and whose branch merged
//    trace and `SessionDetail.turnItems[].text` render from it. That is a
//    capability this ticket has no mandate to take.
//
// So the cloud strip's SCOPE is unchanged. What it does gain is ISS-8014: every
// string it retains is now secret-redacted, not just `messages[].text`.
describe("the cloud persist boundary's own policy (ISS-7775 / ISS-8014)", () => {
  // Secret-SHAPED, never real. Booleans are compared rather than substrings so a
  // failure prints the policy question instead of the token.
  const SECRET_SHAPED = "sk-ant-api03-cloudunitAAAABBBBCCCCDDDDEEEEFFFFGGGG";

  it("still persists turn text, so a full-tier reader keeps their previews", () => {
    const result = sanitizeMetadataForPersist({
      messages: [
        { role: "user", timestamp: "2026-07-16T00:00:00.000Z", text: "hello" },
      ],
    }) as { messages: { text?: string }[] };
    expect(result.messages[0].text).toBe("hello");
  });

  it("redacts a secret under a key nothing in this repo names", () => {
    // The retained key set here is OPEN by design (deny-list plus bounds), so
    // redaction had to reach every string rather than a listed subset. Planted
    // under a key nobody enumerated, because an enumerated channel cannot
    // distinguish "extended to the channels someone listed" from "reaches
    // everything".
    const wire = JSON.stringify(
      sanitizeMetadataForPersist({ aKeyNoPolicyMentions: SECRET_SHAPED })
    );
    expect(
      wire.includes(SECRET_SHAPED),
      "a secret-shaped token under an unenumerated metadata key was persisted verbatim"
    ).toBe(false);
    expect(
      wire.includes("[REDACTED:sk-ant]"),
      "no marker either, so the token may be absent because the key was dropped rather than because it was redacted"
    ).toBe(true);
  });
});

describe("humanTurnTimestamps at the persist boundary (ISS-7896)", () => {
  const stamps = (count: number) =>
    Array.from(
      { length: count },
      (_, i) => `2026-06-15T${String(i % 24).padStart(2, "0")}:00:00.000Z`
    );

  it("passes a large derived array through intact", () => {
    // The whole fix dies here if this boundary re-caps the key: it runs the SAME
    // compactor the desktop producer ran, and `messages` beside it IS capped at
    // 100. 500 > MAX_METADATA_MESSAGES and > MAX_METADATA_ARRAY_ITEMS, so a
    // regression to either generic bound fails this.
    const result = sanitizeMetadataForPersist({
      [HUMAN_TURN_TIMESTAMPS_METADATA_KEY]: stamps(500),
      messages: Array.from({ length: 500 }, () => ({
        role: "human",
        timestamp: "2026-06-15T10:00:00.000Z",
      })),
    });

    expect(
      (result as Record<string, unknown>)[HUMAN_TURN_TIMESTAMPS_METADATA_KEY]
    ).toHaveLength(500);
    expect((result as { messages: unknown[] }).messages).toHaveLength(100);
  });

  it("never DERIVES the key from the already-capped messages it receives", () => {
    // By the time a payload reaches this boundary `messages` is a 100-row
    // preview. Deriving here would rebuild the key from that truncated array and
    // reinstate the undercount ISS-7896 removes, so the boundary must stay a
    // pass-through: no key in, no key out.
    const result = sanitizeMetadataForPersist({
      messages: Array.from({ length: 100 }, () => ({
        role: "human",
        timestamp: "2026-06-15T10:00:00.000Z",
      })),
    });

    expect(result).not.toHaveProperty(HUMAN_TURN_TIMESTAMPS_METADATA_KEY);
  });
});

describe("agentTurnTimestamps at the persist boundary (ISS-9864)", () => {
  const stamps = (count: number) =>
    Array.from(
      { length: count },
      (_, i) => `2026-06-15T${String(i % 24).padStart(2, "0")}:00:00.000Z`
    );

  it("passes a large derived array through intact", () => {
    // Same boundary, same trap as the human key: the shared compactor caps
    // `messages` at 100 beside it, and 500 > both generic bounds.
    const result = sanitizeMetadataForPersist({
      [AGENT_TURN_TIMESTAMPS_METADATA_KEY]: stamps(500),
      messages: Array.from({ length: 500 }, () => ({
        role: "assistant",
        timestamp: "2026-06-15T10:00:00.000Z",
      })),
    });

    expect(
      (result as Record<string, unknown>)[AGENT_TURN_TIMESTAMPS_METADATA_KEY]
    ).toHaveLength(500);
    expect((result as { messages: unknown[] }).messages).toHaveLength(100);
  });

  it("never DERIVES the key from the already-capped messages it receives", () => {
    const result = sanitizeMetadataForPersist({
      messages: Array.from({ length: 100 }, () => ({
        role: "assistant",
        timestamp: "2026-06-15T10:00:00.000Z",
      })),
    });

    expect(result).not.toHaveProperty(AGENT_TURN_TIMESTAMPS_METADATA_KEY);
  });
});
