import {
  ActivityFeedActorKind,
  ActivityFeedItemSource,
} from "@repo/api/src/types/artifact-activity-feed";
import type { DocumentDetail } from "@repo/api/src/types/document";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import { DocumentShellActivity } from "../document-shell-activity";

const document: DocumentDetail = {
  ...createMockDocument(),
  latestVersionContent: "Saved content",
  version: {
    id: "version-1",
    documentId: "artifact-123",
    version: 1,
    content: "Saved content",
    createdById: "user-1",
    createdAt: new Date("2024-01-15T10:00:00Z"),
  },
};

function event(id: string, version: number) {
  return {
    id,
    source: ActivityFeedItemSource.VersionCreated,
    action: null,
    actor: { kind: ActivityFeedActorKind.System, id: null },
    before: null,
    after: null,
    payload: { version },
    createdAt: new Date("2026-10-08T10:00:00Z"),
  };
}

describe("DocumentShellActivity", () => {
  test("reads this document's feed and appends older rows using its opaque cursor", async () => {
    const user = userEvent.setup();
    const respond = vi.fn(
      ({ searchParams }: { searchParams: URLSearchParams }) =>
        searchParams.get("cursor") === "older-page"
          ? { items: [event("version:older", 1)], nextCursor: null }
          : { items: [event("version:newer", 2)], nextCursor: "older-page" }
    );
    render(
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "GET",
            path: `/documents/${document.id}/activity`,
            respond,
          },
        ]}
      >
        <DocumentShellActivity document={document} />
      </AppCoreStoryProviders>
    );
    expect(
      await screen.findByRole("list", { name: "Activity" })
    ).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByText("v1");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(respond.mock.calls[1][0].searchParams.get("cursor")).toBe(
      "older-page"
    );
    expect(
      screen.queryByRole("button", { name: "Load more" })
    ).not.toBeInTheDocument();
  });

  test("a failed read renders the reusable error state rather than empty history", async () => {
    render(
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "GET",
            path: `/documents/${document.id}/activity`,
            status: 500,
            respond: () => null,
          },
        ]}
      >
        <DocumentShellActivity document={document} />
      </AppCoreStoryProviders>
    );
    expect(
      await screen.findByText("Couldn't load activity")
    ).toBeInTheDocument();
    expect(screen.queryByText("No activity yet")).not.toBeInTheDocument();
  });
});
