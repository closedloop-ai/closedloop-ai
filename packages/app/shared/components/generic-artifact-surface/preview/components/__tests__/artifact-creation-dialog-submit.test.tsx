import { ARTIFACT_STATUS_ROOT } from "@repo/api/src/types/artifact-status";
import { ARTIFACT_STATUS_DISPLAY_LABELS } from "@repo/api/src/types/artifact-status-display";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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

const TYPE_PICKER = "Set artifact type… Required";
const TODO_LABEL = ARTIFACT_STATUS_DISPLAY_LABELS[ARTIFACT_STATUS_ROOT.Todo];
const IN_REVIEW_LABEL =
  ARTIFACT_STATUS_DISPLAY_LABELS[ARTIFACT_STATUS_ROOT.InReview];

const issueConfig: ArtifactCreationConfig = {
  defaultProject: "Platform Engineering",
  description: "Create an issue.",
  kind: ArtifactKind.Issue,
  noun: "issue",
  slugPrefix: "ISS",
};

describe("AddArtifactDialog validation", { timeout: FLOW_TIMEOUT_MS }, () => {
  it("names the dialog after the noun and enables Create only with a title and every required field", async () => {
    const user = userEvent.setup();
    render(
      <CreationHarness
        config={defaultArtifactCreationConfig}
        onCreate={createSpy()}
      />
    );

    expect(
      screen.getByRole("dialog", { name: "Create artifact" })
    ).toHaveAccessibleDescription(defaultArtifactCreationConfig.description);
    expect(screen.getByText("New artifact")).toBeInTheDocument();
    const create = screen.getByRole("button", { name: "Create artifact" });
    expect(create).toBeDisabled();

    await user.type(
      screen.getByRole("textbox", { name: "Artifact title" }),
      "   "
    );
    expect(create).toBeDisabled();
    await user.type(
      screen.getByRole("textbox", { name: "Artifact title" }),
      "Spec"
    );
    expect(create).toBeDisabled();

    await pickOption(user, TYPE_PICKER, "Issue");
    await closeTopPopover(user);

    expect(screen.getByRole("button", { name: TYPE_PICKER })).toHaveTextContent(
      "Issue"
    );
    expect(create).toBeEnabled();
  });
});

describe("AddArtifactDialog submit", { timeout: FLOW_TIMEOUT_MS }, () => {
  it("creates with every captured value, opens the result, and closes", async () => {
    const user = userEvent.setup();
    const onCreate = createSpy();
    const onOpenChange = vi.fn();
    render(
      <CreationHarness
        config={defaultArtifactCreationConfig}
        onCreate={onCreate}
        onOpenChange={onOpenChange}
      />
    );

    await user.type(
      screen.getByRole("textbox", { name: "Artifact title" }),
      "  Spec  "
    );
    await user.type(
      screen.getByRole("textbox", { name: "Artifact description" }),
      "  Body  "
    );
    await pickOption(user, TYPE_PICKER, "Issue");
    await closeTopPopover(user);
    await user.click(screen.getByRole("button", { name: "Create artifact" }));

    expect(lastCreateCall(onCreate)).toEqual([
      {
        attachments: [],
        collaborators: [],
        customValues: { "artifact-type": "Issue" },
        linkedArtifacts: [],
        owner: "Ottilie Eastwick",
        project: "Artifact foundations",
        repository: "closedloop-ai",
        status: ArtifactStatus.Backlog,
        summary: "Body",
        tags: [],
        title: "Spec",
      },
      { openAfterCreate: true },
    ]);
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Reopen creator" }));
    expect(screen.getByRole("textbox", { name: "Artifact title" })).toHaveValue(
      ""
    );
  });

  it.each([
    ["Agentic Component", ArtifactStatus.Todo],
    ["Prototype", ArtifactStatus.Todo],
    ["Document", ArtifactStatus.Draft],
  ])("defaults a %s to the %s status", async (type, status) => {
    const user = userEvent.setup();
    const onCreate = createSpy();
    render(
      <CreationHarness
        config={defaultArtifactCreationConfig}
        onCreate={onCreate}
      />
    );

    await user.type(
      screen.getByRole("textbox", { name: "Artifact title" }),
      "T"
    );
    await pickOption(user, TYPE_PICKER, type);
    await closeTopPopover(user);
    await user.click(screen.getByRole("button", { name: "Create artifact" }));

    expect(lastCreateCall(onCreate)[0].status).toBe(status);
  });

  it("submits the status chosen in the picker and omits the repository when the config has none", async () => {
    const user = userEvent.setup();
    const onCreate = createSpy();
    render(<CreationHarness config={issueConfig} onCreate={onCreate} />);

    await user.type(
      screen.getByRole("textbox", { name: "Issue title" }),
      "Bug"
    );
    await user.click(screen.getByRole("button", { name: "Change status…" }));
    await user.click(
      await screen.findByRole("option", { name: TODO_LABEL }, FIND_TIMEOUT)
    );
    await user.click(screen.getByRole("button", { name: "Create issue" }));

    expect(lastCreateCall(onCreate)[0]).toEqual(
      expect.objectContaining({
        project: "Platform Engineering",
        repository: null,
        status: ArtifactStatus.Todo,
      })
    );
  });

  it("keeps the dialog open for the next item when Create more is on", async () => {
    const user = userEvent.setup();
    const onCreate = createSpy();
    const onOpenChange = vi.fn();
    render(
      <CreationHarness
        config={issueConfig}
        onCreate={onCreate}
        onOpenChange={onOpenChange}
      />
    );

    await pickOption(user, "Set project…", "Ottilie August Strategic Projects");
    await closeTopPopover(user);
    await pickOption(user, "Add tags…", "UX");
    await closeTopPopover(user);
    await user.click(screen.getByRole("switch"));
    await user.type(
      screen.getByRole("textbox", { name: "Issue title" }),
      "One"
    );
    await user.click(screen.getByRole("button", { name: "Create issue" }));

    expect(lastCreateCall(onCreate)).toEqual([
      expect.objectContaining({
        project: "Ottilie August Strategic Projects",
        tags: ["UX"],
        title: "One",
      }),
      { openAfterCreate: false },
    ]);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Issue title" })).toHaveValue(
      ""
    );
    expect(screen.getByRole("switch")).toBeChecked();
    expect(
      screen.getByRole("button", { name: "Set project…" })
    ).toHaveTextContent("Ottilie August Strategic Projects");
    expect(screen.getByRole("button", { name: "Add tags…" })).toHaveTextContent(
      "Tags"
    );
  });

  it("ignores Create when the form is incomplete", async () => {
    const user = userEvent.setup();
    const onCreate = createSpy();
    render(<CreationHarness config={issueConfig} onCreate={onCreate} />);

    const create = screen.getByRole("button", { name: "Create issue" });
    await user.click(create);

    expect(onCreate).not.toHaveBeenCalled();
  });
});

