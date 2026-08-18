// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PrototypeGrossTotalAvailability } from "../file-coverage-fixtures";
import { branchRows } from "../mock";
import { buildBranchDetail } from "../mock-detail";
import { BranchFilesChangedPanel } from "./branch-files-changed-panel";

const INCOMPLETE_NOTE = /only the verified rows shown here/i;
const UNAVAILABLE_NOTE = /completeness and totals are unavailable/i;
const NO_CHANGED_FILES = /has no changed files/i;
const STARRED_ADDITIONS = /^\+\d+\*$/;
const STARRED_DELETIONS = /^−\d+\*$/;
const SYNTHETIC_GENERATOR_PATH = /synthetic-generator\.ts/;

describe("BranchFilesChangedPanel", () => {
  it("renders all four required consumer-contract singular labels", () => {
    const { rerender } = renderPanel("br_1284");
    expect(screen.getByText("1 file")).not.toBeNull();

    rerender(<BranchFilesChangedPanel detail={detailFor("br_1281")} />);
    expect(screen.getByText("1 verified file")).not.toBeNull();

    rerender(<BranchFilesChangedPanel detail={detailFor("br_1270")} />);
    expect(screen.getByText("1 file shown*")).not.toBeNull();

    rerender(<BranchFilesChangedPanel detail={detailFor("br_dark_mode")} />);
    expect(screen.getByText("1 of 1 file shown*")).not.toBeNull();
  });

  it("keeps zero and representative multi-file labels plural", () => {
    const { rerender } = renderPanel("br_files_zero");
    expect(screen.getByText("0 files")).not.toBeNull();
    expect(screen.getByText(NO_CHANGED_FILES)).not.toBeNull();

    rerender(<BranchFilesChangedPanel detail={detailFor("br_1289")} />);
    expect(screen.getByText("2 of 3 files shown*")).not.toBeNull();
  });

  it("stars aggregate totals derived from incomplete shown rows", () => {
    const detail = detailFor("br_1270");
    render(<BranchFilesChangedPanel detail={detail} />);

    const additions = detail.files.reduce(
      (total, file) => total + file.additions,
      0
    );
    const deletions = detail.files.reduce(
      (total, file) => total + file.deletions,
      0
    );
    expect(screen.getByText(`+${additions}*`)).not.toBeNull();
    expect(screen.getByText(`−${deletions}*`)).not.toBeNull();
    expect(screen.getByText(INCOMPLETE_NOTE)).not.toBeNull();
  });

  it("omits unavailable aggregate totals but retains verified row deltas", () => {
    const detail = detailFor("br_1281");
    render(<BranchFilesChangedPanel detail={detail} />);

    const [file] = detail.files;
    expect(file).toBeDefined();
    expect(screen.getAllByText(`+${file!.additions}`)).toHaveLength(1);
    expect(screen.getAllByText(`−${file!.deletions}`)).toHaveLength(1);
    expect(screen.getByText(UNAVAILABLE_NOTE)).not.toBeNull();
  });

  it("renders additions and deletions aggregate availability independently", () => {
    const detail = detailFor("br_1270");
    detail.fileCoverage.grossTotals.additions = {
      availability: PrototypeGrossTotalAvailability.Unavailable,
    };
    render(<BranchFilesChangedPanel detail={detail} />);

    expect(screen.queryByText(STARRED_ADDITIONS)).toBeNull();
    expect(screen.getByText(STARRED_DELETIONS)).not.toBeNull();
  });

  it("programmatically associates incomplete and unavailable labels with local explanations", () => {
    const { rerender } = renderPanel("br_1270");
    const incompleteLabel = screen.getByText("1 file shown*");
    const incompleteNote = screen.getByText(INCOMPLETE_NOTE);
    expect(incompleteLabel.getAttribute("aria-describedby")).toBe(
      incompleteNote.id
    );

    rerender(<BranchFilesChangedPanel detail={detailFor("br_1281")} />);
    const unavailableLabel = screen.getByText("1 verified file");
    const unavailableNote = screen.getByText(UNAVAILABLE_NOTE);
    expect(unavailableLabel.getAttribute("aria-describedby")).toBe(
      unavailableNote.id
    );
  });

  it("preserves source provenance and the established file-row presentation", () => {
    const detail = detailFor("br_1284");
    render(<BranchFilesChangedPanel detail={detail} />);

    expect(screen.getByText("GitHub")).not.toBeNull();
    expect(screen.getByText(detail.files[0]!.path)).not.toBeNull();
    expect(screen.getAllByText(`+${detail.files[0]!.additions}`)).toHaveLength(
      2
    );
    expect(screen.getAllByText(`−${detail.files[0]!.deletions}`)).toHaveLength(
      2
    );
  });

  it("preserves Local provenance and its file rows", () => {
    const detail = detailFor("br_session_cost");
    render(<BranchFilesChangedPanel detail={detail} />);

    expect(screen.getByText("Local")).not.toBeNull();
    expect(screen.getByText(detail.files[0]!.path)).not.toBeNull();
  });

  it("opens and closes the existing inline unified diff from its file row", () => {
    const detail = detailFor("br_1284");
    render(<BranchFilesChangedPanel detail={detail} />);

    const fileRow = screen.getByRole("button", {
      name: SYNTHETIC_GENERATOR_PATH,
    });
    expect(fileRow.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(fileRow);
    expect(fileRow.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("@@ -1,2 +1,2 @@")).not.toBeNull();

    fireEvent.click(fileRow);
    expect(fileRow.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("@@ -1,2 +1,2 @@")).toBeNull();
  });

  it("exposes Files changed as a named region", () => {
    renderPanel("br_1284");
    expect(
      screen.getByRole("region", { name: "Files changed" })
    ).not.toBeNull();
  });
});

function renderPanel(branchId: string) {
  return render(<BranchFilesChangedPanel detail={detailFor(branchId)} />);
}

function detailFor(branchId: string) {
  const row = branchRows.find(({ id }) => id === branchId);
  if (!row) {
    throw new Error(`Missing Branch fixture ${branchId}`);
  }
  return buildBranchDetail(row, { useFileCoverageFixtures: true });
}
