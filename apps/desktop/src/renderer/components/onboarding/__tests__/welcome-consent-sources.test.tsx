import { tmpdir } from "node:os";
import path from "node:path";
import { Dialog } from "@closedloop-ai/design-system/components/ui/dialog";
import { GuidedOnboardingWelcomeStep } from "@repo/app/onboarding/components/guided-onboarding-welcome-step";
import { harnessDisplayLabel } from "@repo/app/onboarding/lib/harness-display-label";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { defaultCollectors } from "../../../../main/collectors/engine/default-collectors.js";

/**
 * ISS-11346. The Welcome step is where the reader agrees to analysis
 * (ISS-10950), and its privacy line says "Only your … sessions are analyzed".
 * The oracle here is the REAL collector registry the boot import runs, so a
 * collector added to it fails this case until the consent line names it.
 */
describe("the Desktop Welcome consent line", () => {
  it("names exactly the sources the boot collectors scan, in registry order", () => {
    const roster = defaultCollectors(
      // Never read: constructing the roster touches no state on disk.
      { stateDir: path.join(tmpdir(), "iss-11346-consent-roster") },
      () => undefined
    );
    const scanned = new Intl.ListFormat("en", {
      style: "long",
      type: "conjunction",
    }).format(roster.map((collector) => harnessDisplayLabel(collector.key)));

    render(
      <Dialog open>
        <GuidedOnboardingWelcomeStep
          brand={<span>Closedloop</span>}
          desktopMode
          onStart={() => undefined}
          privacyHref="https://example.test/privacy"
        />
      </Dialog>
    );

    const privacy = screen.getByText("Privacy:").parentElement?.textContent;
    expect(privacy).toContain(`Only your ${scanned} sessions are analyzed.`);
  });
});
