import assert from "node:assert/strict";
import { encodeBranchId } from "@repo/api/src/types/branch.js";
import { test } from "vitest";
import { resolveSessionBranchRouteId } from "../src/main/session/session-branch-route.js";

const sessionId = "session-local-publication";
const branchName = "feature/local";
const repoFullName = "acme/web";

test("session Branch route links a published local row with no cloud resolver", async () => {
  const routeId = await resolveSessionBranchRouteId({
    source: {
      loadSessionBranchLinkKeys: () => [
        { repoFullName, branchName, hasLocalPublication: true },
      ],
    },
    sessionId,
    branch: branchName,
    displayedRepositoryFullName: repoFullName,
  });
  assert.equal(routeId, encodeBranchId({ repoFullName, branchName }));
});

test("session Branch route leaves an unpublished commit-only row plain text", async () => {
  const routeId = await resolveSessionBranchRouteId({
    source: {
      loadSessionBranchLinkKeys: () => [
        { repoFullName, branchName, hasLocalPublication: false },
      ],
    },
    sessionId,
    branch: branchName,
    displayedRepositoryFullName: repoFullName,
  });
  assert.equal(routeId, undefined);
});
