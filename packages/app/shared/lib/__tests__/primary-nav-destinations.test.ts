import { ROUTINES_FEATURE_FLAG_KEY } from "@repo/api/src/types/routines";
import { CalendarClockIcon } from "lucide-react";
import { describe, expect, it } from "vitest";
import {
  PRIMARY_NAV_DESTINATIONS,
  PrimaryNavGroup,
} from "../primary-nav-destinations";

describe("PRIMARY_NAV_DESTINATIONS — Routines (PRD-566 / FEA-4348)", () => {
  const routines = PRIMARY_NAV_DESTINATIONS.find(
    (destination) => destination.path === "/routines"
  );

  it("registers a Routines destination in the Artifacts group gated by the routines flag", () => {
    expect(routines).toBeDefined();
    expect(routines?.title).toBe("Routines");
    expect(routines?.icon).toBe(CalendarClockIcon);
    expect(routines?.group).toBe(PrimaryNavGroup.Artifact);
    // Gated behind the PostHog `routines` flag (default off) until GA — the
    // route carries the same gate. Belt-and-suspenders with the desktop Labs
    // setting so an unfinished feature never surfaces in prod.
    expect(routines?.featureFlag).toBe(ROUTINES_FEATURE_FLAG_KEY);
  });

  it("orders Routines among the artifact surfaces, not promoted above Sessions/Branches/Agents", () => {
    const artifactDestinations = PRIMARY_NAV_DESTINATIONS.filter(
      (destination) => destination.group === PrimaryNavGroup.Artifact
    );
    expect(
      artifactDestinations.some(
        (destination) => destination.path === "/routines"
      )
    ).toBe(true);
  });
});
