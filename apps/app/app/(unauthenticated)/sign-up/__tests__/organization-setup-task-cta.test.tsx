// @vitest-environment jsdom

/**
 * ISS-10969: after sign-up, Clerk's `<SignUp>` embed continues into its
 * choose-organization session task, whose create screen ("Setup your
 * organization") is the approved prototype's organization-create step rendered
 * by Clerk. Its submit read "Continue" in a pale secondary fill, where the
 * prototype has a blue primary "Create organization" — both Clerk defaults our
 * own embed inherited rather than chose.
 *
 * Clerk's task cannot mount without a live Clerk instance, so — following
 * `organization-setup-task-sign-out.test.tsx` (ISS-10970), which guards the same
 * screen — this renders the DOM contract it emits and compiles the SHIPPED
 * appearance rule through the same Emotion build Clerk applies it with. The
 * cascade, not a copy of the selector, decides what is painted.
 *
 * The copy half is asserted against the SHIPPED localization object, and against
 * the DEFAULT it replaces read out of `@clerk/localizations` — so a Clerk
 * upgrade that renames the key, or that already says the right thing, is visible
 * here rather than silently leaving an override that reaches nothing.
 */

import { createRequire } from "node:module";
import { githubFirstAuthPageAppearance } from "@repo/auth/components/appearance";
import { authLocalization } from "@repo/auth/components/localization";
import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";

type EmotionClassNames = ComponentType<{
  children: (api: { css: (...styles: unknown[]) => string }) => ReactNode;
}>;

const clerkUiRequire = createRequire(
  createRequire(import.meta.url).resolve("@clerk/ui/package.json")
);
const { ClassNames } = clerkUiRequire("@emotion/react") as {
  ClassNames: EmotionClassNames;
};

/**
 * Clerk's own English resource — the defaults these overrides replace.
 *
 * Reached through `@clerk/ui`'s require chain, like `@emotion/react` above and
 * for the same reason: `@clerk/localizations` is not a dependency of this app,
 * and a bare specifier resolves here only through hoisting. Vitest's resolver
 * finds it that way and Node's does not, which is a green test resting on a
 * layout nothing declares.
 */
const clerkDefaults = clerkUiRequire("@clerk/localizations") as Record<
  string,
  unknown
>;

const ORGANIZATION_TASK_ROOT = "cl-taskChooseOrganization-root";
const SIGN_UP_CARD_ROOT = "cl-signUp-root";
const SUBMIT = "submit";

// Written out rather than read off `submitRule`: an expectation derived from the
// object under test agrees with that object's mistakes. No TS constant owns
// these — `appearance.ts` names the design-system custom properties directly.
const PRIMARY_FILL = "var(--primary)";
const PRIMARY_TEXT = "var(--primary-foreground)";
const SECONDARY_FILL = "var(--secondary)";
const SECONDARY_TEXT = "var(--secondary-foreground)";

const shippedElements: Record<string, unknown> =
  githubFirstAuthPageAppearance.elements ?? {};
const submitRule = shippedElements.formButtonPrimary;

function SubmitButton({ rootClassName }: { rootClassName: string }) {
  return (
    <ClassNames>
      {({ css }) => (
        <div className={rootClassName}>
          <form className="cl-form">
            <button
              className={`cl-formButtonPrimary ${css(submitRule)}`}
              data-testid={SUBMIT}
              type="submit"
            />
          </form>
        </div>
      )}
    </ClassNames>
  );
}

/**
 * Both halves of the treatment, because the rule flips both: a button that takes
 * the primary fill while keeping secondary-foreground text is a contrast defect,
 * and pinning the fill alone leaves that version green.
 */
function renderedTreatment(): { background: string; color: string } {
  const style = getComputedStyle(screen.getByTestId(SUBMIT));

  return { background: style.background, color: style.color };
}

afterEach(() => {
  cleanup();
});

describe("organization-setup task — submit treatment (ISS-10969)", () => {
  it("paints the task's create submit as the page's primary action", () => {
    render(<SubmitButton rootClassName={ORGANIZATION_TASK_ROOT} />);

    const treatment = renderedTreatment();

    expect(treatment.background).toContain(PRIMARY_FILL);
    expect(treatment.color).toContain(PRIMARY_TEXT);
  });

  // The counterfactual, and the reason the rule is ancestor-scoped rather than
  // simply changed: the sign-up card's own email submit must STAY demoted, so
  // it never competes with the GitHub button beside it (FEA-4059).
  it("leaves the sign-up card's own submit demoted to secondary", () => {
    render(<SubmitButton rootClassName={SIGN_UP_CARD_ROOT} />);

    const treatment = renderedTreatment();

    expect(treatment.background).toContain(SECONDARY_FILL);
    expect(treatment.color).toContain(SECONDARY_TEXT);
  });
});

describe("organization-setup task — copy (ISS-10969)", () => {
  it("names the action the screen performs instead of Clerk's generic Continue", () => {
    expect(
      authLocalization.taskChooseOrganization?.createOrganization
        ?.formButtonSubmit
    ).toBe("Create organization");
  });

  // The override exists only because Clerk's default is wrong for this screen.
  // Read from Clerk's own resource rather than restated here, so an upgrade that
  // fixes the default reddens this instead of leaving a dead override — and so
  // the key itself is proven to be the one Clerk actually ships.
  it("is replacing a Clerk default that differs", () => {
    const enUS = clerkDefaults.enUS as {
      taskChooseOrganization?: {
        createOrganization?: { formButtonSubmit?: string };
      };
    };

    expect(
      enUS.taskChooseOrganization?.createOrganization?.formButtonSubmit
    ).toBe("Continue");
  });
});
