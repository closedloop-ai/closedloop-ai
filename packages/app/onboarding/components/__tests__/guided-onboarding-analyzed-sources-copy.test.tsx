import { Dialog } from "@repo/design-system/components/ui/dialog";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GuidedOnboardingWelcomeStep } from "../guided-onboarding-welcome-step";

/**
 * ISS-11346: the Welcome step's "What we do" line reads the one canonical
 * source list. Spelled as a literal so a return to hand-kept names fails here;
 * the Privacy line and the registry half are pinned by the desktop
 * `welcome-consent-sources.test.tsx`.
 */
const WHAT_WE_DO =
  "Closedloop analyzes your Claude Code, Codex, Cursor, Copilot, and OpenCode sessions to show how agents are helping you build.";

describe("onboarding copy naming the analyzed sources", () => {
  it("names every analyzed source in the Welcome step's What we do line", () => {
    render(
      <Dialog open>
        <GuidedOnboardingWelcomeStep
          brand={<span>Closedloop</span>}
          desktopMode={false}
          onStart={() => undefined}
          privacyHref="https://example.test/privacy"
        />
      </Dialog>
    );

    expect(
      screen.getByText("What we do:").parentElement?.textContent
    ).toContain(WHAT_WE_DO);
  });
});
