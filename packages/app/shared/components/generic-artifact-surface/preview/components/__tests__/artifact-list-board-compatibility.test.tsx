// @vitest-environment jsdom

import { ARTIFACT_STATUS_ROOT } from "@repo/api/src/types/artifact-status";
import { ARTIFACT_STATUS_UNKNOWN_TOOLTIP } from "@repo/api/src/types/artifact-status-display";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { ARTIFACT_STATUS_LABEL_HONESTY_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { GridTableV2Group as GridTableGroup } from "@repo/design-system/components/ui/grid-table-v2";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ComponentProps, type ReactNode, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { genericArtifactStatusLabel } from "../../../generic-artifact-status";
import {
  ArtifactKind,
  ArtifactStatus,
  type GenericArtifact,
  genericArtifacts,
} from "../../fixtures";
import { ArtifactListBoardView } from "../artifact-list-board";
import { EDITABLE_OWNERS } from "../artifact-list-owners";

const STATUS_REFUSAL = /cannot be changed here/i;
const issue = {
  ...genericArtifacts.find((artifact) => artifact.kind === ArtifactKind.Issue)!,
  commentCount: 3,
  id: "issue-1",
  status: ArtifactStatus.Todo,
  title: "Issue card",
};
const branch = {
  ...genericArtifacts.find(
    (artifact) => artifact.kind === ArtifactKind.Branch
  )!,
  commentCount: 0,
  id: "branch-1",
  title: "Branch card",
};

type BoardProps = ComponentProps<typeof ArtifactListBoardView>;

function renderBoard(overrides: Partial<BoardProps> = {}) {
  const props: BoardProps = {
    config: { editable: true },
    defaultKind: ArtifactKind.Issue,
    groupBy: "owner",
    groups: [{ items: [issue], key: issue.owner, label: issue.owner }],
    noun: { plural: "artifacts", singular: "artifact" },
    onGroupDrop: vi.fn(),
    onOpen: vi.fn(),
    onStatusChange: vi.fn(),
    secondaryGroupBy: "none",
    ...overrides,
  };
  const result = render(<ArtifactListBoardView {...props} />, {
    wrapper: WithNavigation,
  });
  return { ...result, props };
}

function card(title: string): HTMLElement {
  return screen
    .getByText(title)
    .closest<HTMLElement>("[data-artifact-board-card]")!;
}

async function openActions(title: string) {
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: `Actions for ${title}` })
  );
  return user;
}

describe("CT-15 migrated ArtifactStatusBoard authority coverage", () => {
  it("keeps provider- and runtime-owned rows read-only in a mixed board", async () => {
    const session = genericArtifacts.find(
      (artifact) => artifact.kind === ArtifactKind.Session
    )!;
    const onStatusChange = vi.fn();
    renderBoard({
      groupBy: "status",
      groups: [
        {
          items: [branch, session, issue],
          key: ARTIFACT_STATUS_ROOT.InProgress,
          label: "In progress",
        },
      ],
      onStatusChange,
    });

    expect(
      card(branch.title).closest('[data-artifact-board-drag-disabled="true"]')
    ).not.toBeNull();
    expect(
      card(session.title).closest('[data-artifact-board-drag-disabled="true"]')
    ).not.toBeNull();
    expect(
      card(issue.title).closest('[data-artifact-board-drag-disabled="true"]')
    ).toBeNull();
    await openActions(branch.title);
    expect(screen.getByRole("menuitem")).toHaveAttribute(
      "aria-disabled",
      "true"
    );
    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it("keeps an unknown row read-only and gates its explanation", async () => {
    const unknown = {
      ...issue,
      id: "unknown-issue",
      statusRaw: "FUTURE_STATUS",
      title: "Unknown issue status",
    };
    const props: Partial<BoardProps> = {
      groups: [{ items: [unknown], key: unknown.owner, label: unknown.owner }],
    };
    const rendered = renderBoard(props);

    expect(screen.queryByTitle(ARTIFACT_STATUS_UNKNOWN_TOOLTIP)).toBeNull();
    await openActions(unknown.title);
    expect(screen.getByText(STATUS_REFUSAL)).toBeVisible();

    rendered.unmount();
    render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [ARTIFACT_STATUS_LABEL_HONESTY_FEATURE_FLAG_KEY],
        })}
      >
        <ArtifactListBoardView {...(renderBoardProps(props) as BoardProps)} />
      </FeatureFlagAdapterProvider>,
      { wrapper: WithNavigation }
    );
    expect(screen.getByTitle(ARTIFACT_STATUS_UNKNOWN_TOOLTIP)).toBeVisible();
  });

  it("moves through the champion menu without relying on native DataTransfer reads", async () => {
    const onGroupDrop = vi.fn();
    renderBoard({
      groupBy: "status",
      groups: [
        { items: [issue], key: ARTIFACT_STATUS_ROOT.Todo, label: "Todo" },
        { items: [], key: ARTIFACT_STATUS_ROOT.Done, label: "Done" },
      ],
      onGroupDrop,
    });

    const user = await openActions(issue.title);
    const doneMoves = screen.getAllByRole("menuitem", { name: "Move to Done" });
    await user.click(doneMoves.at(-1)!);
    expect(onGroupDrop).toHaveBeenCalledWith(
      issue.id,
      "status",
      ARTIFACT_STATUS_ROOT.Done,
      undefined,
      undefined
    );
  });

  it("refuses a status lane the artifact kind cannot resolve", async () => {
    const document = genericArtifacts.find(
      (artifact) => artifact.kind === ArtifactKind.Document
    )!;
    const onGroupDrop = vi.fn();
    renderBoard({
      defaultKind: ArtifactKind.Document,
      groupBy: "status",
      groups: [
        { items: [document], key: ARTIFACT_STATUS_ROOT.Todo, label: "Todo" },
      ],
      onGroupDrop,
    });
    const user = await openActions(document.title);
    await user.click(screen.getByRole("menuitem", { name: "Move to Todo" }));
    expect(onGroupDrop).not.toHaveBeenCalled();
  });

  it("does not offer a Document Done move or creation that would imply Approved", () => {
    const document = genericArtifacts.find(
      (artifact) => artifact.kind === ArtifactKind.Document
    )!;
    const onAdd = vi.fn();
    renderBoard({
      defaultKind: ArtifactKind.Document,
      groupBy: "status",
      groups: [
        {
          items: [{ ...document, status: ArtifactStatus.Draft }],
          key: ARTIFACT_STATUS_ROOT.InProgress,
          label: "In progress",
        },
        { items: [], key: ARTIFACT_STATUS_ROOT.InReview, label: "In review" },
        { items: [], key: ARTIFACT_STATUS_ROOT.Done, label: "Done" },
      ],
      noun: { plural: "documents", singular: "document" },
      onAdd,
    });

    expect(
      screen.getAllByRole("button", { name: "Add document" })
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Add document" }));
    expect(onAdd).toHaveBeenCalledWith(ArtifactStatus.InReview);
  });

  it("refuses an owner lane the shared group mutation cannot map", async () => {
    const onGroupDrop = vi.fn();
    renderBoard({
      groups: [{ items: [issue], key: "No value", label: "Unassigned" }],
      onGroupDrop,
    });
    const user = await openActions(issue.title);
    await user.click(
      screen.getByRole("menuitem", { name: "Move to Unassigned" })
    );
    expect(onGroupDrop).not.toHaveBeenCalled();
  });
});

