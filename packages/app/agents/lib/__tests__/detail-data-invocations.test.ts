/**
 * ISS-5363 — the Invocations and Sessions cards must distinguish a REAL zero
 * from "not computed".
 *
 * The reported defect showed `INVOCATIONS 0` / `SESSIONS 0` on a component the
 * listing table credited with real usage, while `MERGED PRS` and `AVG / SESSION`
 * on the SAME card row showed `—`. The unavailable state already existed and was
 * being applied inconsistently across one row.
 *
 * The API fix (`apps/api/app/agent-components/service/detail-read.ts`) makes the
 * counts reconcile with the listing and emits `null` for the one state where the
 * derivation never ran. This pins the render half of that contract — and it is
 * the CROSS-SURFACE half: `componentMetrics` is mounted by both the web shell
 * (`apps/app`) and the desktop renderer (`apps/desktop/src/renderer`), so a
 * regression here would put the same lie on both surfaces at once.
 */
import type { AgentComponentDetail } from "@repo/api/src/types/agent-component";
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { describe, expect, it } from "vitest";
import { componentMetrics } from "../detail-data";

const METRIC_DASH = "—";

function makeDetail(
  overrides: Partial<AgentComponentDetail>
): AgentComponentDetail {
  return {
    id: "id",
    // The reported component: a Skill sourced from `.claude/skills/create-feat`.
    slug: "skill::create-feat",
    name: "create-feat",
    kind: AgentComponentKind.Skill,
    invocations: 0,
    sessions: 0,
    locPerDollar: null,
    mergedPrs: null,
    branchesTab: [],
    ...overrides,
    // A partial cast is acceptable for a test fixture; componentMetrics only
    // reads the fields set above.
  } as AgentComponentDetail;
}

const cardValue = (
  detail: AgentComponentDetail,
  key: string
): string | undefined =>
  componentMetrics(detail).find((metric) => metric.key === key)?.value;

describe("componentMetrics Invocations/Sessions (ISS-5363)", () => {
  it("renders the counts the API computed", () => {
    const detail = makeDetail({ invocations: 12, sessions: 2 });

    expect(cardValue(detail, "invocations")).toBe("12");
    expect(cardValue(detail, "sessions")).toBe("2");
    // And the derived card reconciles with them rather than being independently
    // computed: 12 / 2 = 6.
    expect(cardValue(detail, "avg")).toBe("6");
  });

  it("shows the em-dash, not a confident 0, when the counts were not computed", () => {
    const detail = makeDetail({ invocations: null, sessions: null });

    expect(cardValue(detail, "invocations")).toBe(METRIC_DASH);
    expect(cardValue(detail, "sessions")).toBe(METRIC_DASH);
    // The whole row now agrees: no card claims a measurement nobody took.
    expect(cardValue(detail, "avg")).toBe(METRIC_DASH);
    expect(cardValue(detail, "merged")).toBe(METRIC_DASH);
  });

  it("still renders a genuine zero as 0", () => {
    // The failure branch must not swallow the true zero — a component that
    // really was never invoked reports `0`, not a dash. Without this the fix
    // would just move the lie to the other side.
    const detail = makeDetail({ invocations: 0, sessions: 0 });

    expect(cardValue(detail, "invocations")).toBe("0");
    expect(cardValue(detail, "sessions")).toBe("0");
    // Avg is still undefined at zero sessions — division, not a missing count.
    expect(cardValue(detail, "avg")).toBe(METRIC_DASH);
  });

  it("dashes a count a version-skewed producer omitted entirely", () => {
    // Wire data: an older producer may not send these fields at all, and
    // `Intl.NumberFormat.format(undefined)` renders the literal "NaN".
    const detail = makeDetail({});
    const skewed = { ...detail } as Record<string, unknown>;
    skewed.invocations = undefined;
    skewed.sessions = undefined;

    const metrics = componentMetrics(skewed as unknown as AgentComponentDetail);

    expect(metrics.find((m) => m.key === "invocations")?.value).toBe(
      METRIC_DASH
    );
    expect(metrics.find((m) => m.key === "sessions")?.value).toBe(METRIC_DASH);
  });
});
