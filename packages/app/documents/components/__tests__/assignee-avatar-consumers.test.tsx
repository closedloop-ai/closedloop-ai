import { ArtifactRow } from "@repo/app/documents/components/relationships/artifact-row";
import { AssigneeCell } from "@repo/app/documents/components/table/cells/edit-cells";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { sectionIcon } from "@repo/app/documents/components/table/group-section-icon";
import {
  GroupByMode,
  type GroupSectionDescriptor,
} from "@repo/app/documents/lib/group-by";
import {
  makeArtifact,
  TEST_USER,
} from "@repo/app/shared/test-fixtures/documents";
import { render } from "@repo/app/shared/test-fixtures/render-with-nav";
import { GroupSectionHeader } from "@repo/design-system/components/ui/group-section-header";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * ISS-7746, consumer side: WHERE the named avatar states an identity and where
 * an ancestor already states it, so the avatar opts out via `decorative`.
 *
 * These assertions live in the documents slice rather than beside the avatar
 * itself because they mount documents components (`ArtifactRow`, `AssigneeCell`,
 * the grouped table's `sectionIcon`), and `shared/**` must never import a
 * feature slice (`packages/app/AGENTS.md`). The avatar's own behavior — every
 * shape of its accessible name, including the bare `decorative` opt-out — is
 * covered in `shared/components/__tests__/assignee-avatar-accessible-name.test.tsx`.
 *
 * Every assertion goes through the accessibility tree and NOTHING hovers:
 * `data-slot="avatar"` is merged away by `TooltipTrigger asChild`, Radix
 * `AvatarImage` never mounts in jsdom, and a test that hovered would stay green
 * against the exact bug the ticket describes.
 *
 * The name strings are literals rather than `UNASSIGNED_ASSIGNEE_LABEL` on
 * purpose — this is a copy contract, and re-deriving the expectation from the
 * code under test would keep the suite green when the words a screen reader
 * speaks change.
 */

const ASSIGNED_NAME = "Ada Lovelace";
const UNASSIGNED_NAME = "Unassigned";

describe("AssigneeAvatar consumers", () => {
  it("names the assignee on a mounted ArtifactRow", () => {
    // ArtifactRow is the one consumer that renders no adjacent name of its own,
    // so before ISS-7746 its avatar was the sole — and silent — identity slot.
    render(<ArtifactRow artifact={makeArtifact({ assignee: TEST_USER })} />);

    expect(screen.getByRole("img", { name: ASSIGNED_NAME })).toBeVisible();
  });

  it("names the unassigned state on a mounted ArtifactRow", () => {
    render(<ArtifactRow artifact={makeArtifact({ assignee: null })} />);

    expect(screen.getByRole("img", { name: UNASSIGNED_NAME })).toBeVisible();
  });

  it("states the assignee ONCE on the grouped-table section header", () => {
    // `GroupSectionHeader` is a button whose accessible name folds in its icon's
    // and its own label's, and for an assignee group those are the same string.
    // A named avatar here would make the collapse control announce
    // "Ada Lovelace Ada Lovelace", so `sectionIcon` opts out via `decorative`.
    renderSectionHeader(assigneeSection(TEST_USER, ASSIGNED_NAME));

    expect(screen.getByRole("button", { name: ASSIGNED_NAME })).toBeVisible();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("states the unassigned group ONCE on its section header", () => {
    renderSectionHeader(assigneeSection(null, UNASSIGNED_NAME));

    expect(screen.getByRole("button", { name: UNASSIGNED_NAME })).toBeVisible();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("names the assignee in the read-only assignee cell", () => {
    // `AssigneeContent` renders the name beside the avatar when assigned, so the
    // avatar is decorative there and the cell still states the person once.
    renderCell(TEST_USER);

    expect(screen.getByText(ASSIGNED_NAME)).toBeVisible();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("names the unassigned assignee cell, which renders no name of its own", () => {
    // The branch that has no adjacent span: the avatar is the only statement,
    // so it keeps its name.
    renderCell(null);

    expect(screen.getByRole("img", { name: UNASSIGNED_NAME })).toBeVisible();
  });
});

/** The descriptor the documents table builds when grouping by assignee. */
function assigneeSection(
  assignee: typeof TEST_USER | null,
  label: string
): GroupSectionDescriptor {
  return {
    assignee,
    key: assignee?.id ?? "unassigned",
    label,
    mode: GroupByMode.Assignee,
  };
}

/** The real header the grouped documents table mounts around `sectionIcon`. */
function renderSectionHeader(descriptor: GroupSectionDescriptor) {
  return render(
    <GroupSectionHeader
      icon={sectionIcon(descriptor)}
      isOpen
      label={descriptor.label}
      onToggle={() => {
        // no-op: this test reads the header's accessible name, not its toggle
      }}
    />
  );
}

/** The read-only assignee cell, i.e. `RowEditContext` without edit handlers. */
function renderCell(assignee: typeof TEST_USER | null) {
  const item: DocumentRowItem = {
    data: makeArtifact({ assignee, assigneeId: assignee?.id ?? null }),
    kind: "document",
  };
  return render(<AssigneeCell item={item} />);
}
