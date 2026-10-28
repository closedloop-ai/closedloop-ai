import { describe, expect, it } from "vitest";
import {
  SESSION_DESIGN_DETAILS_INPUT,
  SESSION_DESIGN_SESSION,
} from "../session-detail-design-fixtures";

describe("ISS-12252 Session The Details tab page input", () => {
  it("counts subagents without the main agent (agentCount includes it)", () => {
    const agents = SESSION_DESIGN_SESSION.agentCount ?? 0;
    expect(agents).toBeGreaterThan(0);
    expect(SESSION_DESIGN_DETAILS_INPUT.subagents).toBe(agents - 1);
  });
});
