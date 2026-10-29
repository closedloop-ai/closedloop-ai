import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  ActivityFeedActorKind,
  ActivityFeedItemSource,
} from "@repo/api/src/types/artifact-activity-feed.ts";
import { BranchTraceCompletenessState } from "@repo/api/src/types/branch-trace.ts";
import {
  DocumentStatus,
  DocumentType,
  SnapshotSource,
} from "@repo/api/src/types/document.ts";
import { RELATED_SESSIONS_EMPTY_MESSAGE } from "@repo/app/documents/lib/related-sessions-labels.ts";
import type { DesktopApi } from "../../src/renderer/types/desktop-api";
import {
  AUTHENTICATED_ORGANIZATION_ID,
  AUTHENTICATED_USER_ID,
  closeServer,
  writeApiResult,
} from "./helpers/branch-details-authenticated-cloud";
import { gotoHash } from "./helpers/desktop-app";
import {
  currentHashRoute,
  launchShellSidebarApp,
  seedShellSidebarSession,
  startNavigationCloudServer,
} from "./helpers/shell-navigation-cloud";

// Canonical PostHog keys; Electron specs cannot load extensionless workspace subpaths.
const FLAGS = {
  labsNav: true,
  "documents-nav": true,
  "shell-sidebar-v2": true,
  "documents-universal-list": true,
};
const DOCUMENT_ID = "18400000-0000-4000-8000-000000000001";
const DOCUMENT_TITLE = "Native document routing runbook";
const NOW = new Date().toISOString();
const DOCUMENT = {
  id: DOCUMENT_ID,
  organizationId: AUTHENTICATED_ORGANIZATION_ID,
  projectId: null,
  type: DocumentType.Doc,
  title: DOCUMENT_TITLE,
  slug: "DOC-184",
  fileName: null,
  status: DocumentStatus.Draft,
  priority: null,
  latestVersion: 2,
  createdById: AUTHENTICATED_USER_ID,
  assigneeId: null,
  assignee: null,
  approverId: null,
  approver: null,
  repositorySnapshot: { source: SnapshotSource.None, repositories: [] },
  templateForType: null,
  sortOrder: null,
  createdAt: NOW,
  updatedAt: NOW,
};

test("opens Documents from Artifacts, follows a native document link and restores the listing", async () => {
  test.setTimeout(120_000);
  const server = await startNavigationCloudServer({
    featureFlags: FLAGS,
    extraRoutes: routeDocuments,
  });
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-documents-native-")
  );
  try {
    await seedShellSidebarSession(userDataDir);
    const { app, page, pageErrors, cleanup } = await launchShellSidebarApp({
      apiOrigin: server.origin,
      flags: FLAGS,
      profileId: "documents-native",
      profileName: "Documents native E2E",
      userDataDir,
    });
    try {
      await app.evaluate(() => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (input, init) => {
          if (
            String(input) === "https://document-assets.closedloop.test/upload"
          ) {
            return Promise.resolve(
              new Response(init?.body, {
                headers: { "Content-Type": "application/octet-stream" },
              })
            );
          }
          if (
            String(input) === "https://document-assets.closedloop.test/image"
          ) {
            return Promise.resolve(
              new Response(
                Buffer.from(
                  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXz8AAAAASUVORK5CYII=",
                  "base64"
                ),
                { headers: { "Content-Type": "image/png" } }
              )
            );
          }
          return originalFetch(input, init);
        };
      });
      const assetProof = await page.evaluate(async (documentId) => {
        const result = await (window.desktopApi as DesktopApi).cloudApiFetch({
          method: "POST",
          path: `/documents/${documentId}/attachments`,
          body: "{}",
        });
        if (result.kind !== "response") {
          throw new Error("Attachment request failed");
        }
        const asset = JSON.parse(result.bodyText).data;
        const upload = await fetch(asset.uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: new Uint8Array([1, 2, 3]),
        });
        const bytes = Array.from(new Uint8Array(await upload.arrayBuffer()));
        const image = document.createElement("img");
        image.src = asset.previewUrl;
        document.body.append(image);
        await image.decode();
        const width = image.naturalWidth;
        image.remove();
        return {
          bytes,
          width,
          uploadUrl: asset.uploadUrl,
          previewUrl: asset.previewUrl,
        };
      }, DOCUMENT_ID);
      expect(assetProof.bytes).toEqual([1, 2, 3]);
      expect(assetProof.width).toBe(1);
      expect(assetProof.uploadUrl).toMatch(nativeAssetUrlPattern);
      expect(assetProof.previewUrl).toMatch(nativeAssetUrlPattern);
      await gotoHash(page, "/dashboard");
      await page.getByRole("link", { name: "Documents", exact: true }).click();
      await expect.poll(() => currentHashRoute(page)).toBe("/documents");
      const documentLink = page
        .locator(`a[href="#/documents/DOC-184"]`)
        .filter({ hasText: DOCUMENT_TITLE });
      await expect(documentLink).toBeVisible({ timeout: 30_000 });
      await expect(documentLink).toHaveAttribute("href", "#/documents/DOC-184");
      await page.screenshot({
        path: test.info().outputPath("documents-native-listing.png"),
      });
      await documentLink.click();
      await expect
        .poll(() => currentHashRoute(page))
        .toBe("/documents/DOC-184");
      for (const label of ["Artifact", "Sessions", "Details", "Activity"]) {
        await expect(
          page.getByRole("tab", { name: label, exact: true })
        ).toBeVisible({ timeout: 30_000 });
      }
      await gotoHash(page, "/documents/DOC-184?version=1");
      await expect(
        page.getByText("Document content.", { exact: true })
      ).toBeVisible({ timeout: 30_000 });
      await page.screenshot({
        path: test.info().outputPath("documents-native-artifact.png"),
      });
      await page.getByRole("tab", { name: "Sessions", exact: true }).click();
      await expect(
        page.getByRole("tab", { name: "Sessions", exact: true })
      ).toHaveAttribute("aria-selected", "true");
      await expect
        .poll(() => page.evaluate(() => globalThis.location.hash))
        .toContain("tab=sessions");
      await expect
        .poll(() => page.evaluate(() => globalThis.location.hash))
        .toContain("version=1");
      await expect(
        page.getByText(RELATED_SESSIONS_EMPTY_MESSAGE)
      ).toBeVisible();
      await page.screenshot({
        path: test.info().outputPath("documents-native-sessions.png"),
      });
      await page.getByRole("tab", { name: "Details", exact: true }).click();
      await expect
        .poll(() => page.evaluate(() => globalThis.location.hash))
        .toContain("tab=details");
      await expect(page.getByTestId("document-editor-details")).toBeVisible();
      await page.getByRole("tab", { name: "Activity", exact: true }).click();
      await expect(
        page.getByRole("tab", { name: "Activity", exact: true })
      ).toHaveAttribute("aria-selected", "true");
      const activity = page.getByRole("list", {
        name: "Activity",
        exact: true,
      });
      await expect(activity).toBeVisible();
      await expect(activity.getByText("v2", { exact: true })).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => globalThis.location.hash))
        .toContain("tab=activity");
      await expect
        .poll(() => page.evaluate(() => globalThis.location.hash))
        .toContain("version=1");
      await page.screenshot({
        path: test.info().outputPath("documents-native-activity.png"),
      });
      await page.getByRole("tab", { name: "Artifact", exact: true }).click();
      await expect(
        page.getByRole("tab", { name: "Artifact", exact: true })
      ).toHaveAttribute("aria-selected", "true");
      await expect(
        page.getByText("Document content.", { exact: true })
      ).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => globalThis.location.hash))
        .toContain("version=1");
      await page
        .getByRole("navigation", { name: "breadcrumb" })
        .getByRole("link", { name: "Documents", exact: true })
        .click();
      await expect.poll(() => currentHashRoute(page)).toBe("/documents");
      await expect(documentLink).toBeVisible();
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  } finally {
    await closeServer(server.server);
    fs.rmSync(userDataDir, { force: true, recursive: true });
  }
});

