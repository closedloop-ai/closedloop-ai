/**
 * @file desktop-agent-components-parse.test.ts
 * @description ISS-5164 — the ISS-5029 revision-history marker must survive the
 * PRODUCTION entry point of `POST /desktop/components/sync`, in both the new and
 * the old wire shape.
 *
 * `parseDesktopAgentComponentsPayload` is what the route actually calls, and it
 * is not the same thing as the schema: it sanitizes the raw body for Postgres
 * FIRST and validates the sanitized result. Every existing ISS-5029 test drives
 * `syncedComponentSchema` directly, so the sanitize-then-validate composition —
 * the only code path a real desktop's bytes take — was never exercised for these
 * fields at all.
 *
 * That matters here more than usual. The detail read's device-side "this history
 * is partial" ground (`emitVersionsTruncated`) is derived ONLY from
 * `variantsTruncated` / `variantsTruncatedReason`, and this boundary is a plain
 * non-strict `z.object`, so anything that dropped them would do so SILENTLY —
 * the ground would simply stay dark forever with no rejection and no log. That
 * ground only becomes reachable once Desktop builds carrying the ISS-5029 packer
 * roll out, so there is no production signal that would notice either.
 *
 * ISS-7560 adds the second describe: the failure half. Every case above enters
 * through `parseOneComponent`, which throws on `!result.ok`, so the suite could
 * not reach a single rejecting branch — the `reason` strings this entry point
 * produces were asserted only for the SESSION lane. These drive the entry point
 * directly and assert the exact reason.
 */
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import {
  SYNCED_COMPONENT_VARIANTS_MAX,
  SyncedComponentVariantsTruncatedReason,
} from "@repo/api/src/types/synced-component-content";
import { describe, expect, it } from "vitest";
import { parseDesktopAgentComponentsPayload } from "../desktop-agent-components-parse";
import { AGENT_COMPONENT_SYNC_SCHEMA_VERSION } from "../desktop-agent-sessions-schema";

const VALID_BATCH_ID = "22222222-2222-4222-8222-222222222222";

/**
 * Built via `fromCharCode` so no literal NUL byte lives in source, matching the
 * convention in `agent-sessions-text-sanitizer.ts` itself.
 */
const NUL_CHAR = String.fromCharCode(0);

/** A component as an UPGRADED desktop packs it: the marker keys are present. */
function markerAwareComponent(overrides: Record<string, unknown> = {}) {
  return {
    externalId: "agent::reviewer",
    componentKind: "agent",
    componentKey: "reviewer",
    contentHash: "hash-primary",
    content: "PRIMARY BODY",
    variantsTruncated: true,
    variantsTruncatedReason: SyncedComponentVariantsTruncatedReason.FamilyCap,
    ...overrides,
  };
}

/**
 * A component as a PRE-MARKER desktop packs it — every shipped build today. The
 * marker keys are absent entirely, which is a third state distinct from `false`
 * (the writer must leave a stored `true` from an upgraded peer device alone).
 */
function preMarkerComponent(overrides: Record<string, unknown> = {}) {
  return {
    externalId: "agent::reviewer",
    componentKind: "agent",
    componentKey: "reviewer",
    contentHash: "hash-primary",
    content: "PRIMARY BODY",
    ...overrides,
  };
}

function payloadWith(component: Record<string, unknown>) {
  return {
    schemaVersion: AGENT_COMPONENT_SYNC_SCHEMA_VERSION,
    batchId: VALID_BATCH_ID,
    syncMode: AgentSessionSyncMode.Incremental,
    componentCount: 1,
    components: [component],
  };
}

/** The single parsed component, or a hard failure naming the parse reason. */
function parseOneComponent(component: Record<string, unknown>) {
  const result = parseDesktopAgentComponentsPayload(payloadWith(component));
  if (!result.ok) {
    throw new Error(`entry point rejected the payload: ${result.reason}`);
  }
  const [parsed] = result.payload.components;
  return parsed;
}

