// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { genericArtifacts } from "../../fixtures";
import {
  type ArtifactActivityRecord,
  ArtifactActivityTrace,
  ArtifactVersionHistory,
} from "../artifact-history";

const N3_PATTERN = /^3/;
const N2_PATTERN = /^2/;
const N1_PATTERN = /^1/;

const JUL_PATTERN = /· Jul/;
const EARLIER_INTERACTION_CONTRACT_PATTERN = /earlier interaction contract/;

const { toastSuccess } = vi.hoisted(() => ({
  toastSuccess: vi.fn<(message: string) => void>(),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { success: toastSuccess },
}));

const artifact = { ...genericArtifacts[0]!, currentVersion: "3" };

const records: readonly ArtifactActivityRecord[] = [
  {
    actor: "Ottilie Eastwick",
    body: "created",
    date: "Jul 1",
    id: "e1",
    kind: "event",
  },
  {
    actor: "Pascoe Birchall",
    body: "said hi",
    date: "Jul 2",
    id: "c1",
    kind: "comment",
    version: "2",
  },
  {
    actor: "Sam Chen",
    body: "said bye",
    date: "Jul 3",
    id: "c2",
    kind: "comment",
  },
];

function activityRows(): string[] {
  return screen.getAllByText(JUL_PATTERN).map((row) => row.textContent ?? "");
}

function versionRows(): HTMLElement[] {
  return screen
    .getAllByRole("button")
    .filter((button) => button.hasAttribute("aria-pressed"));
}

describe("ArtifactActivityTrace", () => {
  it("filters to comments and reverses to newest first", () => {
    render(<ArtifactActivityTrace artifact={artifact} records={records} />);

    expect(activityRows()).toEqual([
      "Ottilie Eastwick created· Jul 1",
      "Pascoe Birchall said hi2· Jul 2",
      "Sam Chen said bye· Jul 3",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Comments" }));
    expect(screen.getByRole("button", { name: "Comments" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(activityRows()).toEqual([
      "Pascoe Birchall said hi2· Jul 2",
      "Sam Chen said bye· Jul 3",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Oldest" }));
    expect(screen.getByRole("button", { name: "Newest" })).toBeInTheDocument();
    expect(activityRows()).toEqual([
      "Sam Chen said bye· Jul 3",
      "Pascoe Birchall said hi2· Jul 2",
    ]);
  });

  it("falls back to the default project name and omits the prior-version comment at version 1", () => {
    render(
      <ArtifactActivityTrace
        artifact={{ ...artifact, currentVersion: "1", project: null }}
      />
    );

    expect(
      screen.getByRole("button", { name: "Artifact foundations" })
    ).toBeInTheDocument();
    expect(screen.queryByText(EARLIER_INTERACTION_CONTRACT_PATTERN)).toBeNull();
  });

  it("adds the prior-version comment when the current version is numeric and above 1", () => {
    render(
      <ArtifactActivityTrace
        artifact={{ ...artifact, project: "Named project" }}
      />
    );

    expect(
      screen.getByRole("button", { name: "Named project" })
    ).toBeInTheDocument();
    expect(
      screen.getByText(EARLIER_INTERACTION_CONTRACT_PATTERN).textContent
    ).toContain("2· Jul 28");
  });
});

describe("ArtifactVersionHistory", () => {
  beforeEach(() => {
    toastSuccess.mockClear();
  });

  it("lists current and two earlier versions and hides compare on the current one", () => {
    render(<ArtifactVersionHistory artifact={artifact} />);

    expect(versionRows().map((row) => row.textContent)).toEqual([
      `3${artifact.owner}Current${artifact.updated}`,
      "2Ottilie EastwickPublished2d ago",
      "1Pascoe BirchallPublished6d ago",
    ]);
    expect(screen.getByRole("button", { pressed: true })).toHaveTextContent(
      N3_PATTERN
    );
    expect(screen.queryByRole("button", { name: "Compare" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open version" }));
    expect(toastSuccess).toHaveBeenLastCalledWith("Opened 3");
  });

  it("starts from a known initial version and offers compare and restore", () => {
    const onVersionChange = vi.fn();
    render(
      <ArtifactVersionHistory
        artifact={artifact}
        initialVersion="2"
        onVersionChange={onVersionChange}
      />
    );

    expect(screen.getByRole("button", { pressed: true })).toHaveTextContent(
      N2_PATTERN
    );
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    expect(toastSuccess).toHaveBeenLastCalledWith("Comparing 2 with current");
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(toastSuccess).toHaveBeenLastCalledWith("2 restored");

    fireEvent.click(screen.getByText("1", { selector: "span" }));
    expect(onVersionChange).toHaveBeenCalledWith("1");
    expect(screen.getByRole("button", { pressed: true })).toHaveTextContent(
      N1_PATTERN
    );
  });

  it("follows a later known initial version and ignores an unknown one", () => {
    const { rerender } = render(
      <ArtifactVersionHistory artifact={artifact} initialVersion="9" />
    );
    expect(screen.getByRole("button", { pressed: true })).toHaveTextContent(
      N3_PATTERN
    );

    rerender(<ArtifactVersionHistory artifact={artifact} initialVersion="1" />);
    expect(screen.getByRole("button", { pressed: true })).toHaveTextContent(
      N1_PATTERN
    );
  });

  it("shows only the current version for a non-numeric version and selects nothing without records", () => {
    const { unmount } = render(
      <ArtifactVersionHistory
        artifact={{ ...artifact, currentVersion: "v3" }}
      />
    );
    expect(versionRows()).toHaveLength(1);
    unmount();

    render(<ArtifactVersionHistory artifact={artifact} records={[]} />);
    expect(screen.queryByRole("button", { pressed: true })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open version" }));
    expect(toastSuccess).toHaveBeenLastCalledWith("Opened ");
  });
});
