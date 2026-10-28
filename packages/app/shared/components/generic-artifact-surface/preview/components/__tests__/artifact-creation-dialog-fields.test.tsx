import { TableCustomFieldType } from "@repo/design-system/components/ui/table-add-field-dialog-content";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactKind, genericArtifacts } from "../../fixtures";
import type { ArtifactCreationConfig } from "../artifact-creation";
import {
  CreationHarness,
  closeTopPopover,
  createSpy,
  lastCreateCall,
  pickOption,
} from "./support/creation-dialog-harness";
import { FIND_TIMEOUT, FLOW_TIMEOUT_MS } from "./support/flow-timeouts";

const fieldConfig: ArtifactCreationConfig = {
  description: "Create a prototype.",
  fields: [
    {
      id: "labels",
      label: "Labels",
      options: ["Alpha", "Beta"],
      type: "multi-select",
    },
    { id: "assignee", label: "Assignee", options: ["Pat"], type: "select" },
    {
      id: "notes",
      label: "Notes",
      placeholder: "Why this matters",
      required: true,
      type: "textarea",
    },
    { id: "estimate", label: "Estimate", type: "number" },
    { id: "due", label: "Due", type: "date" },
    { id: "summary-line", label: "Summary line", type: "text" },
  ],
  includeRepository: true,
  kind: ArtifactKind.Prototype,
  noun: "prototype",
  slugPrefix: "PRO",
};

const OWNER = "Pascoe Birchall";
const REPOSITORY_LABEL = "Repository";
const EXPAND_LABEL = "Expand creator";

const plainConfig: ArtifactCreationConfig = {
  description: "Create a document.",
  kind: ArtifactKind.Document,
  noun: "document",
  slugPrefix: "DOC",
};