describe("parseDesktopAgentComponentsPayload — ISS-5164 marker reachability", () => {
  it("carries an upgraded desktop's marker AND its cap reason through sanitize-then-validate", () => {
    const parsed = parseOneComponent(markerAwareComponent());

    expect(parsed.variantsTruncated).toBe(true);
    expect(parsed.variantsTruncatedReason).toBe(
      SyncedComponentVariantsTruncatedReason.FamilyCap
    );
  });

  it("carries an explicit `false`, which is the only thing that can clear a stale `true`", () => {
    const parsed = parseOneComponent(
      markerAwareComponent({
        variantsTruncated: false,
        variantsTruncatedReason: undefined,
      })
    );

    expect(parsed.variantsTruncated).toBe(false);
  });

  it("leaves a PRE-MARKER desktop's payload without the keys rather than defaulting them", () => {
    // The version-skew half. Every shipped Desktop build is this shape today, so
    // if the entry point invented a `false` here the writer would clear a `true`
    // an upgraded peer device on the same identity had just recorded.
    const parsed = parseOneComponent(preMarkerComponent());

    expect(Object.hasOwn(parsed, "variantsTruncated")).toBe(false);
    expect(Object.hasOwn(parsed, "variantsTruncatedReason")).toBe(false);
  });

  it("accepts a cap reason this cloud does not recognize instead of rejecting the batch", () => {
    // Forward-compat: the reason is an unconstrained string precisely so a newer
    // desktop's value cannot 400 a 200-component batch on every retry. The
    // detail read maps anything it does not recognize to "no proof".
    const parsed = parseOneComponent(
      markerAwareComponent({ variantsTruncatedReason: "some_future_cap" })
    );

    expect(parsed.variantsTruncated).toBe(true);
    expect(parsed.variantsTruncatedReason).toBe("some_future_cap");
  });

  it("keeps the marker when the SANITIZER rewrites a sibling field", () => {
    // The case only this entry point can cover. `sanitizePostgresJson` rebuilds
    // the payload object to strip NUL/lone-surrogate bytes Postgres `text`
    // rejects; a rebuild that did not carry every key forward would drop the
    // marker on exactly the definitions whose bodies are messiest, and the
    // schema-level tests would never see it because they never sanitize.
    const parsed = parseOneComponent(
      markerAwareComponent({ content: `PRIMARY${NUL_CHAR}BODY` })
    );

    expect(parsed.content).toBe("PRIMARYBODY");
    expect(parsed.variantsTruncated).toBe(true);
    expect(parsed.variantsTruncatedReason).toBe(
      SyncedComponentVariantsTruncatedReason.FamilyCap
    );
  });

  it("carries the variants the marker is ABOUT through the same path", () => {
    const parsed = parseOneComponent(
      markerAwareComponent({
        variants: [
          {
            contentHash: "hash-a",
            content: "REVISION A",
            format: "md",
            firstSeenAt: "2026-01-01T00:00:00.000Z",
            lastSeenAt: "2026-01-02T00:00:00.000Z",
          },
        ],
      })
    );

    expect(parsed.variants).toHaveLength(1);
    expect(parsed.variants?.[0]?.contentHash).toBe("hash-a");
  });

  it("marks the component truncated when THIS entry point is the thing that dropped revisions", () => {
    // The one path where the object-level transform WRITES the marker rather
    // than passing the sender's through, and the only place the whole
    // sanitize → validate → cap composition is exercised end to end. The cap
    // slices rather than rejects (one over-long component must not 400 a
    // 200-component batch on every retry), so without the marker the cloud
    // would store a set IT shortened as a complete history — and it overrides
    // the sender's weaker `byte_budget`, because whatever the packer believed
    // about its own run, an entry cap is what just bound here.
    const parsed = parseOneComponent(
      markerAwareComponent({
        variantsTruncated: false,
        variantsTruncatedReason:
          SyncedComponentVariantsTruncatedReason.ByteBudget,
        variants: Array.from(
          { length: SYNCED_COMPONENT_VARIANTS_MAX + 1 },
          (_, index) => ({
            contentHash: `hash-${index}`,
            content: `REVISION ${index}`,
          })
        ),
      })
    );

    expect(parsed.variants).toHaveLength(SYNCED_COMPONENT_VARIANTS_MAX);
    expect(parsed.variantsTruncated).toBe(true);
    expect(parsed.variantsTruncatedReason).toBe(
      SyncedComponentVariantsTruncatedReason.FamilyCap
    );
  });
});

