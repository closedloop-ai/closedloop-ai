// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { genericArtifacts } from "../../fixtures";
import {
  ArtifactSectionHeading,
  CommonArtifactDetails,
  MultiValueEditor,
} from "../artifact-detail-sections";

const PRODUCT_PATTERN = /^Product/;

const LINE_ONE_PATTERN = /^Line one$/;
const N7_PATTERN = /^7$/;
const PASCOE_BIRCHALL_PATTERN = /Pascoe Birchall$/;
const SAM_CHEN_PATTERN = /Sam Chen$/;
const HEADING0TAIL_PATTERN = /^Heading0Tail$/;
const HEADING_PATTERN = /^Heading$/;

const artifact = {
  ...genericArtifacts[0]!,
  collaborators: ["Pascoe Birchall"],
  currentVersion: "4",
  project: null,
  repository: null,
  tags: ["Product"],
  title: "Original title",
};

const OPTIONAL_SECTIONS = [
  "Custom fields",
  "Linked artifacts",
  "Version history",
  "Activity",
] as const;

function trigger(label: string): HTMLElement {
  return screen.getByRole("button", { name: `Edit ${label.toLowerCase()}` });
}

function field(label: string): HTMLElement {
  return screen.getByRole("textbox", { name: label });
}

function editText(label: string, value: string) {
  fireEvent.click(trigger(label));
  fireEvent.change(field(label), { target: { value } });
}

describe("CommonArtifactDetails presentation", () => {
  it("shows placeholder project and repository values for an unlinked artifact", () => {
    render(<CommonArtifactDetails artifact={artifact} />);

    expect(trigger("Project")).toHaveTextContent("No project");
    expect(trigger("Repository")).toHaveTextContent("Not connected");
    for (const title of OPTIONAL_SECTIONS) {
      expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
    }
    expect(trigger("Current version")).toHaveTextContent("4");
  });

  it("hides opted-out sections and the current version, and renders extension rows", async () => {
    const user = userEvent.setup();
    render(
      <CommonArtifactDetails
        artifact={artifact}
        presentation={{
          additionalRows: [
            { id: "static", label: "Static row", value: "Fixed value" },
            {
              editableValue: "Seed",
              id: "edit",
              label: "Editable row",
              value: null,
            },
          ],
          fields: { currentVersion: false },
          sections: {
            activity: false,
            customFields: false,
            linkedArtifacts: false,
            versionHistory: false,
          },
        }}
      />
    );

    for (const title of OPTIONAL_SECTIONS) {
      expect(screen.queryByRole("heading", { name: title })).toBeNull();
    }
    expect(
      screen.queryByRole("button", { name: "Edit current version" })
    ).toBeNull();
    expect(screen.getByText("Fixed value")).toBeInTheDocument();

    await user.click(trigger("Editable row"));
    const input = screen.getByRole("textbox", { name: "Editable row" });
    await user.clear(input);
    await user.type(input, "  Changed  {Enter}");
    expect(trigger("Editable row")).toHaveTextContent("Changed");
  });
});