describe("AddArtifactDialog draft", { timeout: FLOW_TIMEOUT_MS }, () => {
  it("saves an untitled Document draft with the Draft tag and closes", async () => {
    const user = userEvent.setup();
    const onCreate = createSpy();
    const onOpenChange = vi.fn();
    render(
      <CreationHarness
        config={defaultArtifactCreationConfig}
        onCreate={onCreate}
        onOpenChange={onOpenChange}
      />
    );

    await user.click(screen.getByRole("button", { name: "Save as draft" }));

    expect(lastCreateCall(onCreate)).toEqual([
      expect.objectContaining({
        status: ArtifactStatus.Draft,
        tags: ["Draft"],
        title: "Untitled artifact",
      }),
      { draft: true, openAfterCreate: false },
    ]);
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("files an Issue draft under Todo over the picked status and appends Draft to the picked tags", async () => {
    const user = userEvent.setup();
    const onCreate = createSpy();
    render(<CreationHarness config={issueConfig} onCreate={onCreate} />);

    const titleInput = screen.getByRole("textbox", { name: "Issue title" });
    await user.type(titleInput, " Named ");
    await user.click(screen.getByRole("button", { name: "Change status…" }));
    await user.click(
      await screen.findByRole("option", { name: IN_REVIEW_LABEL }, FIND_TIMEOUT)
    );
    await pickOption(user, "Add tags…", "UX");
    await closeTopPopover(user);
    await user.click(screen.getByRole("button", { name: "Save as draft" }));

    expect(lastCreateCall(onCreate)[0]).toEqual(
      expect.objectContaining({
        status: ArtifactStatus.Todo,
        tags: ["UX", "Draft"],
        title: "Named",
      })
    );
  });
});

describe("AddArtifactDialog close and reset", {
  timeout: FLOW_TIMEOUT_MS,
}, () => {
  it("resets every field when dismissed with Escape", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <CreationHarness
        config={issueConfig}
        onCreate={createSpy()}
        onOpenChange={onOpenChange}
      />
    );

    await user.type(
      screen.getByRole("textbox", { name: "Issue title" }),
      "Keep?"
    );
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await user.click(screen.getByRole("button", { name: "Reopen creator" }));

    expect(screen.getByRole("textbox", { name: "Issue title" })).toHaveValue(
      ""
    );
    // pins current behavior; looks odd because reset() restores the shared "Artifact foundations" project instead of the config's defaultProject
    expect(
      screen.getByRole("button", { name: "Set project…" })
    ).toHaveTextContent("Artifact foundations");
  });

  it("keeps typed fields when closed with the close button", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <CreationHarness
        config={issueConfig}
        onCreate={createSpy()}
        onOpenChange={onOpenChange}
      />
    );

    await user.type(
      screen.getByRole("textbox", { name: "Issue title" }),
      "Keep"
    );
    await user.click(screen.getByRole("button", { name: "Close creator" }));
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Reopen creator" }));

    // pins current behavior; looks odd because the close button skips the reset that Escape and overlay dismissal perform
    expect(screen.getByRole("textbox", { name: "Issue title" })).toHaveValue(
      "Keep"
    );
  });
});

describe("AddArtifactDialog initial status", {
  timeout: FLOW_TIMEOUT_MS,
}, () => {
  it("starts from an allowed initial status", async () => {
    const user = userEvent.setup();
    const onCreate = createSpy();
    render(
      <CreationHarness
        config={issueConfig}
        initialStatus={ArtifactStatus.InProgress}
        onCreate={onCreate}
      />
    );

    await user.type(screen.getByRole("textbox", { name: "Issue title" }), "x");
    await user.click(screen.getByRole("button", { name: "Create issue" }));

    expect(lastCreateCall(onCreate)[0].status).toBe(ArtifactStatus.InProgress);
  });

  it("falls back to the kind default for a status the kind does not allow", async () => {
    const user = userEvent.setup();
    const onCreate = createSpy();
    render(
      <CreationHarness
        config={issueConfig}
        initialStatus={ArtifactStatus.Approved}
        onCreate={onCreate}
      />
    );

    await user.type(screen.getByRole("textbox", { name: "Issue title" }), "x");
    await user.click(screen.getByRole("button", { name: "Create issue" }));

    expect(lastCreateCall(onCreate)[0].status).toBe(ArtifactStatus.Backlog);
  });
});
