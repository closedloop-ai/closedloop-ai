import { TableCustomFieldType } from "@repo/design-system/components/ui/table-add-field-dialog-content";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ArtifactKind, ArtifactStatus } from "../../fixtures";
import {
  type ArtifactCreationConfig,
  defaultArtifactCreationConfig,
} from "../artifact-creation";
import {
  CreationHarness,
  closeTopPopover,
  createSpy,
  lastCreateCall,
  pickOption,
} from "./support/creation-dialog-harness";
import { FIND_TIMEOUT, FLOW_TIMEOUT_MS } from "./support/flow-timeouts";

const EXPAND_LABEL = "Expand creator";

const issueConfig: ArtifactCreationConfig = {
  description: "Create an issue.",
  includeRepository: true,
  kind: ArtifactKind.Issue,
  noun: "issue",
  slugPrefix: "ISS",
};

const fieldConfig: ArtifactCreationConfig = {
  ...issueConfig,
  fields: [
    {
      id: "type",
      label: "Type",
      options: ["Bug", "Task"],
      required: true,
      type: "select",
    },
    { id: "stage", label: "Stage", options: ["Alpha"], type: "select" },
    { id: "notes", label: "Notes", type: "textarea" },
    { id: "ref", label: "Ref", type: "text" },
    { id: "size", label: "Size", type: "multi-select" },
  ],
};

async function openPickerOptions(
  user: ReturnType<typeof userEvent.setup>,
  trigger: string
) {
  await user.click(screen.getByRole("button", { name: trigger }));
  const list = await screen.findByRole("listbox", {}, FIND_TIMEOUT);
  return within(list).getAllByRole("option");
}

describe("AddArtifactDialog reset defaults", {
  timeout: FLOW_TIMEOUT_MS,
}, () => {
  it("restores every default value after an Escape dismissal", async () => {
    const user = userEvent.setup();
    const onCreate = createSpy();
    render(<CreationHarness config={issueConfig} onCreate={onCreate} />);

    await user.click(screen.getByRole("button", { name: EXPAND_LABEL }));
    await user.click(screen.getByRole("switch"));
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Reopen creator" }));

    expect(screen.getByRole("button", { name: EXPAND_LABEL })).toBeVisible();
    expect(screen.getByRole("switch")).not.toBeChecked();
    await user.type(screen.getByRole("textbox", { name: "Issue title" }), "T");
    await user.click(screen.getByRole("button", { name: "Create issue" }));

    expect(lastCreateCall(onCreate)).toEqual([
      {
        attachments: [],
        collaborators: [],
        customValues: {},
        linkedArtifacts: [],
        owner: "Ottilie Eastwick",
        project: "Artifact foundations",
        repository: "closedloop-ai",
        status: ArtifactStatus.Backlog,
        summary: "",
        tags: [],
        title: "T",
      },
      { openAfterCreate: true },
    ]);
  });

  it("keeps Create disabled for a whitespace-only title", async () => {
    const user = userEvent.setup();
    render(<CreationHarness config={issueConfig} onCreate={createSpy()} />);

    await user.type(screen.getByRole("textbox", { name: "Issue title" }), "  ");

    expect(screen.getByRole("button", { name: "Create issue" })).toBeDisabled();
  });
});

describe("AddArtifactDialog copy and icons", {
  timeout: FLOW_TIMEOUT_MS,
}, () => {
  it("names the title and description placeholders after the noun", () => {
    render(<CreationHarness config={issueConfig} onCreate={createSpy()} />);

    expect(
      screen.getByRole("textbox", { name: "Issue title" })
    ).toHaveAttribute("placeholder", "Issue title");
    expect(
      screen.getByRole("textbox", { name: "Issue description" })
    ).toHaveAttribute("placeholder", "Add issue description…");
  });

  it.each([
    [defaultArtifactCreationConfig, "New artifact", "lucide-layers-2"],
    [issueConfig, "New issue", "lucide-square-check"],
  ])(
    "uses the kind icon unless the noun is artifact (%#)",
    (config, heading, icon) => {
      render(<CreationHarness config={config} onCreate={createSpy()} />);

      const header = screen.getByText(heading).parentElement;
      expect(header?.querySelector("svg")).toHaveClass(icon);
    }
  );

  it("labels empty collaborator and linked-artifact pickers", async () => {
    const user = userEvent.setup();
    render(<CreationHarness config={issueConfig} onCreate={createSpy()} />);

    expect(
      screen.getByRole("button", { name: "Add collaborators…" })
    ).toHaveTextContent("Collaborators");
    await user.click(
      screen.getByRole("button", { name: "More creation fields" })
    );
    expect(
      await screen.findByRole(
        "button",
        { name: "Link artifacts…" },
        FIND_TIMEOUT
      )
    ).toHaveTextContent("Linked artifacts");
  });
});

