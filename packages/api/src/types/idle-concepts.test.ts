import { describe, expect, it } from "vitest";
import {
  IDLE_CONCEPTS,
  IdleConcept,
  idleConceptLabel,
  isSessionLevelIdleConcept,
} from "./idle-concepts.js";

describe("FEA-3572 idle-concepts canonical vocabulary", () => {
  it("names exactly the four distinct idle concepts", () => {
    expect(Object.values(IdleConcept).sort()).toEqual(
      ["activity_gap", "phantom_session", "stalled_run", "trace_gap"].sort()
    );
  });

  it("carries a descriptor (label + condition + rationale + ssot) for every concept", () => {
    for (const concept of Object.values(IdleConcept)) {
      const descriptor = IDLE_CONCEPTS[concept];
      expect(descriptor.concept).toBe(concept);
      expect(descriptor.label.length).toBeGreaterThan(0);
      expect(descriptor.condition.length).toBeGreaterThan(0);
      expect(descriptor.rationale.length).toBeGreaterThan(0);
      expect(descriptor.ssot.length).toBeGreaterThan(0);
    }
  });

  it("treats ONLY the phantom session (#1) as a session-level idle concept", () => {
    expect(isSessionLevelIdleConcept(IdleConcept.PhantomSession)).toBe(true);
    expect(IDLE_CONCEPTS[IdleConcept.PhantomSession].isSession).toBe(true);

    for (const concept of [
      IdleConcept.ActivityGap,
      IdleConcept.StalledRun,
      IdleConcept.TraceGap,
    ]) {
      expect(isSessionLevelIdleConcept(concept)).toBe(false);
      expect(IDLE_CONCEPTS[concept].isSession).toBe(false);
    }
  });

  it("resolves a concept's user-facing label from the canonical map", () => {
    expect(idleConceptLabel(IdleConcept.PhantomSession)).toBe("Idle session");
    // #2 keeps the FEA-2275 activity-taxonomy phase label to avoid drift.
    expect(idleConceptLabel(IdleConcept.ActivityGap)).toBe("Idle");
    // #3 matches the Active-runs stalled phase label.
    expect(idleConceptLabel(IdleConcept.StalledRun)).toBe("Stalled");
    expect(idleConceptLabel(IdleConcept.TraceGap)).toBe("Idle gap");
  });

  it("gives each concept a distinct label so the session badge is not confused with the timeline phase", () => {
    expect(idleConceptLabel(IdleConcept.PhantomSession)).not.toBe(
      idleConceptLabel(IdleConcept.ActivityGap)
    );
  });
});
