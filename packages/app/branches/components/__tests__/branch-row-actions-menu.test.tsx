import {
  BranchDataState,
  BranchTagAvailability,
} from "@repo/api/src/types/branch";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import type { BranchRowActionPolicyInput } from "../../lib/branch-action-policy";
import { type BranchRow, BranchRowStatus } from "../../lib/branch-row";
import { BranchRowActionsMenu } from "../branch-row-actions-menu";

const FORBIDDEN_RE = /issues|docs|agents/i;
const VIEW_SESSIONS_RE = /view linked sessions/i;
const SHIMMED_ELEMENT_METHODS = [
  "hasPointerCapture",
  "setPointerCapture",
  "releasePointerCapture",
  "scrollIntoView",
] as const;
const originalElementDescriptors = new Map<
  string,
  PropertyDescriptor | undefined
>();

const baseItem: BranchRow = {
  id: "11111111-1111-4111-8111-111111111111",
  branchName: "agent/x",
  baseBranch: "main",
  repo: "acme/web",
  owner: "Alex",
  status: BranchRowStatus.Open,
  dataState: BranchDataState.Ready,
  prNumber: 42,
  prTitle: "t",
  prUrl: "https://github.com/acme/web/pull/42",
  prState: "OPEN",
  checksPassed: 12,
  checksTotal: 12,
  checksStatus: "PASSING",
  behind: 1,
  ahead: 2,
  additions: 10,
  deletions: 5,
  sessionCount: 3,
  commentCount: null,
  lastActivityLabel: "2h ago",
};

beforeAll(() => {
  for (const method of SHIMMED_ELEMENT_METHODS) {
    originalElementDescriptors.set(
      method,
      Object.getOwnPropertyDescriptor(Element.prototype, method)
    );
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => undefined;
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => undefined;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => undefined;
  }
});

afterAll(() => {
  for (const method of SHIMMED_ELEMENT_METHODS) {
    const descriptor = originalElementDescriptors.get(method);
    if (descriptor) {
      Object.defineProperty(Element.prototype, method, descriptor);
    } else {
      Reflect.deleteProperty(Element.prototype, method);
    }
  }
});

