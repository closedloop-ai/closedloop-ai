import assert from "node:assert/strict";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { Priority } from "@repo/api/src/types/common";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { TagEntityType } from "@repo/api/src/types/tag";
import { test } from "vitest";
import {
  API_ORIGIN,
  createHarness,
} from "./cloud-api-fetch-ipc-test-harness.js";

/**
 * ISS-10995: the Cloud-mode Session and Branch Details tabs write Tags through
 * `POST` / `DELETE /entity-tags`, and the bridge admits a Session `projectId`
 * body on the single artifact `PATCH`. It admits exactly those and nothing
 * around them.
 *
 * Both Details tabs now draw a Project row (operator ruling 2026-10-12), and
 * both write it through `POST /artifact-links/batch-move`, already admitted by
 * `BATCH_MUTATION_ROUTE_PATTERNS`. So the session `projectId` admission on the
 * single artifact `PATCH` has no current caller; it is PRESERVED AS SHIPPED for
 * the clients already on it (Compatibility Guardrail), not orphaned by a
 * retirement, and removing it needs explicit human approval.
 *
 * Neither half is a path gate alone. `PATCH /agent-sessions/[id]` also
 * reassigns status and owner, and the single entity-tag route takes any
 * `TagEntityType`, none of which the Details tab offers, so a path-only
 * admission would hand a compromised renderer writes no surface asks for over
 * the main-held credential.
 */

const SESSION_ID = "55555555-5555-4555-8555-555555555551";
const BRANCH_ID = "66666666-6666-4666-8666-666666666661";
const PROJECT_ID = "77777777-7777-4777-8777-777777777771";
const TAG_ID = "88888888-8888-4888-8888-888888888881";

const SESSION_PATCH_PATH = `/agent-sessions/${SESSION_ID}`;
const BRANCH_PATCH_PATH = `/branches/${BRANCH_ID}`;
const ATTACH_BODY = JSON.stringify({
  entityId: SESSION_ID,
  entityType: TagEntityType.Artifact,
  surface: ArtifactStatusEditSurface.InlineCell,
  tagId: TAG_ID,
});

function detachQuery(entityType: string): string {
  return `/entity-tags?entityId=${SESSION_ID}&entityType=${entityType}&tagId=${TAG_ID}`;
}

test("admits attaching and detaching one artifact tag", async () => {
  for (const [method, path, body] of [
    ["POST", "/entity-tags", ATTACH_BODY],
    // The detach carries its parameters in the QUERY. The allowlist matches
    // `url.pathname` alone, so `entityType` is read off `url.searchParams` —
    // the case a path-only entry has to get right.
    ["DELETE", detachQuery(TagEntityType.Artifact), undefined],
    [
      "DELETE",
      `${detachQuery(TagEntityType.Artifact)}&surface=${ArtifactStatusEditSurface.Detail}`,
      undefined,
    ],
  ] as const) {
    const { invoke, fetchCalls } = createHarness();

    const result = await invoke({
      path,
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body }),
    });

    assert.equal(result.kind, "response", `${method} ${path} must pass`);
    assert.equal(fetchCalls.length, 1, `${method} ${path} must fetch`);
    assert.equal(fetchCalls[0].url.toString(), `${API_ORIGIN}${path}`);
    assert.equal(fetchCalls[0].init.method, method);
  }
});

test("refuses a PROJECT or LOOP entityType on both halves", async () => {
  // `entityTagValidator` is `z.enum(TagEntityType)`, so the route itself would
  // take these; the Details tab only ever names an artifact, and the bridge
  // forwards a main-held credential (ISS-10995 review).
  for (const entityType of [TagEntityType.Project, TagEntityType.Loop]) {
    for (const [method, path, body] of [
      [
        "POST",
        "/entity-tags",
        JSON.stringify({ entityId: SESSION_ID, entityType, tagId: TAG_ID }),
      ],
      ["DELETE", detachQuery(entityType), undefined],
    ] as const) {
      const { invoke, fetchCalls } = createHarness();

      const result = await invoke({
        path,
        method,
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body }),
      });

      assert.equal(result.kind, "network-error", `${method} ${entityType}`);
      assert.equal(
        fetchCalls.length,
        0,
        `${method} ${entityType} must not fetch`
      );
    }
  }
});

