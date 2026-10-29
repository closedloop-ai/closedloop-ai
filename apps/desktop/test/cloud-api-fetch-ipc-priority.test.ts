import assert from "node:assert/strict";
import { test } from "vitest";
import {
  API_ORIGIN,
  createHarness,
} from "./cloud-api-fetch-ipc-test-harness.js";

/**
 * ISS-10332 / PLN-2086 Milestone 2: the Cloud-mode Sessions and Branches grids
 * write a priority through `PATCH /agent-sessions/[id]` and `PATCH
 * /branches/[id]`, so the bridge admits exactly those two paths and nothing
 * around them — and, on those paths, a priority body and nothing else, because
 * the session route also admits the grouping writes.
 *
 * ISS-8718 adds the second admitted body: the Sessions list and Session detail
 * rename through the SAME `PATCH /agent-sessions/[id]`, so a rename-only body is
 * admitted there and nowhere else. Until it was, the renderer's rename was
 * refused before any network call and desktop rename silently did nothing.
 */

const SESSION_PATH = "/agent-sessions/55555555-5555-4555-8555-555555555551";
const BRANCH_PATH = "/branches/66666666-6666-4666-8666-666666666661";

const PRIORITY_BODY = JSON.stringify({
  priority: "HIGH",
  expectedPriority: null,
  surface: "inline_cell",
});

/**
 * Each field `PATCH /agent-sessions/[id]` admits beyond the priority keys, one
 * per body, plus the mixed shape and the non-object shapes. Literal keys on
 * purpose: the truth here is the SERVER's update schema, and a fixture built
 * from the bridge's own key set would agree with the bridge's own mistake.
 */
const REFUSED_BODIES = [
  JSON.stringify({ priority: "HIGH", name: "renamed" }),
  JSON.stringify({ priority: "HIGH", status: "inactive" }),
  JSON.stringify({
    priority: "HIGH",
    projectId: "77777777-7777-4777-8777-777777777771",
  }),
  JSON.stringify({
    priority: "HIGH",
    ownerUserId: "88888888-8888-4888-8888-888888888881",
  }),
  // ISS-10332 re-review: `priority` is REQUIRED by the contract, so a body that
  // names none writes nothing. A keys-are-allowed check alone passed both of
  // these — `{}` vacuously, and a lone `surface` because it IS an allowed key.
  JSON.stringify({}),
  JSON.stringify({ surface: "sessions_grid" }),
  JSON.stringify([{ priority: "HIGH" }]),
  JSON.stringify("HIGH"),
  "null",
  "{not json",
];

test("allows the exact single session and branch priority PATCH routes", async () => {
  for (const path of [SESSION_PATH, BRANCH_PATH]) {
    const responseBody = { success: true, data: { id: "x", priority: "HIGH" } };
    const { invoke, fetchCalls } = createHarness(
      {},
      jsonResponse(responseBody)
    );

    const result = await invoke({
      path,
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: PRIORITY_BODY,
    });

    assert.equal(fetchCalls.length, 1, `${path} must fetch`);
    const call = fetchCalls[0];
    assert.equal(call.url.toString(), `${API_ORIGIN}${path}`);
    assert.equal(call.init.method, "PATCH");
    assert.equal(call.init.body, PRIORITY_BODY);
    const headers = call.init.headers as Headers;
    assert.equal(headers.get("authorization"), "Bearer real-access-token");
    assert.equal(result.kind, "response");
    if (result.kind === "response") {
      assert.deepEqual(JSON.parse(result.bodyText), responseBody);
    }
  }
});

test("admits a body carrying only `priority` — the guard and the surface are optional", async () => {
  const body = JSON.stringify({ priority: null });
  const { invoke, fetchCalls } = createHarness();

  const result = await invoke({
    path: SESSION_PATH,
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body,
  });

  assert.equal(result.kind, "response");
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].init.body, body);
});

test("refuses a body on the priority routes that carries neither admitted shape", async () => {
  for (const path of [SESSION_PATH, BRANCH_PATH]) {
    for (const body of [...REFUSED_BODIES, undefined]) {
      const { invoke, fetchCalls } = createHarness();

      const result = await invoke({
        path,
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body }),
      });

      assert.equal(
        result.kind,
        "network-error",
        `${path} must refuse ${String(body)}`
      );
      assert.equal(fetchCalls.length, 0, `${path} must not fetch`);
    }
  }
});