async function openMoreFields(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByRole("button", { name: "More creation fields" })
  );
  await screen.findByText("Additional fields", {}, FIND_TIMEOUT);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AddArtifactDialog configured fields", {
  timeout: FLOW_TIMEOUT_MS,
}, () => {
  it("splits select fields into chips and the rest into the additional-fields popover", async () => {
    const user = userEvent.setup();
    const onCreate = createSpy();
    render(<CreationHarness config={fieldConfig} onCreate={onCreate} />);

    await user.type(
      screen.getByRole("textbox", { name: "Prototype title" }),
      "Flow"
    );
    const create = screen.getByRole("button", { name: "Create prototype" });
    expect(create).toBeDisabled();

    await pickOption(user, "Set labels…", "Alpha");
    await user.click(screen.getByText("Beta"));
    expect(
      screen.getByRole("button", { name: "Set labels…" })
    ).toHaveTextContent("Labels: 2");
    await user.click(screen.getByText("Alpha"));
    expect(
      screen.getByRole("button", { name: "Set labels…" })
    ).toHaveTextContent("Labels: 1");
    await closeTopPopover(user);
    await pickOption(user, "Set assignee…", "Pat");
    await closeTopPopover(user);
    expect(
      screen.getByRole("button", { name: "Set assignee…" })
    ).toHaveTextContent("Pat");

    await openMoreFields(user);
    const notes = screen.getByRole("textbox", { name: "Notes *" });
    expect(notes).toHaveAttribute("placeholder", "Why this matters");
    await user.type(notes, "   ");
    expect(create).toBeDisabled();
    await user.type(notes, "because");
    await user.type(screen.getByRole("spinbutton", { name: "Estimate" }), "5");
    fireEvent.change(screen.getByLabelText("Due"), {
      target: { value: "2026-10-01" },
    });
    await user.type(
      screen.getByRole("textbox", { name: "Summary line" }),
      "short"
    );
    await closeTopPopover(user);
    expect(create).toBeEnabled();
    await user.click(create);

    expect(lastCreateCall(onCreate)[0].customValues).toEqual({
      assignee: "Pat",
      due: "2026-10-01",
      estimate: 5,
      labels: ["Beta"],
      notes: "   because",
      "summary-line": "short",
    });
  });

  it("requires a pick in a required multi-select and shows the bare label once emptied", async () => {
    const user = userEvent.setup();
    render(
      <CreationHarness
        config={{
          ...plainConfig,
          fields: [
            {
              id: "reviewers",
              label: "Reviewers",
              options: ["Kim"],
              required: true,
              type: "multi-select",
            },
            { id: "stage", label: "Stage", type: "select" },
          ],
        }}
        onCreate={createSpy()}
      />
    );
    await user.type(
      screen.getByRole("textbox", { name: "Document title" }),
      "Doc"
    );
    const create = screen.getByRole("button", { name: "Create document" });
    const reviewers = screen.getByRole("button", {
      name: "Set reviewers… Required",
    });

    await pickOption(user, "Set reviewers… Required", "Kim");
    expect(reviewers).toHaveTextContent("Reviewers: 1");
    expect(create).toBeEnabled();
    await user.click(screen.getByText("Kim"));
    expect(reviewers.textContent).toBe("Reviewers");
    expect(create).toBeDisabled();
    await closeTopPopover(user);

    await user.click(screen.getByRole("button", { name: "Set stage…" }));
    expect(
      await screen.findByText("No options found.", {}, FIND_TIMEOUT)
    ).toBeInTheDocument();
  });

  it("stores a cleared number field as zero", async () => {
    const user = userEvent.setup();
    const onCreate = createSpy();
    render(<CreationHarness config={fieldConfig} onCreate={onCreate} />);

    await openMoreFields(user);
    const estimate = screen.getByRole("spinbutton", { name: "Estimate" });
    await user.type(estimate, "7");
    await user.clear(estimate);
    expect(estimate).toHaveValue(0);
    await user.type(screen.getByRole("textbox", { name: "Notes *" }), "n");
    await closeTopPopover(user);
    await user.type(
      screen.getByRole("textbox", { name: "Prototype title" }),
      "P"
    );
    await user.click(screen.getByRole("button", { name: "Create prototype" }));

    expect(lastCreateCall(onCreate)[0].customValues).toEqual({
      estimate: 0,
      notes: "n",
    });
  });

  it("marks only required chips as required and picks an icon per field id", async () => {
    const user = userEvent.setup();
    render(<CreationHarness config={fieldConfig} onCreate={createSpy()} />);

    expect(
      screen.getByRole("button", { name: "Set labels…" }).querySelector("svg")
    ).toHaveClass("lucide-tag");
    expect(
      screen.getByRole("button", { name: "Set assignee…" }).querySelector("svg")
    ).toHaveClass("lucide-user-round");
    await openMoreFields(user);
    expect(
      screen.getByText("Due").closest("span")?.querySelector("svg")
    ).toHaveClass("lucide-calendar");
    expect(
      screen.getByText("Estimate").closest("span")?.querySelector("svg")
    ).toHaveClass("lucide-circle-dot-dashed");
    expect(screen.getByLabelText("Due")).toHaveAttribute("type", "date");
    expect(
      screen.getByRole("textbox", { name: "Summary line" })
    ).toHaveAttribute("type", "text");
  });
});

