// @vitest-environment jsdom

/**
 * ISS-10970: after sign-up, Clerk's `<SignUp>` embed continues into its
 * choose-organization session task, whose create screen ("Setup your
 * organization") renders a "Signed in as … / Sign out" row the approved design
 * does not have. The embed's appearance hides that row there and nowhere else.
 *
 * Clerk's task cannot mount without a live Clerk instance, so this renders the
 * DOM contract it emits — the task's flow-root class, its create screen's form,
 * and the sign-out row's element classes (verified against `@clerk/ui` 1.6.x) —
 * and compiles the SHIPPED appearance rule through the same Emotion build Clerk
 * applies it with, resolved through `@clerk/ui`'s own dependency. The cascade,
 * not a copy of the selector, decides what is visible.
 */

import { createRequire } from "node:module";
import { githubFirstAuthPageAppearance } from "@repo/auth/components/appearance";
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

const ORGANIZATION_TASK_ROOT = "cl-taskChooseOrganization-root";
const RESET_PASSWORD_TASK_ROOT = "cl-taskResetPassword-root";
const SIGN_OUT_ROW = "sign-out-row";
const CREATE_SUBMIT = "create-submit";

const shippedElements: Record<string, unknown> =
  githubFirstAuthPageAppearance.elements ?? {};
const signOutRule = shippedElements.footerAction__signOut;

function TaskCard({
  createScreen,
  rootClassName,
}: {
  createScreen: boolean;
  rootClassName: string;
}) {
  return (
    <ClassNames>
      {({ css }) => (
        <div className={rootClassName}>
          {createScreen ? (
            <form className="cl-form">
              <button
                className="cl-formButtonPrimary"
                data-testid={CREATE_SUBMIT}
                type="submit"
              />
            </form>
          ) : null}
          <div className="cl-footer">
            <div
              className={`cl-footerAction cl-footerAction__signOut ${css(signOutRule)}`}
              data-testid={SIGN_OUT_ROW}
            />
          </div>
        </div>
      )}
    </ClassNames>
  );
}

function renderedDisplay(): string {
  return getComputedStyle(screen.getByTestId(SIGN_OUT_ROW)).display;
}

afterEach(() => {
  cleanup();
});

describe("organization-setup task — Signed in as / Sign out row (ISS-10970)", () => {
  it("hides the row on the task's organization-creation screen", () => {
    render(<TaskCard createScreen rootClassName={ORGANIZATION_TASK_ROOT} />);

    expect(screen.getByTestId(SIGN_OUT_ROW)).toBeInTheDocument();
    expect(renderedDisplay()).toBe("none");
    // The screen's own action stays: the rule reaches the account row only.
    expect(
      getComputedStyle(screen.getByTestId(CREATE_SUBMIT)).display
    ).not.toBe("none");
  });

  it("keeps the row on the same task's choose screen, which has no form", () => {
    render(
      <TaskCard createScreen={false} rootClassName={ORGANIZATION_TASK_ROOT} />
    );

    expect(renderedDisplay()).not.toBe("none");
  });

  it("keeps the row on another session task that shares the element key", () => {
    render(<TaskCard createScreen rootClassName={RESET_PASSWORD_TASK_ROOT} />);

    expect(renderedDisplay()).not.toBe("none");
  });
});