describe("AddArtifactDialog picker options", {
  timeout: FLOW_TIMEOUT_MS,
}, () => {
  it("numbers the project options in order", async () => {
    const user = userEvent.setup();
    render(<CreationHarness config={issueConfig} onCreate={createSpy()} />);

    const options = await openPickerOptions(user, "Set project…");

    expect(options.map((option) => option.textContent)).toEqual([
      "1Artifact foundations",
      "2Ottilie August Strategic Projects",
      "3Platform Engineering",
    ]);
  });

  it("numbers the tag options in order", async () => {
    const user = userEvent.setup();
    render(<CreationHarness config={issueConfig} onCreate={createSpy()} />);

    const options = await openPickerOptions(user, "Add tags…");

    expect(options.map((option) => option.textContent)).toEqual([
      "1Foundations",
      "2Product",
      "3Prototype",
      "4Research",
      "5UX",
    ]);
  });

  it("checks only the current owner in the owner picker", async () => {
    const user = userEvent.setup();
    render(<CreationHarness config={issueConfig} onCreate={createSpy()} />);

    const options = await openPickerOptions(user, "Assign owner…");

    expect(
      options
        .filter((option) => option.querySelector("svg"))
        .map((option) => option.textContent)
    ).toEqual(["1Ottilie Eastwick"]);
  });

  it("offers no options for a custom multi-select without options", async () => {
    const user = userEvent.setup();
    render(
      <CreationHarness
        config={issueConfig}
        customFields={[
          {
            id: "cf-areas",
            label: "Areas",
            type: TableCustomFieldType.MultiSelect,
          },
        ]}
        onCreate={createSpy()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Set areas…" }));

    expect(
      await screen.findByText("No options found.", {}, FIND_TIMEOUT)
    ).toBeVisible();
  });
});

describe("AddArtifactDialog field layout", { timeout: FLOW_TIMEOUT_MS }, () => {
  it("flags only an empty required chip as destructive", async () => {
    const user = userEvent.setup();
    render(<CreationHarness config={fieldConfig} onCreate={createSpy()} />);
    const required = screen.getByRole("button", { name: "Set type… Required" });
    const optional = screen.getByRole("button", { name: "Set stage…" });

    expect(required).toHaveClass("text-destructive");
    expect(optional).not.toHaveClass("text-destructive");
    await pickOption(user, "Set type… Required", "Bug");
    await closeTopPopover(user);

    expect(required).not.toHaveClass("text-destructive");
  });

  it("lists only non-select fields in the additional-fields popover", async () => {
    const user = userEvent.setup();
    render(<CreationHarness config={fieldConfig} onCreate={createSpy()} />);

    await user.click(
      screen.getByRole("button", { name: "More creation fields" })
    );
    const heading = await screen.findByText(
      "Additional fields",
      {},
      FIND_TIMEOUT
    );
    const popover = heading.parentElement?.parentElement;
    if (!popover) {
      throw new Error("missing additional-fields popover");
    }

    expect(
      Array.from(popover.querySelectorAll("label"), (label) =>
        label.textContent?.trim()
      )
    ).toEqual(["Repository", "Notes", "Ref"]);
    expect(screen.getByLabelText("Notes").tagName).toBe("TEXTAREA");
    expect(screen.getByLabelText("Ref").tagName).toBe("INPUT");
  });
});