describe("AddArtifactDialog custom fields", {
  timeout: FLOW_TIMEOUT_MS,
}, () => {
  it("maps each custom field type to a chip or an input", async () => {
    const user = userEvent.setup();
    const onCreate = createSpy();
    render(
      <CreationHarness
        config={plainConfig}
        customFields={[
          {
            id: "cf-sev",
            label: "Severity",
            options: ["Low", "High"],
            type: TableCustomFieldType.SingleSelect,
          },
          {
            id: "cf-areas",
            label: "Areas",
            options: ["Web"],
            type: TableCustomFieldType.MultiSelect,
          },
          {
            id: "cf-refs",
            label: "Refs",
            type: TableCustomFieldType.ReferenceMulti,
          },
          { id: "cf-ref", label: "Ref", type: TableCustomFieldType.Reference },
          { id: "cf-when", label: "When", type: TableCustomFieldType.Date },
          { id: "cf-time", label: "Spent", type: TableCustomFieldType.Time },
          { id: "cf-pts", label: "Points", type: TableCustomFieldType.Number },
          { id: "cf-who", label: "Who", type: TableCustomFieldType.People },
          { id: "cf-txt", label: "Memo", type: TableCustomFieldType.Text },
        ]}
        onCreate={onCreate}
      />
    );

    await pickOption(user, "Set severity…", "High");
    await closeTopPopover(user);
    await pickOption(user, "Set areas…", "Web");
    await closeTopPopover(user);
    await pickOption(user, "Set refs…", genericArtifacts[1]!.slug);
    await closeTopPopover(user);
    expect(screen.getByRole("button", { name: "Set refs…" })).toHaveTextContent(
      "Refs: 1"
    );

    await openMoreFields(user);
    expect(screen.getByRole("textbox", { name: "Ref" })).toHaveAttribute(
      "type",
      "text"
    );
    expect(screen.getByLabelText("When")).toHaveAttribute("type", "date");
    expect(
      screen.getByRole("spinbutton", { name: "Spent" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("spinbutton", { name: "Points" })
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Who" })).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Memo" }), "m");
    await closeTopPopover(user);
    await user.type(
      screen.getByRole("textbox", { name: "Document title" }),
      "Doc"
    );
    await user.click(screen.getByRole("button", { name: "Create document" }));

    expect(lastCreateCall(onCreate)[0].customValues).toEqual({
      "cf-areas": ["Web"],
      "cf-refs": [genericArtifacts[1]!.slug],
      "cf-sev": "High",
      "cf-txt": "m",
    });
  });
});

describe("AddArtifactDialog shared properties", {
  timeout: FLOW_TIMEOUT_MS,
}, () => {
  it("assigns an owner, excludes them from collaborators, and counts picks", async () => {
    const user = userEvent.setup();
    const onCreate = createSpy();
    render(<CreationHarness config={plainConfig} onCreate={onCreate} />);

    await pickOption(user, "Assign owner…", OWNER);
    await closeTopPopover(user);
    expect(
      screen.getByRole("button", { name: "Assign owner…" })
    ).toHaveTextContent(OWNER);
    await user.click(
      screen.getByRole("button", { name: "Add collaborators…" })
    );
    const list = await screen.findByRole("listbox", {}, FIND_TIMEOUT);
    expect(list).not.toHaveTextContent(OWNER);
    await user.click(screen.getByText("Sam Chen"));
    await user.click(screen.getByText("Jordan Lee"));
    await closeTopPopover(user);
    expect(
      screen.getByRole("button", { name: "Add collaborators…" })
    ).toHaveTextContent("2 collaborators");
    await pickOption(user, "Add tags…", "Research");
    await user.click(screen.getByText("Product"));
    await closeTopPopover(user);
    expect(screen.getByRole("button", { name: "Add tags…" })).toHaveTextContent(
      "Research, Product"
    );

    await user.type(
      screen.getByRole("textbox", { name: "Document title" }),
      "Doc"
    );
    await user.click(screen.getByRole("button", { name: "Create document" }));
    expect(lastCreateCall(onCreate)[0]).toEqual(
      expect.objectContaining({
        collaborators: ["Sam Chen", "Jordan Lee"],
        owner: OWNER,
        repository: null,
        tags: ["Research", "Product"],
      })
    );
  });

  it("links artifacts and edits the repository from the additional fields", async () => {
    const user = userEvent.setup();
    const onCreate = createSpy();
    render(<CreationHarness config={fieldConfig} onCreate={onCreate} />);
    const [first] = genericArtifacts;

    await openMoreFields(user);
    const repository = screen.getByRole("textbox", { name: REPOSITORY_LABEL });
    expect(repository).toHaveValue("closedloop-ai");
    await user.clear(repository);
    await user.type(screen.getByRole("textbox", { name: "Notes *" }), "n");
    await pickOption(user, "Link artifacts…", `${first!.slug} ${first!.title}`);
    await closeTopPopover(user);
    // pins current behavior; looks odd because the label stays plural ("artifacts") for a single linked artifact
    expect(
      screen.getByRole("button", { name: "Link artifacts…" })
    ).toHaveTextContent("1 linked artifacts");
    await closeTopPopover(user);
    await user.type(
      screen.getByRole("textbox", { name: "Prototype title" }),
      "P"
    );
    await user.click(screen.getByRole("button", { name: "Create prototype" }));

    expect(lastCreateCall(onCreate)[0]).toEqual(
      expect.objectContaining({
        linkedArtifacts: [`${first!.slug} ${first!.title}`],
        repository: null,
      })
    );
  });

  it("does not offer a repository field when the config excludes it", async () => {
    const user = userEvent.setup();
    render(<CreationHarness config={plainConfig} onCreate={createSpy()} />);

    await openMoreFields(user);

    expect(screen.getByText("Additional fields")).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: REPOSITORY_LABEL })
    ).toBeNull();
  });
});

