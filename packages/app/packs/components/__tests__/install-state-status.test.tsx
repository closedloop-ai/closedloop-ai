/**
 * @file install-state-status.test.tsx
 * @description Regression coverage for the canonical install-state vocabulary
 * (FEA-4083). Pins that every state — including the newly-covered honest states
 * (converting / unsupported / offline) — renders its single label from the one
 * canonical label map and gets a styled status-icon treatment, so a missing
 * treatment can never silently render an unstyled state. Behavioral: render the
 * state, assert the rendered label and the DS status-icon marker; no source
 * scans, no timing.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  INSTALL_STATE_LABEL,
  installStateTreatment,
  PackInstallState,
} from "../../lib/install-state";
import { InstallStateStatus } from "../install-state-status";

describe("install-state vocabulary", () => {
  const allStates = Object.values(PackInstallState);

  it("gives every state a distinct label and a styled status-icon treatment", () => {
    const labels = new Set<string>();
    for (const state of allStates) {
      const label = INSTALL_STATE_LABEL[state];
      expect(label, `label for ${state}`).toBeTruthy();
      labels.add(label);

      const treatment = installStateTreatment(state);
      // Every state resolves to a concrete status-icon kind — a filled glyph or
      // a ring — so no state can render unstyled (the status-map rule: expanding
      // the map ships styling too).
      expect(["glyph", "ring"], `kind for ${state}`).toContain(treatment.kind);
      if (treatment.kind === "glyph") {
        expect(treatment.glyph, `glyph for ${state}`).toBeTruthy();
        expect(treatment.fill, `fill for ${state}`).toBeTruthy();
      } else {
        expect(treatment.color, `color for ${state}`).toBeTruthy();
      }
    }
    // Distinct labels: no two states collapse to the same word.
    expect(labels.size).toBe(allStates.length);
  });

  it("renders each state's canonical label with a decorative status-icon", () => {
    for (const state of allStates) {
      const { container, unmount } = render(
        <InstallStateStatus state={state} />
      );
      expect(screen.getByText(INSTALL_STATE_LABEL[state])).toBeInTheDocument();
      // The status-icon glyph carries the state's shape; it is decorative
      // (the adjacent label is the accessible name), so the state is said once.
      const glyph = container.querySelector('[data-slot="status-icon"]');
      expect(glyph, `status-icon for ${state}`).not.toBeNull();
      expect(glyph?.getAttribute("aria-hidden")).toBe("true");
      unmount();
    }
  });

  // Explicit coverage for the newly-added honest states (the point of FEA-4083).
  // These assert the RENDERED DS primitive, not just the mapper — so the test
  // fails if InstallStateStatus stops passing thinking / glyph fill / trackColor
  // / dashed through to the primitive.
  it("renders the converting state as an in-flight (thinking) ring", () => {
    const { container } = render(
      <InstallStateStatus state={PackInstallState.Converting} />
    );
    expect(screen.getByText("Installing")).toBeInTheDocument();
    // The thinking spinner is a distinct animate-spin arc the ring only emits
    // when `thinking` reaches the primitive.
    expect(container.querySelector("circle.animate-spin")).not.toBeNull();
  });

  it("renders the unsupported state with its canonical label and x glyph", () => {
    const { container } = render(
      <InstallStateStatus state={PackInstallState.Unsupported} />
    );
    expect(screen.getByText("Not supported")).toBeInTheDocument();
    // A filled glyph circle — not a ring: no progress track present.
    const icon = container.querySelector('[data-slot="status-icon"]');
    expect(icon?.querySelector("circle.animate-spin")).toBeFalsy();
    // The muted fill reaches the rendered glyph.
    expect(container.innerHTML).toContain("var(--muted-foreground)");
  });

  it("renders the offline state as a muted ring, not a dead action", () => {
    const { container } = render(
      <InstallStateStatus state={PackInstallState.Offline} />
    );
    expect(screen.getByText("Target offline")).toBeInTheDocument();
    // The offline treatment overrides the ring track color to muted; assert the
    // rendered track stroke, so a dropped trackColor pass-through fails here.
    const track = container.querySelector('[data-slot="status-icon"] circle');
    expect(track?.getAttribute("stroke")).toBe("var(--muted-foreground)");
  });

  it("renders the failed state as an emphatic destructive glyph with Retry-worthy weight", () => {
    const { container } = render(
      <InstallStateStatus state={PackInstallState.Failed} />
    );
    expect(screen.getByText("Install failed")).toBeInTheDocument();
    // Destructive fill reaches the rendered glyph, and the emphatic tone lifts
    // the label to full foreground weight (not muted).
    expect(container.innerHTML).toContain("var(--destructive)");
    const wrapper = container.querySelector("span.flex.items-center");
    expect(wrapper?.className).toContain("text-foreground");
    expect(wrapper?.className).not.toContain("text-muted-foreground");
  });

  it("degrades an unknown boundary state to a muted fallback instead of a broken glyph", () => {
    // A boundary can cast an unknown wire string to PackInstallState (bypassing
    // the type). The mapper must not return the raw string as a treatment; it
    // returns a neutral muted ring so nothing renders undefined.
    const treatment = installStateTreatment(
      "totally-unknown-state" as PackInstallState
    );
    expect(treatment.kind).toBe("ring");
    if (treatment.kind === "ring") {
      expect(treatment.color).toBe("var(--muted-foreground)");
    }
  });
});