test("refuses an entity-tag write that names no entityType", async () => {
  // The route answers 400 on either shape, so forwarding would spend the
  // credential on a write that cannot land.
  for (const [method, path, body] of [
    [
      "POST",
      "/entity-tags",
      JSON.stringify({ entityId: SESSION_ID, tagId: TAG_ID }),
    ],
    [
      "DELETE",
      `/entity-tags?entityId=${SESSION_ID}&tagId=${TAG_ID}`,
      undefined,
    ],
    ["DELETE", "/entity-tags", undefined],
  ] as const) {
    const { invoke, fetchCalls } = createHarness();

    const result = await invoke({
      path,
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body }),
    });

    assert.equal(result.kind, "network-error", `${method} ${path}`);
    assert.equal(fetchCalls.length, 0, `${method} ${path} must not fetch`);
  }
});

test("refuses an attach body carrying a key the contract does not", async () => {
  const { invoke, fetchCalls } = createHarness();

  const result = await invoke({
    path: "/entity-tags",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      entityId: SESSION_ID,
      entityType: TagEntityType.Artifact,
      organizationId: SESSION_ID,
      tagId: TAG_ID,
    }),
  });

  assert.equal(result.kind, "network-error");
  assert.equal(fetchCalls.length, 0, "must not fetch");
});

test("refuses every other method on the entity-tag route", async () => {
  for (const method of ["PATCH", "PUT"]) {
    const { invoke, fetchCalls } = createHarness();

    const result = await invoke({
      path: "/entity-tags",
      method,
      body: ATTACH_BODY,
    });

    assert.equal(result.kind, "network-error", method);
    assert.equal(fetchCalls.length, 0, `${method} must not fetch`);
  }
});

test("refuses the paths around the entity-tag route", async () => {
  for (const path of [
    "/entity-tags/",
    `/entity-tags/${TAG_ID}`,
    "/entity-tagsx",
  ]) {
    for (const method of ["POST", "DELETE"]) {
      const { invoke, fetchCalls } = createHarness();

      const result = await invoke({
        path,
        method,
        ...(method === "POST" ? { body: ATTACH_BODY } : {}),
      });

      assert.equal(result.kind, "network-error", `${method} ${path}`);
      assert.equal(fetchCalls.length, 0, `${method} ${path} must not fetch`);
    }
  }
});

// ISS-9404 (#8671): the shared Issues/Documents tag picker creates a tag with
// `POST /tags`, admitted on Desktop by operator ruling 2026-10-10. Only that
// exact method and path; deleting a tag or a near-miss path stays refused.
test("admits creating a tag and refuses everything around it", async () => {
  const created = createHarness();
  const createResult = await created.invoke({
    path: "/tags",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "triage" }),
  });
  assert.equal(createResult.kind, "response", "POST /tags must pass");
  assert.equal(created.fetchCalls.length, 1, "POST /tags must fetch");

  for (const [method, path] of [
    ["DELETE", "/tags"],
    ["POST", "/tags/"],
    ["POST", `/tags/${TAG_ID}`],
    ["DELETE", `/tags/${TAG_ID}`],
    ["PUT", "/tags"],
    ["PATCH", "/tags"],
  ] as const) {
    const { invoke, fetchCalls } = createHarness();

    const result = await invoke({
      path,
      method,
      ...(method === "POST" ? { body: JSON.stringify({ name: "x" }) } : {}),
    });

    assert.equal(result.kind, "network-error", `${method} ${path}`);
    assert.equal(fetchCalls.length, 0, `${method} ${path} must not fetch`);
  }
});

test("leaves the batch tag route POST-only", async () => {
  // `/entity-tags/batch` and its v2 are admitted for POST by their own
  // BatchMutationRoute entry. Adding the single route must not have opened
  // them to DELETE.
  for (const path of ["/entity-tags/batch", "/entity-tags/batch/v2"]) {
    const { invoke, fetchCalls } = createHarness();

    const result = await invoke({ path, method: "DELETE" });

    assert.equal(result.kind, "network-error", `DELETE ${path}`);
    assert.equal(fetchCalls.length, 0, `DELETE ${path} must not fetch`);
  }
});

