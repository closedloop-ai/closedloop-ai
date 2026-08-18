import { describe, expect, it } from "vitest";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { buildActivityMarkers } from "../agent-session-detail-view";

/**
 * FEA-2192: which turn kinds earn a Session Timeline dot, and which do not.
 *
 * Split out of `agent-session-detail-view.test.tsx` (grandfathered shrink-only
 * under the root AGENTS.md line-count contract) as part of the ISS-4821 review
 * pass, which changed `buildActivityMarkers`' signature. The persisted-marker
 * POSITIONING contract lives in the sibling
 * `session-timeline-persisted-geometry.test.ts`; this file owns the KINDS.
 */

describe("buildActivityMarkers timeline dot kinds (FEA-2192)", () => {
  it("does not tag successful tool or subagent turns as human steering", () => {
    const base = createAgentSessionDetailFixture();
    // Force the turnItems fallback (server markers absent) and flip the failing
    // tool/subagent turns to successful completions.
    const session = {
      ...base,
      markers: [],
      turnItems: (base.turnItems ?? []).map((item) => {
        if (item.type === "tools") {
          return {
            ...item,
            hasFail: false,
            failN: 0,
            items: item.items.map((tool) => ({ ...tool, err: false })),
          };
        }
        if (item.type === "subagent") {
          return { ...item, status: "completed" };
        }
        return item;
      }),
    };

    const markers = buildActivityMarkers(session, null);

    // The genuine human prompt (row 0) is the only "Human steering" marker.
    expect(markers.filter((m) => m.kind === "prompt").map((m) => m.tl)).toEqual(
      [0]
    );
    // Successful tool (row 3) and subagent (row 5) turns produce no marker — same
    // as the server-side buildTraceMarkers path.
    expect(markers.some((m) => m.tl === 3)).toBe(false);
    expect(markers.some((m) => m.tl === 5)).toBe(false);
  });

  it("still surfaces failed tool and subagent turns as failures", () => {
    const markers = buildActivityMarkers(
      createAgentSessionDetailFixture(),
      null
    );

    expect(markers.find((m) => m.tl === 3)?.kind).toBe("fail");
    expect(markers.find((m) => m.tl === 5)?.kind).toBe("fail");
    // Failures are never mislabeled as human steering.
    expect(markers.filter((m) => m.kind === "prompt").map((m) => m.tl)).toEqual(
      [0]
    );
  });

  it('marks a subagent turn with cloud status "error" as a failure', () => {
    const base = createAgentSessionDetailFixture();
    const session = {
      ...base,
      markers: [],
      turnItems: (base.turnItems ?? []).map((item) =>
        item.type === "subagent" ? { ...item, status: "error" } : item
      ),
    };

    const markers = buildActivityMarkers(session, null);

    // "error" is the canonical cloud-source failure status; the subagent (row 5)
    // must still surface a failure marker, not be silently dropped.
    expect(markers.find((m) => m.tl === 5)?.kind).toBe("fail");
  });

  it("coerces a server marker's Date-valued `t` to a formatted string (no [object Date] render)", () => {
    const base = createAgentSessionDetailFixture();
    // `SessionMarker.t` is TYPED `string`, but a synced detail can deserialize the
    // timestamp column into a runtime `Date`. Reproduce that type-vs-runtime
    // mismatch: previously `buildActivityMarkers` copied the Date verbatim, and
    // the timeline tooltip rendered `<span>{event.t}</span>` — throwing "Objects
    // are not valid as a React child (found: [object Date])" and crashing the
    // whole detail subtree (transcript panel included) under the error boundary.
    const session = {
      ...base,
      markers: [
        {
          kind: "commit" as const,
          label: "seed the fixture",
          // Cast models the runtime shape the contract claims is a string.
          t: new Date("2026-06-10T12:34:56.000Z") as unknown as string,
          tl: 2,
          x: 40,
        },
      ],
    };

    const markers = buildActivityMarkers(session, null);

    expect(markers).toHaveLength(1);
    // Not a Date — a formatted string safe to render as a React child.
    expect(markers[0].t).toBeTypeOf("string");
    expect(markers[0].t).not.toBe("[object Date]");
    expect(markers[0].t.length).toBeGreaterThan(0);
  });
});
