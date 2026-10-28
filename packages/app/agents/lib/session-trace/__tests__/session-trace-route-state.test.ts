import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import { describe, expect, it } from "vitest";
import {
  emptySessionTraceRouteState,
  readSessionTraceRouteState,
  writeSessionTraceRouteState,
} from "../session-trace-route-state";

describe("readSessionTraceRouteState", () => {
  it("restores a span, a window, a kind filter and the lens", () => {
    const state = readSessionTraceRouteState(
      "?span=n14&from=1000&to=5000&kinds=skill,subagent&critical=1"
    );

    expect(state.spanId).toBe("n14");
    expect(state.windowFromMs).toBe(1000);
    expect(state.windowToMs).toBe(5000);
    expect(state.kinds).toStrictEqual([
      AgentComponentInvocationKind.Skill,
      AgentComponentInvocationKind.Subagent,
    ]);
    expect(state.criticalPathOnly).toBe(true);
  });

  it("drops half a window rather than repairing it into a whole one", () => {
    expect(readSessionTraceRouteState("?from=1000").windowFromMs).toBeNull();
    expect(readSessionTraceRouteState("?to=5000").windowToMs).toBeNull();
  });

  it("drops an inverted or negative window", () => {
    expect(
      readSessionTraceRouteState("?from=5000&to=1000").windowFromMs
    ).toBeNull();
    expect(
      readSessionTraceRouteState("?from=-5&to=10").windowFromMs
    ).toBeNull();
  });

  it("restores a focus, and carries no parameter the surface cannot render", () => {
    const state = readSessionTraceRouteState(
      "?focus=n2&component=skill%3Acode-review%3Astart"
    );
    expect(state.focusId).toBe("n2");
    // `?component=` is NOT route state here. The prototype's component
    // drill-in has no entry point in this surface, so advertising the
    // parameter would hand out links that render the ordinary tree.
    expect(Object.hasOwn(state, "componentRef")).toBe(false);
  });

  it("ignores unknown kinds and falls back when none survive", () => {
    expect(
      readSessionTraceRouteState("?kinds=skill,bogus").kinds
    ).toStrictEqual([AgentComponentInvocationKind.Skill]);
    expect(readSessionTraceRouteState("?kinds=bogus").kinds).toBeNull();
  });
});

describe("writeSessionTraceRouteState", () => {
  it("omits every default so a clean view has a clean URL", () => {
    expect(writeSessionTraceRouteState(emptySessionTraceRouteState(), "")).toBe(
      ""
    );
  });

  it("omits the kind filter when every kind is in scope", () => {
    const query = writeSessionTraceRouteState(
      {
        ...emptySessionTraceRouteState(),
        kinds: [
          AgentComponentInvocationKind.Command,
          AgentComponentInvocationKind.Skill,
          AgentComponentInvocationKind.Subagent,
          AgentComponentInvocationKind.Orchestration,
          AgentComponentInvocationKind.Tool,
          AgentComponentInvocationKind.Mcp,
          AgentComponentInvocationKind.Hook,
        ],
      },
      ""
    );

    expect(query).toBe("");
  });

  it("round-trips a populated state", () => {
    const state = {
      spanId: "n9",
      windowFromMs: 250,
      windowToMs: 900,
      kinds: [AgentComponentInvocationKind.Tool],
      criticalPathOnly: true,
      focusId: "n4",
      errorsOnly: true,
    };

    expect(
      readSessionTraceRouteState(writeSessionTraceRouteState(state, ""))
    ).toStrictEqual(state);
  });

  it("preserves unrelated params already on the URL", () => {
    const query = writeSessionTraceRouteState(
      emptySessionTraceRouteState(),
      "?tab=trace"
    );
    expect(query).toBe("?tab=trace");
  });
});

describe("a pasted trace URL, opened cold", () => {
  /**
   * ISS-10737: the acceptance test is a PASTE into a browser with no mounted
   * app, not a client-side navigation within one — a navigation carries the
   * previous render's React state and hides exactly this bug. So the only input
   * here is the query string, and every view parameter has to come back out of
   * it, with `?tab=` (owned by `useTabParam`) surviving the round trip
   * untouched.
   */
  const PASTED =
    "?tab=trace&span=n42&focus=n7&from=2500&to=90000&kinds=subagent,tool&critical=1&errors=1";

  it("restores every view parameter from the URL alone", () => {
    const state = readSessionTraceRouteState(PASTED);

    expect(state.spanId).toBe("n42");
    expect(state.focusId).toBe("n7");
    expect(state.windowFromMs).toBe(2500);
    expect(state.windowToMs).toBe(90_000);
    expect(state.kinds).toStrictEqual(["subagent", "tool"]);
    expect(state.criticalPathOnly).toBe(true);
    expect(state.errorsOnly).toBe(true);
  });

  it("keeps the tab the URL named when the view state is written back", () => {
    const written = writeSessionTraceRouteState(
      readSessionTraceRouteState(PASTED),
      PASTED
    );

    expect(new URLSearchParams(written).get("tab")).toBe("trace");
    expect(readSessionTraceRouteState(written)).toStrictEqual(
      readSessionTraceRouteState(PASTED)
    );
  });
});