describe("CT-15 migrated ArtifactStatusBoard interaction coverage", () => {
  it("opens only from the semantic title control while card keys select", async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();
    const { props } = renderBoard({ onSelectionChange });
    const title = screen.getByRole("button", { name: issue.title });
    await user.click(title);
    fireEvent.keyDown(card(issue.title), { key: "Enter" });
    fireEvent.keyDown(card(issue.title), { key: " " });
    fireEvent.keyDown(card(issue.title), { key: "a" });
    expect(props.onOpen).toHaveBeenCalledTimes(1);
    expect(props.onOpen).toHaveBeenLastCalledWith(issue);
    expect(onSelectionChange).toHaveBeenCalledTimes(2);
  });

  it("renders the title as a link when an href is resolved without opening the card", async () => {
    const user = userEvent.setup();
    const { props } = renderBoard({
      onOpenHref: (artifact) => `/artifacts/${artifact.id}`,
    });
    const link = screen.getByRole("link", { name: issue.title });
    expect(link).toHaveAttribute("href", "/artifacts/issue-1");
    await user.click(link);
    expect(props.onOpen).not.toHaveBeenCalled();
  });

  it("shows the comment count only when there are comments", () => {
    renderBoard({
      groups: [
        { items: [issue, branch], key: issue.owner, label: issue.owner },
      ],
    });
    expect(card(issue.title)).toHaveTextContent("3");
    expect(
      card(branch.title).querySelector('[data-artifact-board-field="comments"]')
    ).toBeNull();
  });

  it("offers every kind option and moves to the selected one", async () => {
    const { props } = renderBoard();
    const user = await openActions(issue.title);
    expect(
      screen.getByRole("menuitem", {
        name: `Move to ${genericArtifactStatusLabel(issue)}`,
      })
    ).toHaveAttribute("aria-disabled", "true");
    await user.click(
      screen.getAllByRole("menuitem", { name: "Move to Done" })[0]!
    );
    expect(props.onStatusChange).toHaveBeenCalledWith(
      issue.id,
      ArtifactStatus.Done
    );
  });

  it("explains a surface-level read-only board with its source label or the default", async () => {
    const first = renderBoard({
      config: { editable: false, sourceLabel: "Managed in Linear" },
    });
    await openActions(issue.title);
    expect(screen.getByText("Managed in Linear")).toBeVisible();
    first.unmount();
    renderBoard({ config: { editable: false } });
    await openActions(issue.title);
    expect(screen.getByText("Status is source-managed")).toBeVisible();
  });

  it("lets any row use lane movement when status grouping is inactive", async () => {
    renderBoard({
      config: { editable: false },
      groups: [
        { items: [issue, branch], key: issue.owner, label: issue.owner },
      ],
    });
    await openActions(branch.title);
    expect(
      screen.getByRole("menuitem", { name: `Move to ${issue.owner}` })
    ).toBeEnabled();
  });

  it("renders nothing for a status lane key with no canonical facet", () => {
    renderBoard({
      groupBy: "status",
      groups: [{ items: [issue], key: "not-a-root", label: "Mystery" }],
    });
    expect(screen.queryByText("Mystery")).toBeNull();
    expect(screen.queryByText(issue.title)).toBeNull();
  });

  it("derives owner lanes with initials, counts, and empty destinations", () => {
    const [ottilie] = EDITABLE_OWNERS;
    const groups: GridTableGroup<GenericArtifact>[] = [
      {
        items: [issue],
        key: ARTIFACT_STATUS_ROOT.Todo,
        label: "Todo",
        subgroups: [
          { items: [issue], key: ottilie.name, label: ottilie.name },
          { items: [], key: "No value", label: "Unassigned" },
        ],
      },
    ];
    renderBoard({ groupBy: "status", groups, secondaryGroupBy: "owner" });
    expect(
      within(
        screen.getByRole("group", { name: `Todo · ${ottilie.name}` })
      ).getByText("1")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: "Todo · Unassigned" })
    ).toHaveTextContent("0");
  });

  it("uses status subgroups as lanes without owner-avatar lane decoration", () => {
    renderBoard({
      groups: [
        {
          items: [issue],
          key: issue.owner,
          label: issue.owner,
          subgroups: [
            { items: [issue], key: ARTIFACT_STATUS_ROOT.Todo, label: "Todo" },
          ],
        },
      ],
      secondaryGroupBy: "status",
    });
    expect(
      screen.getByRole("group", { name: `${issue.owner} · Todo` })
    ).toBeVisible();
    expect(card(issue.title)).toBeInTheDocument();
  });

  it("admits a movable card target and invokes one group move", async () => {
    const onGroupDrop = vi.fn();
    renderBoard({
      groupBy: "status",
      groups: [
        { items: [issue], key: ARTIFACT_STATUS_ROOT.Todo, label: "Todo" },
        { items: [], key: ARTIFACT_STATUS_ROOT.Done, label: "Done" },
      ],
      onGroupDrop,
    });
    const user = await openActions(issue.title);
    await user.click(
      screen.getAllByRole("menuitem", { name: "Move to Done" }).at(-1)!
    );
    expect(onGroupDrop).toHaveBeenCalledTimes(1);
  });

  it("does not move a read-only row into another status lane", async () => {
    const onGroupDrop = vi.fn();
    renderBoard({
      groupBy: "status",
      groups: [
        { items: [branch], key: ARTIFACT_STATUS_ROOT.Todo, label: "Todo" },
        { items: [], key: ARTIFACT_STATUS_ROOT.Done, label: "Done" },
      ],
      onGroupDrop,
    });
    await openActions(branch.title);
    expect(screen.queryByRole("menuitem", { name: "Move to Done" })).toBeNull();
    expect(onGroupDrop).not.toHaveBeenCalled();
  });

  it("passes the secondary axis through a two-axis move", async () => {
    const [ottilie, pascoe] = EDITABLE_OWNERS;
    const onGroupDrop = vi.fn();
    renderBoard({
      groupBy: "status",
      groups: [
        {
          items: [issue],
          key: ARTIFACT_STATUS_ROOT.Todo,
          label: "Todo",
          subgroups: [
            { items: [issue], key: ottilie.name, label: ottilie.name },
          ],
        },
        {
          items: [],
          key: ARTIFACT_STATUS_ROOT.Done,
          label: "Done",
          subgroups: [{ items: [], key: pascoe.name, label: pascoe.name }],
        },
      ],
      onGroupDrop,
      secondaryGroupBy: "owner",
    });
    const user = await openActions(issue.title);
    await user.click(
      screen.getByRole("menuitem", { name: `Move to Done · ${pascoe.name}` })
    );
    expect(onGroupDrop).toHaveBeenCalledWith(
      issue.id,
      "status",
      ARTIFACT_STATUS_ROOT.Done,
      "owner",
      pascoe.name
    );
  });
});

function renderBoardProps(overrides: Partial<BoardProps>): BoardProps {
  return {
    config: { editable: true },
    defaultKind: ArtifactKind.Issue,
    groupBy: "owner",
    groups: [{ items: [issue], key: issue.owner, label: issue.owner }],
    noun: { plural: "artifacts", singular: "artifact" },
    onGroupDrop: vi.fn(),
    onOpen: vi.fn(),
    onStatusChange: vi.fn(),
    secondaryGroupBy: "none",
    ...overrides,
  };
}

function WithNavigation({ children }: { children: ReactNode }) {
  const [navigation] = useState(() => createMemoryNavigation());
  return (
    <NavigationProvider adapter={navigation.adapter}>
      {children}
    </NavigationProvider>
  );
}
