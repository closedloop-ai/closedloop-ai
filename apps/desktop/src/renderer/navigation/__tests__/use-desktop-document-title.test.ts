import { describe, expect, it } from "vitest";
import { DEFAULT_NAV_ID, NavId } from "../route-table";
import { resolveDesktopDocumentTitle } from "../use-desktop-document-title";

const NO_DETAIL = {
  detailBranchId: null,
  detailSessionId: null,
  detailTitle: null,
};

describe("ISS-5574: resolveDesktopDocumentTitle", () => {
  it("names the two list surfaces", () => {
    expect(
      resolveDesktopDocumentTitle({ ...NO_DETAIL, routeNavId: NavId.Sessions })
    ).toBe("Sessions");
    expect(
      resolveDesktopDocumentTitle({ ...NO_DETAIL, routeNavId: NavId.Branches })
    ).toBe("Branches");
  });

  it("names a detail after its record, not after its section", () => {
    // A detail route keeps its section's tab highlighted, so a nav-id-first
    // resolution would title every open session tab "Sessions" — the defect
    // itself.
    expect(
      resolveDesktopDocumentTitle({
        detailBranchId: null,
        detailSessionId: "ses-1",
        detailTitle: "symphony-alpha-iss-5273",
        routeNavId: null,
      })
    ).toBe("symphony-alpha-iss-5273");
    expect(
      resolveDesktopDocumentTitle({
        detailBranchId: "br-1",
        detailSessionId: null,
        detailTitle: "kaiticarp/preauth-onboarding-flow",
        routeNavId: null,
      })
    ).toBe("kaiticarp/preauth-onboarding-flow");
  });

  it("falls back to the honest kind while a record is unresolved", () => {
    // Loading, not found, or genuinely nameless all publish a null title. Naming
    // the KIND of page is true in every one of those states; a placeholder that
    // looks like a name would not be.
    expect(
      resolveDesktopDocumentTitle({
        detailBranchId: null,
        detailSessionId: "ses-1",
        detailTitle: null,
        routeNavId: null,
      })
    ).toBe("Session");
    expect(
      resolveDesktopDocumentTitle({
        detailBranchId: "br-1",
        detailSessionId: null,
        detailTitle: null,
        routeNavId: null,
      })
    ).toBe("Branch");
  });

  it("leaves every other surface's title alone", () => {
    // ISS-5574 is scoped to Sessions and Branches; nothing else may be retitled.
    for (const routeNavId of [
      NavId.Dashboard,
      NavId.Agents,
      NavId.Insights,
      NavId.Settings,
    ]) {
      expect(
        resolveDesktopDocumentTitle({ ...NO_DETAIL, routeNavId })
      ).toBeNull();
    }
  });

  // Review (closedloop-ai-stage on #4661): a non-nav route this change does not
  // own has no nav id of its own, and App.tsx's sticky `navId` would hand it
  // DEFAULT_NAV_ID on a relaunch or bookmark straight into it — titling an agent
  // detail window "Sessions" while its breadcrumb read "Agents / <name>".
  // Resolving the list arm off `routeNavId` (null for every kind but `nav`)
  // closes the whole class, not just the agent route.
  it("stays silent on a non-nav route that borrows the default nav id", () => {
    expect(DEFAULT_NAV_ID).toBe(NavId.Sessions);
    expect(
      resolveDesktopDocumentTitle({ ...NO_DETAIL, routeNavId: null })
    ).toBeNull();
  });
});