describe("AddArtifactDialog editor affordances", {
  timeout: FLOW_TIMEOUT_MS,
}, () => {
  it("lists attached file names and submits them", async () => {
    const user = userEvent.setup();
    const onCreate = createSpy();
    const click = vi.spyOn(HTMLInputElement.prototype, "click");
    render(<CreationHarness config={plainConfig} onCreate={onCreate} />);

    await user.click(screen.getByRole("button", { name: "Attach files" }));
    expect(click).toHaveBeenCalled();
    const input = document.querySelector('input[type="file"]');
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("missing file input");
    }
    await user.upload(input, [
      new File(["a"], "a.txt"),
      new File(["b"], "b.png"),
    ]);

    expect(screen.getByText("a.txt")).toBeInTheDocument();
    expect(screen.getByText("b.png")).toBeInTheDocument();
    await user.type(
      screen.getByRole("textbox", { name: "Document title" }),
      "Doc"
    );
    await user.click(screen.getByRole("button", { name: "Create document" }));
    expect(lastCreateCall(onCreate)[0].attachments).toEqual(["a.txt", "b.png"]);
  });

  it.each([
    ["Bold", "**hello** world", 2],
    ["Italic", "_hello_ world", 1],
    ["Strikethrough", "~~hello~~ world", 2],
    ["Underline", "<u>hello</u> world", 3],
    ["Link", "[hello](url) world", 1],
    ["Quote", "> hello world", 2],
    ["Code", "`hello` world", 1],
    ["List", "- hello world", 2],
  ])(
    "%s wraps the selected description text",
    async (label, expected, shift) => {
      const user = userEvent.setup();
      render(<CreationHarness config={plainConfig} onCreate={createSpy()} />);
      const description = screen.getByRole("textbox", {
        name: "Document description",
      });
      if (!(description instanceof HTMLTextAreaElement)) {
        throw new Error("expected a textarea");
      }
      await user.type(description, "hello world");
      description.setSelectionRange(0, 5);

      fireEvent.mouseDown(screen.getByRole("button", { name: label }));

      expect(description).toHaveValue(expected);
      await waitFor(() =>
        expect([description.selectionStart, description.selectionEnd]).toEqual([
          shift,
          5 + shift,
        ])
      );
      expect(description).toHaveFocus();
    }
  );

  it("toggles between expanded and collapsed", async () => {
    const user = userEvent.setup();
    render(<CreationHarness config={plainConfig} onCreate={createSpy()} />);

    await user.click(screen.getByRole("button", { name: EXPAND_LABEL }));
    expect(screen.queryByRole("button", { name: EXPAND_LABEL })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Collapse creator" }));

    expect(
      screen.getByRole("button", { name: EXPAND_LABEL })
    ).toBeInTheDocument();
  });
});