test("admits a session project body, including the clear", async () => {
  for (const body of [
    { projectId: PROJECT_ID },
    { expectedProjectId: null, projectId: PROJECT_ID },
    // The route's own clear: it is tri-state, so `projectId` is nullable here.
    { projectId: null },
  ]) {
    const { invoke, fetchCalls } = createHarness();

    const result = await invoke({
      path: SESSION_PATCH_PATH,
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    assert.equal(result.kind, "response", JSON.stringify(body));
    assert.equal(fetchCalls.length, 1, JSON.stringify(body));
  }
});

test("refuses a project body on the branch path", async () => {
  // `PATCH /branches/[id]` accepts priority alone, so admitting a project body
  // there would spend the main-held credential on a request the server
  // refuses. Branch project writes arrive with `BranchPatchField.ProjectId`.
  const { invoke, fetchCalls } = createHarness();

  const result = await invoke({
    path: BRANCH_PATCH_PATH,
    method: "PATCH",
    body: JSON.stringify({ projectId: PROJECT_ID }),
  });

  assert.equal(result.kind, "network-error");
  assert.equal(fetchCalls.length, 0, "must not fetch");
});

test("refuses a project body carrying anything else", async () => {
  for (const body of [
    // Mixed with another write: `.strict()` plus a required field on each
    // schema makes the three mutually exclusive, as the server's own
    // refuseMixedBody does.
    { priority: Priority.High, projectId: PROJECT_ID },
    { name: "renamed", projectId: PROJECT_ID },
    // A key the Details tab never writes, riding along with one it does.
    { ownerUserId: SESSION_ID, projectId: PROJECT_ID },
    { projectId: PROJECT_ID, status: SESSION_STATUS.INACTIVE },
    // Writes nothing on its own.
    { expectedProjectId: PROJECT_ID },
  ]) {
    const { invoke, fetchCalls } = createHarness();

    const result = await invoke({
      path: SESSION_PATCH_PATH,
      method: "PATCH",
      body: JSON.stringify(body),
    });

    assert.equal(result.kind, "network-error", JSON.stringify(body));
    assert.equal(fetchCalls.length, 0, JSON.stringify(body));
  }
});

test("still admits the priority and rename bodies it admitted before", async () => {
  for (const [path, body] of [
    [SESSION_PATCH_PATH, { priority: Priority.High }],
    [BRANCH_PATCH_PATH, { priority: null }],
    [
      SESSION_PATCH_PATH,
      { name: "renamed", surface: ArtifactStatusEditSurface.Detail },
    ],
  ] as const) {
    const { invoke, fetchCalls } = createHarness();

    const result = await invoke({
      path,
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    assert.equal(result.kind, "response", `${path} ${JSON.stringify(body)}`);
    assert.equal(fetchCalls.length, 1, `${path} ${JSON.stringify(body)}`);
  }
});

test("admits version-skewed surface provenance for server validation", async () => {
  for (const [path, body] of [
    [SESSION_PATCH_PATH, { priority: Priority.High, surface: "unknown" }],
    [SESSION_PATCH_PATH, { name: "renamed", surface: "unknown" }],
    [
      "/entity-tags",
      {
        entityId: SESSION_ID,
        entityType: TagEntityType.Artifact,
        surface: "unknown",
        tagId: TAG_ID,
      },
    ],
  ] as const) {
    const { invoke, fetchCalls } = createHarness();
    const result = await invoke({
      path,
      method: path === "/entity-tags" ? "POST" : "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    assert.equal(result.kind, "response", JSON.stringify(body));
    assert.equal(fetchCalls.length, 1, JSON.stringify(body));
  }

  const detached = createHarness();
  const detachResult = await detached.invoke({
    path: `${detachQuery(TagEntityType.Artifact)}&surface=unknown`,
    method: "DELETE",
  });
  assert.equal(detachResult.kind, "response");
  assert.equal(detached.fetchCalls.length, 1);
});