describe("CommonArtifactDetails inline text editors", () => {
  it("saves a trimmed value on Enter", () => {
    render(<CommonArtifactDetails artifact={artifact} />);

    editText("Artifact name", "  Renamed  ");
    fireEvent.keyDown(field("Artifact name"), { key: "Tab" });
    expect(field("Artifact name")).toHaveValue("  Renamed  ");
    fireEvent.keyDown(field("Artifact name"), { key: "Enter" });

    expect(trigger("Artifact name").textContent).toBe("Renamed");
  });

  it("reverts the draft on Escape and Cancel", () => {
    render(<CommonArtifactDetails artifact={artifact} />);

    editText("Artifact name", "Draft");
    fireEvent.keyDown(field("Artifact name"), { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Artifact name" })).toBeNull();
    fireEvent.click(trigger("Artifact name"));
    expect(field("Artifact name")).toHaveValue(artifact.title);

    fireEvent.change(field("Artifact name"), { target: { value: "Again" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(trigger("Artifact name").textContent).toBe(artifact.title);
  });

  it("refuses a blank save and restores the previous draft", () => {
    render(<CommonArtifactDetails artifact={artifact} />);

    editText("Artifact name", "   ");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(trigger("Artifact name").textContent).toBe(artifact.title);
    fireEvent.click(trigger("Artifact name"));
    expect(field("Artifact name")).toHaveValue(artifact.title);
  });

  it("edits the multiline description with Save and discards on Escape", () => {
    render(<CommonArtifactDetails artifact={artifact} />);

    editText("Artifact description", "Line one");
    fireEvent.keyDown(field("Artifact description"), { key: "Enter" });
    expect(field("Artifact description")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(trigger("Artifact description")).toHaveTextContent(LINE_ONE_PATTERN);

    editText("Artifact description", "Discarded");
    fireEvent.keyDown(field("Artifact description"), { key: "Escape" });
    expect(trigger("Artifact description")).toHaveTextContent(LINE_ONE_PATTERN);
    fireEvent.click(trigger("Artifact description"));
    expect(field("Artifact description")).toHaveValue("Line one");
  });

  it("normalizes the current version to its first positive integer", () => {
    render(<CommonArtifactDetails artifact={artifact} />);

    editText("Current version", "v07-beta");
    fireEvent.keyDown(field("Current version"), { key: "Enter" });
    expect(trigger("Current version")).toHaveTextContent(N7_PATTERN);

    editText("Current version", "0");
    fireEvent.keyDown(field("Current version"), { key: "Enter" });
    expect(trigger("Current version")).toHaveTextContent(N7_PATTERN);

    editText("Current version", "none");
    fireEvent.keyDown(field("Current version"), { key: "Enter" });
    expect(trigger("Current version")).toHaveTextContent(N7_PATTERN);
  });
});

describe("CommonArtifactDetails people and tags", () => {
  it("toggles collaborators off to the empty label and back on", async () => {
    const user = userEvent.setup();
    render(<CommonArtifactDetails artifact={artifact} />);

    await user.click(
      screen.getByRole("button", {
        name: "Edit collaborators: Pascoe Birchall",
      })
    );
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: PASCOE_BIRCHALL_PATTERN,
      })
    );
    const empty = screen.getByRole("button", {
      name: "Edit collaborators: none",
    });
    expect(empty).toHaveTextContent("No collaborators");

    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: SAM_CHEN_PATTERN,
      })
    );
    expect(
      screen.getByRole("button", { name: "Edit collaborators: Sam Chen" })
    ).toBeInTheDocument();
  });

  it("filters, toggles, and creates tags", async () => {
    const user = userEvent.setup();
    render(<CommonArtifactDetails artifact={artifact} />);

    await user.click(
      screen.getByRole("button", { name: "Edit tags: Product" })
    );
    const search = screen.getByRole("textbox", { name: "Search or add tags" });
    await user.type(search, "res");
    const results = screen.getByRole("dialog");
    expect(
      within(results)
        .getAllByRole("button")
        .map((button) => button.textContent)
    ).toEqual(["Research", "Create “res”"]);
    await user.click(within(results).getByRole("button", { name: "Research" }));
    expect(
      screen.getByRole("button", { name: "Edit tags: Product, Research" })
    ).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "Product");
    expect(
      within(results).getByRole("button", { name: PRODUCT_PATTERN })
    ).toHaveTextContent("ProductAdded");
    await user.click(
      within(results).getByRole("button", { name: PRODUCT_PATTERN })
    );
    expect(
      screen.getByRole("button", { name: "Edit tags: Research" })
    ).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "  Brand new ");
    await user.click(
      within(results).getByRole("button", { name: "Create “Brand new”" })
    );
    expect(
      screen.getByRole("button", { name: "Edit tags: Research, Brand new" })
    ).toBeInTheDocument();
    expect(search).toHaveValue("");
  });
});

describe("MultiValueEditor", () => {
  it("starts with the first two options and toggles membership", async () => {
    const user = userEvent.setup();
    render(<MultiValueEditor options={["Alpha", "Beta", "Gamma"]} />);

    await user.click(
      screen.getByRole("button", { name: "Edit values: Alpha, Beta" })
    );
    await user.click(screen.getByRole("button", { name: "Alpha" }));
    await user.click(screen.getByRole("button", { name: "Gamma" }));

    expect(
      screen.getByRole("button", { name: "Edit values: Beta, Gamma" })
    ).toBeInTheDocument();
  });
});

describe("ArtifactSectionHeading", () => {
  it("renders a zero count and trailing content, and omits an absent count", () => {
    const { rerender } = render(
      <ArtifactSectionHeading count={0} title="Heading" trailing="Tail" />
    );
    expect(
      screen.getByRole("heading", { name: "Heading" }).parentElement
    ).toHaveTextContent(HEADING0TAIL_PATTERN);

    rerender(<ArtifactSectionHeading title="Heading" />);
    expect(
      screen.getByRole("heading", { name: "Heading" }).parentElement
    ).toHaveTextContent(HEADING_PATTERN);
  });
});