test("bounds only the priority routes' bodies — a trace-comment PATCH keeps its own shape", async () => {
  const body = JSON.stringify({ body: "edited" });
  const { invoke, fetchCalls } = createHarness();

  const result = await invoke({
    path: `${SESSION_PATH}/trace-comments/comment-1`,
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body,
  });

  assert.equal(result.kind, "response");
  assert.equal(fetchCalls.length, 1);
});

test("still refuses every PATCH path around the two priority routes", async () => {
  for (const path of [
    // The collections themselves.
    "/agent-sessions",
    "/branches",
    // A nested path under a session or branch that is not a trace comment.
    `${SESSION_PATH}/tags`,
    `${BRANCH_PATH}/refresh`,
    // A second segment smuggled past the id slot.
    `${BRANCH_PATH}/priority`,
    // A single-segment NON-id route under the same prefix: the id slot admits
    // a UUID and nothing else, so the bulk route stays a POST-only entry.
    "/agent-sessions/bulk-assign",
    "/branches/usage",
    // A sibling collection the grids never write.
    "/documents/77777777-7777-4777-8777-777777777771",
  ]) {
    const { invoke, fetchCalls } = createHarness();

    const result = await invoke({
      path,
      method: "PATCH",
      body: PRIORITY_BODY,
    });

    assert.equal(result.kind, "network-error", `${path} must be rejected`);
    assert.equal(fetchCalls.length, 0, `${path} must not fetch`);
  }
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
  });
}

/**
 * ISS-8718. The rename the Sessions lead cell and Session detail commit, with
 * and without the optimistic guard — the shapes `RenameAgentSessionRequest`
 * declares. Before the bridge admitted them, both came back a network error
 * with no fetch, which is a rename control that does nothing on desktop.
 */
test("admits a rename body on the session path, guarded and unguarded", async () => {
  for (const body of [
    JSON.stringify({ name: "renamed" }),
    JSON.stringify({ name: "renamed", expectedName: "before" }),
  ]) {
    const { invoke, fetchCalls } = createHarness();

    const result = await invoke({
      path: SESSION_PATH,
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body,
    });

    assert.equal(result.kind, "response", `must admit ${body}`);
    assert.equal(fetchCalls.length, 1, `must fetch for ${body}`);
    // The body reaches the network byte-identical: the gate admits, it never
    // reshapes, so the server sees exactly what the renderer sent.
    assert.equal(fetchCalls[0].init.body, body);
  }
});

/**
 * Rename is a SESSION write. A branch has no name to set through this route, so
 * the branch path keeps its priority-only bound — otherwise widening the gate
 * for one route would have widened it for both.
 */
test("keeps the branch path priority-only — a rename body is refused there", async () => {
  for (const body of [
    JSON.stringify({ name: "renamed" }),
    JSON.stringify({ name: "renamed", expectedName: "before" }),
  ]) {
    const { invoke, fetchCalls } = createHarness();

    const result = await invoke({
      path: BRANCH_PATH,
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body,
    });

    assert.equal(result.kind, "network-error", `branch must refuse ${body}`);
    assert.equal(fetchCalls.length, 0, "branch must not fetch");
  }
});

/**
 * The gate's schemas stay mutually exclusive. A mixed body satisfies NONE of
 * them — each is `.strict()` with its own required field — which is also what
 * the server route does: it refuses a body pairing a rename with a priority
 * (PLN-2086 Milestone 1). `REFUSED_BODIES` above covers the mixed shapes; this
 * names the reason so widening one schema to admit another cannot read as a
 * passing simplification.
 */
test("refuses a body pairing a rename with a priority on the session path", async () => {
  const { invoke, fetchCalls } = createHarness();

  const result = await invoke({
    path: SESSION_PATH,
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "renamed", priority: "HIGH" }),
  });

  assert.equal(result.kind, "network-error");
  assert.equal(fetchCalls.length, 0);
});

/** A body naming only the guard writes nothing and has no business on the path. */
test("refuses a rename body that names only the expected name", async () => {
  const { invoke, fetchCalls } = createHarness();

  const result = await invoke({
    path: SESSION_PATH,
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedName: "before" }),
  });

  assert.equal(result.kind, "network-error");
  assert.equal(fetchCalls.length, 0);
});
