// @vitest-environment jsdom

import { avatarImageMockModule } from "@repo/app/test/mocks/avatar-image";
import {
  Dialog,
  DialogContent,
} from "@repo/design-system/components/ui/dialog";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { GuidedOnboardingCreateOrganizationStep } from "../guided-onboarding-create-organization-step";

vi.mock("@repo/design-system/components/ui/avatar", (importOriginal) =>
  avatarImageMockModule(importOriginal)
);

type StepProps = ComponentProps<typeof GuidedOnboardingCreateOrganizationStep>;

/**
 * Mounts the phase on its own, with only the Radix context its `DialogTitle`
 * needs. The wizard shell is deliberately absent: what this file covers is the
 * step's own form behaviour, and the cross-phase dialog suite covers the rest.
 */
function renderStep(overrides: Partial<StepProps> = {}) {
  render(
    <Dialog open>
      <DialogContent showCloseButton={false}>
        <GuidedOnboardingCreateOrganizationStep
          brand={<span>Closedloop.ai</span>}
          defaultName=""
          defaultSlug=""
          onCreate={vi.fn()}
          {...overrides}
        />
      </DialogContent>
    </Dialog>
  );

  return {
    nameField: screen.getByLabelText("Name"),
    slugField: screen.getByLabelText("Slug"),
    submit: screen.getByRole("button", { name: "Create organization" }),
  };
}

describe("GuidedOnboardingCreateOrganizationStep", () => {
  it("previews the selected logo before organization creation and replaces or clears it with the staged file", async () => {
    const onCreate = vi.fn();
    renderStep({
      allowStagedOrganizationLogo: true,
      defaultName: "Acme",
      onCreate,
    });
    const file = new File(["first logo"], "first.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Organization logo file"), {
      target: { files: [file] },
    });
    const image = await screen.findByRole("img", { name: "Organization logo" });
    const firstPreview = image.getAttribute("src");
    expect(firstPreview).toBe("data:image/png;base64,Zmlyc3QgbG9nbw==");
    expect(onCreate).not.toHaveBeenCalled();
    const replacement = new File(["second logo"], "second.png", {
      type: "image/png",
    });
    fireEvent.change(screen.getByLabelText("Organization logo file"), {
      target: { files: [replacement] },
    });
    await waitFor(() =>
      expect(
        screen.getByRole("img", { name: "Organization logo" })
      ).toHaveAttribute("src", "data:image/png;base64,c2Vjb25kIGxvZ28=")
    );
    fireEvent.change(screen.getByLabelText("Organization logo file"), {
      target: {
        files: [new File(["invalid"], "invalid.txt", { type: "text/plain" })],
      },
    });
    expect(screen.queryByRole("img", { name: "Organization logo" })).toBeNull();
  });

  it("derives the slug from the name until the visitor edits the slug", async () => {
    const user = userEvent.setup();
    const { nameField, slugField } = renderStep();

    await user.type(nameField, "Acme Co.");
    expect(slugField).toHaveValue("acme-co");

    await user.clear(slugField);
    await user.type(slugField, "acmeteam");
    await user.type(nameField, " Holdings");

    expect(nameField).toHaveValue("Acme Co. Holdings");
    expect(slugField).toHaveValue("acmeteam");
  });

  it("refuses to submit an organization missing a name or a slug", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const { nameField, slugField, submit } = renderStep({ onCreate });

    expect(submit).toBeDisabled();

    await user.type(nameField, "Acme");
    expect(submit).toBeEnabled();

    await user.clear(slugField);
    expect(submit).toBeDisabled();

    await user.type(slugField, "acme");
    await user.click(submit);
    expect(onCreate).toHaveBeenCalledWith({ name: "Acme", slug: "acme" });
  });
});