describe("parseDesktopAgentComponentsPayload — ISS-7560 rejection branches", () => {
  /** A valid batch, so each case below varies exactly one thing. */
  function validPayload(overrides: Record<string, unknown> = {}) {
    return { ...payloadWith(markerAwareComponent()), ...overrides };
  }

  /** The reason this entry point rejected, or a hard failure if it accepted. */
  function reasonFor(payload: unknown) {
    const result = parseDesktopAgentComponentsPayload(payload);
    if (result.ok) {
      throw new Error("entry point accepted a payload it should have rejected");
    }
    return result.reason;
  }

  it("rejects a pathologically deep body before the schema sees it", () => {
    // The sanitizer is depth-bounded so an abusive body cannot exhaust the call
    // stack on the way to the database. 250 mirrors the bound-exceeding depth
    // the sanitizer's own suite uses; the bound itself is module-private.
    let deep: unknown = "leaf";
    for (let index = 0; index < 250; index += 1) {
      deep = { nested: deep };
    }

    expect(reasonFor(validPayload({ desktopLocalTree: deep }))).toBe(
      "payload_nested_too_deeply"
    );
  });

  it("rethrows an unrecognised sanitizer failure UNCHANGED rather than reporting it as invalid", () => {
    // The catch narrows on one error class; anything else is a bug in this
    // process, not a bad payload, and must not be laundered into a 400 that
    // tells the desktop to stop retrying. Identity — not just "it threw" — is
    // the contract: rewrapping would lose the original stack.
    const unrecognised = new Error("sanitizer exploded");
    const hostile = {};
    Object.defineProperty(hostile, "schemaVersion", {
      enumerable: true,
      get() {
        throw unrecognised;
      },
    });

    let thrown: unknown;
    try {
      parseDesktopAgentComponentsPayload(hostile);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(unrecognised);
  });

  it("names schemaVersion when a desktop sends a version this cloud does not speak", () => {
    expect(
      reasonFor(
        validPayload({ schemaVersion: AGENT_COMPONENT_SYNC_SCHEMA_VERSION + 1 })
      )
    ).toBe("schema_version_invalid");
  });

  it("names batchId when the batch identifier is not a uuid", () => {
    expect(reasonFor(validPayload({ batchId: "not-a-uuid" }))).toBe(
      "batch_id_invalid"
    );
  });

  it("names syncMode when the mode is not one this cloud recognises", () => {
    expect(reasonFor(validPayload({ syncMode: "sideways" }))).toBe(
      "sync_mode_invalid"
    );
  });

  it("falls back to the generic reason for componentCount, which summarizeParseIssues has no arm for", () => {
    // The session lane maps its `sessionCount` root to a dedicated reason; the
    // components lane's equivalent field has no arm, so it lands on the generic
    // fallback. Pinned so a later arm is a deliberate change, not a surprise.
    expect(reasonFor(validPayload({ componentCount: -1 }))).toBe(
      "payload_invalid"
    );
  });

  it("falls back to the generic reason for a malformed components array", () => {
    expect(
      reasonFor(validPayload({ components: [{ componentKind: "agent" }] }))
    ).toBe("payload_invalid");
  });

  it("does NOT reject a sanitized-key collision in a field the schema strips", () => {
    // The FEA-2691 constraint, pinned on this lane because it BOUNDS the fix for
    // the gap recorded in the entry point's docstring. A `components[].metadata`
    // collision does lose a persisted field and should be rejected once a human
    // rules on that contract change — but the assertion that closes it must be
    // scoped to `metadata`, never run over the whole raw payload. Collisions in
    // desktop-local / forward-compat keys like this one reach no column, and a
    // batch must not 400 forever over a field the schema drops.
    const collided = parseDesktopAgentComponentsPayload(
      payloadWith(
        markerAwareComponent({
          [`desktopLocal${NUL_CHAR}`]: "second",
          desktopLocal: "first",
        })
      )
    );

    expect(collided.ok).toBe(true);
  });
});
