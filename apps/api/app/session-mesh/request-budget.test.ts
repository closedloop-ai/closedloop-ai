import { describe, expect, it } from "vitest";
import { MeshRequestBudget } from "./request-budget";

describe("Session Mesh request budgets", () => {
  it("bounds publishes by principal without starving heartbeat or inbox recovery", () => {
    const budget = new MeshRequestBudget();
    const publish = new Request("http://localhost/session-mesh/messages", {
      method: "POST",
    });
    for (let i = 0; i < 120; i += 1) {
      expect(budget.check(publish, "org-a", "user-a")).toBeNull();
    }
    const refused = budget.check(publish, "org-a", "user-a");
    expect(refused?.status).toBe(429);
    expect(refused?.headers.get("Retry-After")).toBe("60");
    expect(budget.check(publish, "org-a", "user-b")).toBeNull();
    expect(budget.check(publish, "org-b", "user-a")).toBeNull();
    expect(
      budget.check(
        new Request("http://localhost/session-mesh/inbox"),
        "org-a",
        "user-a"
      )
    ).toBeNull();
    expect(
      budget.check(
        new Request("http://localhost/session-mesh/presence", {
          method: "POST",
        }),
        "org-a",
        "user-a"
      )
    ).toBeNull();
  });
});
