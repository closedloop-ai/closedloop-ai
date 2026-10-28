import assert from "node:assert/strict";
import {
  ProjectArtifactPlacementKind,
  ProjectArtifactPlacementPosition,
  ProjectArtifactPlacementSource,
} from "@repo/api/src/types/project-artifact-placement";
import { test, vi } from "vitest";
import {
  createHarness,
  NOT_ALLOWLISTED_ERROR,
  UNTRUSTED_EVENT,
} from "./cloud-api-fetch-ipc-test-harness.js";

const PROJECT_ID = "00000000-0000-4000-8000-000000000002";
const ARTIFACT_ID = "00000000-0000-4000-8000-000000000003";
const PLACEMENT_PATH = `/projects/${PROJECT_ID}/artifacts/placement`;
const HIERARCHY_PATH = `/projects/${PROJECT_ID}/artifacts/hierarchy-transactions`;
const UNTRUSTED_SENDER_PATTERN = /untrusted sender/;
const body = JSON.stringify({
  kind: ProjectArtifactPlacementKind.Place,
  sourceArtifactIds: [ARTIFACT_ID],
  destinationProjectId: PROJECT_ID,
  position: ProjectArtifactPlacementPosition.Root,
  expectedProjectVersions: { [PROJECT_ID]: "v1" },
  idempotencyKey: "placement-1",
  source: ProjectArtifactPlacementSource.Api,
});

test("placement writes retain the cloud bridge trusted-sender gate", async () => {
  const { invoke, fetchCalls } = createHarness();

  await assert.rejects(
    async () =>
      await invoke(
        { path: PLACEMENT_PATH, method: "POST", body },
        UNTRUSTED_EVENT
      ),
    UNTRUSTED_SENDER_PATTERN
  );
  assert.equal(fetchCalls.length, 0);
});

test("placement allowlisting requires the strict UUID route", async () => {
  const { invoke, fetchCalls } = createHarness();

  const result = await invoke({
    path: "/projects/------------------------------------/artifacts/placement",
    method: "POST",
    body,
  });

  assert.equal(result.kind, "network-error");
  if (result.kind === "network-error") {
    assert.match(result.message, NOT_ALLOWLISTED_ERROR);
  }
  assert.equal(fetchCalls.length, 0);
});

test("an offline placement fails through the online cloud transport", async () => {
  const { invoke } = createHarness({
    fetchImpl: () => Promise.reject(new Error("offline")),
  });

  const result = await invoke({ path: PLACEMENT_PATH, method: "POST", body });

  assert.equal(result.kind, "network-error");
});

test("a missing access token sends no placement request", async () => {
  const getAccessToken = vi.fn(() => Promise.resolve(null));
  const { invoke, fetchCalls } = createHarness({
    getAccessToken,
  });

  const result = await invoke({ path: PLACEMENT_PATH, method: "POST", body });

  assert.equal(result.kind, "response");
  if (result.kind === "response") {
    assert.equal(result.status, 401);
  }
  assert.equal(fetchCalls.length, 0);
  assert.equal(getAccessToken.mock.calls.length, 1);
});

test("flag-off hierarchy writes reach the cloud bridge through the exact trusted route", async () => {
  const { invoke, fetchCalls } = createHarness();
  const result = await invoke({
    path: HIERARCHY_PATH,
    method: "POST",
    body,
  });
  assert.equal(result.kind, "response");
  assert.equal(fetchCalls.length, 1);
});

test("flag-off hierarchy route retains sender trust and strict UUID matching", async () => {
  const { invoke, fetchCalls } = createHarness();
  await assert.rejects(
    async () =>
      await invoke(
        { path: HIERARCHY_PATH, method: "POST", body },
        UNTRUSTED_EVENT
      ),
    UNTRUSTED_SENDER_PATTERN
  );
  const result = await invoke({
    path: "/projects/------------------------------------/artifacts/hierarchy-transactions",
    method: "POST",
    body,
  });
  assert.equal(result.kind, "network-error");
  if (result.kind === "network-error") {
    assert.match(result.message, NOT_ALLOWLISTED_ERROR);
  }
  assert.equal(fetchCalls.length, 0);
});

test("flag-off hierarchy request fails through the online transport when offline", async () => {
  const { invoke } = createHarness({
    fetchImpl: () => Promise.reject(new Error("offline")),
  });
  const result = await invoke({ path: HIERARCHY_PATH, method: "POST", body });
  assert.equal(result.kind, "network-error");
});