function routeDocuments(
  request: IncomingMessage,
  response: ServerResponse
): boolean {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/desktop/identity") {
    writeApiResult(response, {
      userId: AUTHENTICATED_USER_ID,
      organizationId: AUTHENTICATED_ORGANIZATION_ID,
      email: "ada@closedloop.ai",
      firstName: "Ada",
      lastName: "Lovelace",
      organizationName: "Closedloop",
      organizationSlug: "closedloop-ai",
    });
    return true;
  }
  if (
    url.pathname === `/documents/${DOCUMENT_ID}/attachments` &&
    request.method === "POST"
  ) {
    writeApiResult(response, {
      uploadUrl: "https://document-assets.closedloop.test/upload",
      previewUrl: "https://document-assets.closedloop.test/image",
    });
    return true;
  }
  if (url.pathname === "/documents") {
    writeApiResult(response, [DOCUMENT]);
    return true;
  }
  if (url.pathname === "/documents/by-slug/DOC-184") {
    const version = url.searchParams.get("version") === "1" ? 1 : 2;
    writeApiResult(response, {
      ...DOCUMENT,
      version: {
        id: `version-${version}`,
        documentId: DOCUMENT_ID,
        version,
        content: "# Native routing\n\nDocument content.",
        createdAt: NOW,
        createdById: AUTHENTICATED_USER_ID,
      },
      latestVersionContent: "# Native routing\n\nDocument content.",
    });
    return true;
  }
  if (url.pathname === `/documents/${DOCUMENT_ID}/sessions`) {
    writeApiResult(response, {
      detail: {
        id: DOCUMENT_ID,
        sessions: [],
        mergedTrace: [],
        estimatedCostUsd: null,
        attributedCostUsd: null,
      },
      trace: {
        items: [],
        sessions: [],
        qualifyingSessionCount: 0,
        completeness: { state: BranchTraceCompletenessState.Complete },
        aggregateCompleteness: { state: BranchTraceCompletenessState.Complete },
      },
    });
    return true;
  }
  if (url.pathname === `/documents/${DOCUMENT_ID}/activity`) {
    writeApiResult(response, {
      nextCursor: null,
      items: [
        {
          id: "version:documents-native-e2e",
          source: ActivityFeedItemSource.VersionCreated,
          action: null,
          actor: { kind: ActivityFeedActorKind.System, id: null },
          before: null,
          after: null,
          payload: { version: 2 },
          createdAt: NOW,
        },
      ],
    });
    return true;
  }
  if (url.pathname === "/documents/costs") {
    writeApiResult(response, {
      artifacts: [{ artifactId: DOCUMENT_ID }],
      sessionCosts: [],
    });
    return true;
  }
  if (
    url.pathname === "/users" ||
    url.pathname === "/projects" ||
    url.pathname.startsWith(`/documents/${DOCUMENT_ID}/versions`) ||
    url.pathname.startsWith(`/documents/${DOCUMENT_ID}/pull-request`)
  ) {
    writeApiResult(response, []);
    return true;
  }
  if (url.pathname === "/artifact-links/resolved") {
    writeApiResult(response, []);
    return true;
  }
  return false;
}

const nativeAssetUrlPattern = /^app:\/\/renderer\/document-assets\//;