describe("BranchRowActionsMenu", () => {
  it("preserves the shipped action set when enhanced policy is absent", async () => {
    const user = userEvent.setup();
    renderMenu();

    await openMenu(user);
    expect(screen.getByText("Copy branch name")).toBeInTheDocument();
    expect(screen.getByText("Open PR")).toBeInTheDocument();
    expect(screen.queryByText("Sync")).not.toBeInTheDocument();
    expect(screen.queryByText("Edit tags")).not.toBeInTheDocument();
    expect(screen.queryByText("Review")).not.toBeInTheDocument();
    expect(screen.queryByText("Comment")).not.toBeInTheDocument();
    expect(screen.queryByText("Move")).not.toBeInTheDocument();
    expect(screen.queryByText("Open detail")).not.toBeInTheDocument();
    expect(screen.queryByText(VIEW_SESSIONS_RE)).not.toBeInTheDocument();
    expect(screen.queryByText(FORBIDDEN_RE)).not.toBeInTheDocument();
  });

  it("shows and fires Open detail when the handler is provided", async () => {
    const user = userEvent.setup();
    const onOpenDetail = vi.fn();
    renderMenu({ onOpenDetail });

    await openMenu(user);
    await user.click(screen.getByText("Open detail"));
    expect(onOpenDetail).toHaveBeenCalledWith(baseItem);
  });

  it("does not add tag or move items even when row mutation facts allow them", async () => {
    const user = userEvent.setup();
    const item = {
      ...baseItem,
      artifactId: "artifact-1",
      tagAvailability: BranchTagAvailability.Available,
      tagPermissions: { canApply: true, canRemove: true },
      tags: [],
    };
    renderMenu({ actionPolicyInput: policyInput(item), item });

    await openMenu(user);
    expect(screen.queryByRole("menuitem", { name: "Edit tags" })).toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: "Move to Project" })
    ).toBeNull();
    expect(
      screen.getByRole("menuitem", { name: "Copy branch name" })
    ).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: "Open PR" })).toBeEnabled();
  });

  it("renders View linked sessions as a link to getSessionsHref when supplied", async () => {
    const user = userEvent.setup();
    const navigation = createMemoryNavigation({ initialPath: "/branches" });
    renderMenu({
      getSessionsHref: (item) =>
        `/branches/${encodeURIComponent(item.id)}?tab=sessions-timeline`,
      item: { ...baseItem, id: "acme%2Fweb::feature" },
      navigationAdapter: navigation.adapter,
    });

    await openMenu(user);
    expect(
      screen.getByRole("menuitem", { name: VIEW_SESSIONS_RE })
    ).toHaveAttribute(
      "href",
      "/branches/acme%252Fweb%3A%3Afeature?tab=sessions-timeline"
    );
  });

  it("hides View linked sessions on a 0-count row even with a href factory", async () => {
    const user = userEvent.setup();
    renderMenu({
      getSessionsHref: (item) => `/branches/${item.id}`,
      item: { ...baseItem, sessionCount: 0 },
    });

    await openMenu(user);
    expect(screen.queryByText(VIEW_SESSIONS_RE)).not.toBeInTheDocument();
  });

  it("disables Open PR when the row has no PR", async () => {
    const user = userEvent.setup();
    renderMenu({ item: { ...baseItem, prNumber: null, prUrl: null } });

    await openMenu(user);
    expect(screen.getByRole("menuitem", { name: "Open PR" })).toHaveAttribute(
      "data-disabled"
    );
  });

  it("fails an explicitly unknown enhanced policy input closed", async () => {
    const user = userEvent.setup();
    renderMenu({
      actionPolicyInput: { connectionState: "future" },
      getSessionsHref: (item) => `/branches/${item.id}`,
      onOpenDetail: vi.fn(),
    });

    await openMenu(user);
    expect(screen.queryByText("Open detail")).not.toBeInTheDocument();
    expect(screen.queryByText(VIEW_SESSIONS_RE)).not.toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Copy branch name" })
    ).toHaveAttribute("data-disabled");
    expect(screen.getByRole("menuitem", { name: "Open PR" })).toHaveAttribute(
      "data-disabled"
    );
    expect(screen.queryByText("Sync")).not.toBeInTheDocument();
    expect(screen.queryByText("Review")).not.toBeInTheDocument();
    expect(screen.queryByText("Comment")).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Edit tags" })).toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: "Move to Project" })
    ).toBeNull();
  });
});

type RenderMenuOptions = {
  actionPolicyInput?: unknown;
  getSessionsHref?: (item: BranchRow) => string;
  item?: BranchRow;
  navigationAdapter?: ReturnType<typeof createMemoryNavigation>["adapter"];
  onOpenDetail?: (item: BranchRow) => void;
};

function renderMenu({
  actionPolicyInput,
  getSessionsHref,
  item = baseItem,
  navigationAdapter,
  onOpenDetail,
}: RenderMenuOptions = {}) {
  const menu = (
    <BranchRowActionsMenu
      actionPolicyInput={actionPolicyInput}
      getSessionsHref={getSessionsHref}
      item={item}
      onOpenDetail={onOpenDetail}
    />
  );
  return render(
    <AppCoreStoryProviders navigationAdapter={navigationAdapter}>
      {menu}
    </AppCoreStoryProviders>
  );
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Branch actions" }));
  await screen.findByRole("menu");
}

function policyInput(
  item: BranchRow,
  overrides: Partial<BranchRowActionPolicyInput> = {}
): BranchRowActionPolicyInput {
  return {
    hasArtifactIdentity: Boolean(item.artifactId),
    hasDetailRoute: true,
    hasSessionsRoute: true,
    hostCanMutate: true,
    prNumber: item.prNumber,
    prUrl: item.prUrl,
    sessionCount: item.sessionCount,
    supportsTags: true,
    tagAvailability: item.tagAvailability,
    tagPermissions: item.tagPermissions,
    ...overrides,
  };
}
