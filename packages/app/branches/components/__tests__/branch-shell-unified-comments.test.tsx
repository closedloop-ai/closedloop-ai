import { commentApiPaths } from "@repo/api/src/types/comment-thread-dto";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import { render, screen, waitFor } from "@testing-library/react";
import { createRef, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { FULL_CAPABILITIES } from "../../../shared/components/comments/comments-pane.fixtures";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import { BranchesDataSourceProvider } from "../../data-source/provider";
import { BranchShellView } from "../branch-shell-view";
import {
  baseProps,
  inertBranchesDataSource,
  makeDetail,
} from "./branch-detail-page.fixtures";

/** The pane's heading carries its count, so it is matched by its leading word. */
const COMMENTS_HEADING = /^Comments/;

const BRANCH_ARTIFACT_ID = "branch-artifact-1";
const DETAIL = makeDetail({ artifactId: BRANCH_ARTIFACT_ID, id: "b-1" });

/**
 * PLN-2162 M6: the Branch shell, through the pane it mounts, reads the Branch
 * artifact's comments from the unified API. It mounts the shell directly; the
 * `artifact-detail-shell` swap at each host is not exercised here.
 */
describe("Branch shell unified comments read", () => {
  it("reads the Branch artifact's unified comments under the shell", async () => {
    const requested = renderBody(
      <BranchShellView {...openProps()} detail={DETAIL} />
    );

    await waitFor(() =>
      expect(requested).toContain(
        commentApiPaths.artifactComments(BRANCH_ARTIFACT_ID)
      )
    );
    expect(
      await screen.findByRole("heading", { name: COMMENTS_HEADING })
    ).toBeVisible();
  });
});

function openProps() {
  return baseProps({
    commentsControl: {
      onOpenChange: vi.fn(),
      open: true,
      toggleRef: createRef(),
    },
  });
}

function renderBody(ui: ReactElement): string[] {
  const requested: string[] = [];
  const unifiedRead: FixtureRoute = {
    method: "GET",
    path: "/artifacts/*",
    respond: ({ pathname }) => {
      requested.push(pathname);
      return {
        artifactId: BRANCH_ARTIFACT_ID,
        capabilities: FULL_CAPABILITIES,
        nextCursor: null,
        threads: [],
      };
    },
  };
  render(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <AppCoreStoryProviders apiRoutes={[unifiedRead]}>
        <BranchesDataSourceProvider dataSource={inertBranchesDataSource()}>
          {children}
        </BranchesDataSourceProvider>
      </AppCoreStoryProviders>
    ),
  });
  return requested;
}
