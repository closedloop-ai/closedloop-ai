/**
 * Behavior tests for the Onboarding Surface's own story module
 * (`stories/surfaces/onboarding.stories.tsx`): the guided dialog host's
 * back-history and the project fixture route's defaults. The stories with a
 * `play` only walk the wizard's team step; nothing presses Back on the guided
 * dialog or submits a project without a description.
 */
import { composeStory } from "@storybook/react";
import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "storybook/test";
import { describe, expect, it, vi } from "vitest";
import onboardingMeta, {
  ProjectStep as projectStepStory,
  GuidedOnboardingSyncChoice as syncChoiceStory,
} from "../stories/surfaces/onboarding.stories";

const CASE_TIMEOUT_MS = 30_000;
const BACK = "Back";
const CONTINUE = "Continue";

describe("Guided onboarding dialog host", () => {
  it(
    "ignores Back with no history, then steps forward and back through the phases it visited",
    async () => {
      await composeStory(syncChoiceStory, onboardingMeta).run();
      const dialog = await screen.findByRole("dialog");
      const syncContinue = () => screen.getByRole("button", { name: CONTINUE });
      expect(syncContinue()).toBeVisible();

      await userEvent.click(screen.getByRole("button", { name: BACK }));
      expect(dialog).toBeVisible();
      expect(syncContinue()).toBeVisible();

      await userEvent.click(syncContinue());
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: CONTINUE })).toBeNull()
      );

      await userEvent.click(screen.getByRole("button", { name: BACK }));
      expect(
        await screen.findByRole("button", { name: CONTINUE })
      ).toBeVisible();
    },
    CASE_TIMEOUT_MS
  );
});

describe("Create project step", () => {
  it(
    "creates a project from its name alone, with the fixture route supplying the description",
    async () => {
      const params = projectStepStory.parameters?.appCore as {
        apiRoutes: { respond: (context: unknown) => unknown }[];
      };
      const route = params.apiRoutes[0];
      if (!route) {
        throw new Error("ProjectStep registers no create route");
      }
      const respond = vi.fn(route.respond);
      await composeStory(
        {
          ...projectStepStory,
          parameters: {
            ...projectStepStory.parameters,
            appCore: { apiRoutes: [{ ...route, respond }] },
          },
        },
        onboardingMeta
      ).run();

      await userEvent.type(
        screen.getByLabelText("Project name"),
        "Token Rollout"
      );
      await userEvent.click(
        screen.getByRole("button", { name: "Create Project" })
      );

      await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
      const context = respond.mock.calls[0]?.[0] as {
        body: Record<string, unknown>;
      };
      expect(context.body.name).toBe("Token Rollout");
      expect("description" in context.body).toBe(false);
      const project = respond.mock.results[0]?.value as {
        name: string;
        description: string;
      };
      expect(project.name).toBe("Token Rollout");
      expect(project.description.length).toBeGreaterThan(0);
    },
    CASE_TIMEOUT_MS
  );
});
