import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SESSION_MESH_V1_FEATURE_FLAG_KEY } from "@repo/api/src/types/session-mesh-flag";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDesktopMainFeatureFlagAssignmentStore,
  publishDesktopMainFeatureFlagAssignmentStore,
} from "../src/main/auth/desktop-feature-flag-assignment.js";
import {
  ensureSessionMeshToolPermissions,
  installSessionMeshHooks,
  makeSessionMeshClaudeHookEntry,
} from "../src/main/session-mesh/session-mesh-hook-installer-core.js";
import {
  classifySessionMeshSendMessage,
  SESSION_MESH_NATIVE_MESSAGING_TOOLS,
  SESSION_MESH_SUBJECT_JOINER,
  SessionMeshSendMessageKind,
} from "../src/main/session-mesh/session-mesh-send-message-relevance.js";
import type { ResolvedSessionMeshWorkspace } from "../src/main/session-mesh/session-mesh-workspace.js";
import {
  createMeshHarness,
  disposeMeshHarnesses,
  identityA,
  isPresencePost,
  type MeshRequest,
  meshRepository,
  sessionEvent,
} from "./session-mesh-runtime-cov-iss11283-harness.js";

const DENIED_BODY = JSON.stringify({
  success: false,
  code: "session_mesh_disabled",
});
const CLAIMING_BODY =
  "I'm taking apps/api/app/session-mesh/service.ts for ISS-11434; leave it alone.";

/**
 * Authentic lane traffic from one day of coordination briefs (operator ruling,
 * Marisol Ashgrove 2026-10-01: "And classifyKind is why my briefs produced nothing.
 * -- fix that."). Each one names a repository path and reports a routable
 * finding, and each one matched NO phrase in `KIND_PATTERNS`, so the mirror
 * dropped it and the organization ledger recorded zero substantive publications.
 */
const UNPATTERNED_SUBJECT_BEARING_TRAFFIC: ReadonlyArray<{
  summary: string;
  message: string;
  subject: string;
}> = [
  {
    summary: "the exemption test cannot fail",
    message:
      "the exemption test cannot fail — paved-path-ui-gates.test.ts only asserts the exempted path is a file, so it stays green under the exact mutation it exists to prevent (scripts/lint/rules/no-superseded-table-primitive.ts)",
    subject: "scripts/lint/rules/no-superseded-table-primitive.ts",
  },
  {
    summary: "the migration timestamp now sorts before main's tip",
    message:
      "its migration timestamp now sorts before main's tip; a TIE is refused too, not just a gap — this has ejected five PRs today (scripts/lint/migration-immutability.test.ts)",
    subject: "scripts/lint/migration-immutability.test.ts",
  },
  {
    summary: "renderer suites fail on Node 26",
    message:
      "local desktop renderer suites fail on Node 26 because localStorage is undefined without --localstorage-file; CI runs Node 24 — apps/desktop/src/renderer/components/dashboard/__tests__/dashboard-sessions-kpi-population.test.tsx",
    subject:
      "apps/desktop/src/renderer/components/dashboard/__tests__/dashboard-sessions-kpi-population.test.tsx",
  },
  {
    summary: "branch detail emits a private email as the display name",
    message:
      "resolveOwnerProfiles falls back to email, so branch detail emits a private email as the display name — apps/api/app/branches/branch-read-service/identity-attribution.ts",
    subject:
      "apps/api/app/branches/branch-read-service/identity-attribution.ts",
  },
];

afterEach(() => {
  publishDesktopMainFeatureFlagAssignmentStore(null);
  disposeMeshHarnesses();
});

/**
 * A resolver reporting a git toplevel that is NOT the session cwd, which is
 * every session started in a subdirectory of the checkout.
 */
function resolveWorkspaceAt(overrides: {
  root?: string;
  branch?: string;
  symbols?: string[];
}) {
  return (
    _cwd: string,
    file?: string,
    files?: string[]
  ): Promise<ResolvedSessionMeshWorkspace> =>
    Promise.resolve({
      repository: meshRepository,
      revision: "rev-1",
      paths: files ?? (file ? [file] : []),
      symbols: [],
      ...overrides,
    });
}

function sendMessageEvent(
  toolInput: Record<string, unknown>,
  toolUseId = "toolu_mirror_1"
) {
  return sessionEvent("PreToolUse", "session-1", {
    tool_name: "SendMessage",
    tool_use_id: toolUseId,
    tool_input: toolInput,
  });
}

function isPublish(request: MeshRequest): boolean {
  return request.method === "POST" && request.path === "/session-mesh/messages";
}

function publishedBodies(requests: MeshRequest[]) {
  return requests.filter(isPublish).map((request) => request.body);
}

async function denyAssignment(): Promise<void> {
  const store = createDesktopMainFeatureFlagAssignmentStore({
    fetchAssignment: () =>
      Promise.resolve({
        userId: identityA.userId,
        resolved: true,
        flags: { [SESSION_MESH_V1_FEATURE_FLAG_KEY]: false },
      }),
    retryDelaysMs: [],
  });
  publishDesktopMainFeatureFlagAssignmentStore(store);
  await store.resolveFor(identityA.userId);
}

describe("Session Mesh SendMessage mirror", () => {
  it("publishes exactly one unaddressed mirror of the mapped kind, carrying a classified summary and not the body", async () => {
    const harness = createMeshHarness();
    const runtime = harness.runtime();
    await runtime.handle(
      sendMessageEvent({
        to: "a38cd6f58b3ee04f4",
        summary: "Claiming the mesh service file",
        message: CLAIMING_BODY,
      })
    );
    await runtime.whenIdle();
    const published = publishedBodies(harness.requests);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      kind: "claim",
      authorAgentId: "claude:session-1",
      recipientAgentIds: [],
    });
    const summary = String(published[0]?.summary);
    // The author's own recap plus the named subject, never the sibling-private body.
    expect(summary).toContain("Claiming the mesh service file");
    expect(summary).toContain("apps/api/app/session-mesh/service.ts");
    expect(summary).toContain("ISS-11434");
    expect(summary).not.toContain("leave it alone");
  });

  it("stays silent on lane chatter that names no subject", async () => {
    const harness = createMeshHarness();
    const runtime = harness.runtime();
    for (const toolInput of [
      { to: "a1", summary: "Kick off task 1", message: "start on task 1" },
      { to: "a1", summary: "Ack", message: "done" },
      { to: "a1", summary: "Status", message: "can you confirm when ready?" },
    ]) {
      await runtime.handle(
        sendMessageEvent(toolInput, `toolu_${toolInput.summary}`)
      );
    }
    await runtime.whenIdle();
    expect(publishedBodies(harness.requests)).toHaveLength(0);
  });

  it("mirrors a blocker with no named subject, carrying the branch that is the only thing able to place it", async () => {
    const harness = createMeshHarness();
    const runtime = harness.runtime({
      resolveWorkspace: resolveWorkspaceAt({
        branch: "fix/iss-11434-mesh-send-trigger",
      }),
    });
    await runtime.handle(
      sendMessageEvent({
        to: "a1",
        summary: "Migration lane is blocked",
        message: "I am blocked — the shared fixture never comes up.",
      })
    );
    await runtime.whenIdle();
    // `relevanceFor` reads repository identity as NO evidence, so a subject-less
    // blocker is placed by `lineage.branch` or by nothing at all. Asserting the
    // kind alone would leave the one field that routes it unpinned.
    expect(publishedBodies(harness.requests)).toMatchObject([
      {
        kind: "blocker",
        recipientAgentIds: [],
        lineage: { branch: "fix/iss-11434-mesh-send-trigger" },
      },
    ]);
  });

  it("relativizes a body-named absolute path against the git toplevel, not the session cwd", async () => {
    const harness = createMeshHarness();
    const runtime = harness.runtime({
      resolveWorkspace: resolveWorkspaceAt({ root: "/repo" }),
    });
    await runtime.handle(
      sessionEvent("PreToolUse", "session-1", {
        cwd: "/repo/apps/desktop",
        tool_name: "SendMessage",
        tool_use_id: "toolu_subdir",
        tool_input: {
          to: "a1",
          summary: "Claiming the service",
          message: "I'm taking /repo/apps/api/app/session-mesh/service.ts",
        },
      })
    );
    await runtime.whenIdle();
    const published = publishedBodies(harness.requests);
    expect(published).toHaveLength(1);
    // Against the cwd this path fails the prefix test and is dropped; a path
    // under the cwd relativizes to `src/x.ts`, which no peer carries. The
    // server's path overlap is exact, so only the toplevel spelling routes.
    expect(published[0]?.workspace).toMatchObject({
      paths: ["apps/api/app/session-mesh/service.ts"],
    });
  });

  it("pre-approves the sibling-messaging tools in the settings Desktop installs, leaving the user's own alone", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "mesh-permissions-"));
    const file = path.join(directory, "settings.json");
    writeFileSync(
      file,
      JSON.stringify({ permissions: { allow: ["Bash(git status)"] } })
    );
    installSessionMeshHooks({
      file,
      execPath: "/Applications/Closedloop.app/electron",
      handler: path.join(directory, "session-mesh-hook-handler.js"),
      codexConfigFile: path.join(directory, "config.toml"),
      receiverState: null,
      nativeAsyncSupport: { claude: true, codex: false },
    });
    const installed = JSON.parse(readFileSync(file, "utf8")) as {
      permissions: { allow: string[] };
    };
    // The repo settings file only reaches a session started in THIS checkout;
    // the trigger is a Desktop capability, so the approval lands where Desktop
    // writes — additively, ahead of nothing the user already granted.
    expect(installed.permissions.allow).toEqual([
      "Bash(git status)",
      ...SESSION_MESH_NATIVE_MESSAGING_TOOLS,
    ]);
    // Idempotent across boots: neither duplicated nor reordered.
    expect(ensureSessionMeshToolPermissions(file)).toBe(false);
  });

  it("publishes nothing while the mesh is denied", async () => {
    await denyAssignment();
    const harness = createMeshHarness();
    harness.state.respond = () => new Response(DENIED_BODY, { status: 403 });
    const runtime = harness.runtime();
    await runtime.handle(
      sendMessageEvent({
        to: "a1",
        summary: "Claiming the mesh service file",
        message: CLAIMING_BODY,
      })
    );
    await runtime.whenIdle();
    expect(publishedBodies(harness.requests)).toHaveLength(0);
  });

  it("collapses a duplicated hook delivery into one publish and keeps the key stable across a later retry", async () => {
    const harness = createMeshHarness();
    const runtime = harness.runtime();
    const toolInput = {
      to: "a1",
      summary: "Claiming the mesh service file",
      message: CLAIMING_BODY,
    };
    const first = runtime.handle(sendMessageEvent(toolInput));
    const duplicate = runtime.handle(sendMessageEvent(toolInput));
    await Promise.all([first, duplicate]);
    await runtime.whenIdle();
    expect(publishedBodies(harness.requests)).toHaveLength(1);
    const key = publishedBodies(harness.requests)[0]?.idempotencyKey;
    await runtime.handle(sendMessageEvent(toolInput));
    await runtime.whenIdle();
    // A re-delivered hook after the first publish drained re-sends the SAME key,
    // so the server's own idempotency collapses it instead of duplicating.
    for (const body of publishedBodies(harness.requests)) {
      expect(body?.idempotencyKey).toBe(key);
    }
  });

  it("admits SendMessage in the installed Claude PreToolUse matcher and not the Codex one", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "mesh-matcher-"));
    const file = path.join(directory, "settings.json");
    writeFileSync(file, "{}");
    installSessionMeshHooks({
      file,
      execPath: "/Applications/Closedloop.app/electron",
      handler: path.join(directory, "session-mesh-hook-handler.js"),
      codexConfigFile: path.join(directory, "config.toml"),
      receiverState: null,
      nativeAsyncSupport: { claude: true, codex: false },
    });
    const installed = JSON.parse(readFileSync(file, "utf8")) as {
      hooks: { PreToolUse: Array<{ matcher?: string }> };
    };
    const matcher = installed.hooks.PreToolUse.at(-1)?.matcher ?? "";
    expect(new RegExp(matcher).test("SendMessage")).toBe(true);
    expect(new RegExp(matcher).test("Edit")).toBe(true);
    expect(new RegExp(matcher).test("Read")).toBe(false);
    const codex = String(
      makeSessionMeshClaudeHookEntry(
        "/bin/electron",
        "/h.js",
        "PreToolUse",
        "codex"
      ).matcher
    );
    expect(new RegExp(codex).test("SendMessage")).toBe(false);
  });

  it("redacts a secret out of the mirrored recap AND out of the extracted subjects", () => {
    const mirror = classifySessionMeshSendMessage({
      summary:
        "Claiming packages/api/src/types/session-mesh.ts with sk_live_0123456789abcdefghijklmn",
      message:
        "I'm taking https://alice:hunter2pwd@github.com/org/repo/src/a.ts and packages/api/src/types/session-mesh.ts",
    });
    expect(mirror?.kind).toBe("claim");
    expect(mirror?.headline).not.toContain("sk_live_0123456789abcdefghijklmn");
    // The subject extractor reads the BODY, so a credential the regex would
    // otherwise carry into an org-wide row must already be redacted.
    for (const subject of mirror?.subjects ?? []) {
      expect(subject).not.toContain("hunter2pwd");
    }
  });

  it("relativizes an absolute path under the checkout and drops one outside it", () => {
    const inside = classifySessionMeshSendMessage(
      {
        summary: "Claiming the service",
        message: "I'm taking /repo/apps/api/app/session-mesh/service.ts",
      },
      "/repo"
    );
    // Exact path overlap is how the server routes, and peer paths are
    // repository-relative, so an absolute path would reach nobody.
    expect(inside?.paths).toEqual(["apps/api/app/session-mesh/service.ts"]);
    const outside = classifySessionMeshSendMessage(
      {
        summary: "Claiming the service",
        message:
          "I'm taking /Users/alice/other-checkout/apps/api/service.ts and ISS-11434",
      },
      "/repo"
    );
    // A foreign checkout names another machine's tree and carries a username.
    expect(outside?.paths).toEqual([]);
    expect(outside?.tickets).toEqual(["ISS-11434"]);
  });

  it("strips a leading ./ and drops a traversal or an over-long path", () => {
    const mirror = classifySessionMeshSendMessage({
      summary: "Claiming files",
      message: `I'm taking ./apps/desktop/x.ts, ../escape/y.ts and ${"a/".repeat(600)}z.ts`,
    });
    expect(mirror?.paths).toEqual(["apps/desktop/x.ts"]);
  });

  it("does not mirror a negated blocker as a blocker", () => {
    for (const message of [
      "Task 3 done, nothing blocking",
      "no longer blocked, merging now",
    ]) {
      expect(
        classifySessionMeshSendMessage({ summary: "Status", message })
      ).toBeNull();
    }
  });

  it("classifies subject-bearing traffic that matches no kind phrase, as the generic finding", () => {
    for (const {
      summary,
      message,
      subject,
    } of UNPATTERNED_SUBJECT_BEARING_TRAFFIC) {
      const mirror = classifySessionMeshSendMessage({ summary, message });
      // The kind table recognizes phrases; it is not the filter. Dropping these
      // is what produced an organization ledger with zero substantive rows.
      expect(mirror?.kind).toBe("discovery");
      // The subject is what the server routes on, so a classified message with
      // no extracted subject would still reach nobody.
      expect(mirror?.subjects).toContain(subject);
    }
  });

  it("still drops that same traffic once it names no path and no ticket", () => {
    for (const {
      summary,
      message,
      subject,
    } of UNPATTERNED_SUBJECT_BEARING_TRAFFIC) {
      // Same prose, same generic kind, no subject — the gate that holds the
      // noise floor is the SUBJECT, so the generic default cannot open a
      // firehose of lane chatter.
      expect(
        classifySessionMeshSendMessage({
          summary,
          message: message.replaceAll(subject, "the gate"),
        })
      ).toBeNull();
    }
  });

  it("declines to mirror a relayed Mesh row, so a forward cannot publish a second one", async () => {
    const harness = createMeshHarness();
    const runtime = harness.runtime();
    // The exact shape `sessionMeshSendMessagePublication` composes, forwarded to
    // a lane. It names a path, matches no kind phrase and carries a FRESH
    // tool_use_id, so without the echo gate the subject gate passes it, the
    // default classifies it and idempotency cannot collapse it — a second row
    // that is deliverable and forwardable again.
    for (const message of [
      `Sibling session reported a finding${SESSION_MESH_SUBJECT_JOINER}apps/api/app/session-mesh/service.ts`,
      "[discovery; 7f1c2b90-5d6e-4a21-9c33-0b8e4d5f6a71; claude:session-9] resolveOwnerProfiles falls back to email — apps/api/app/branches/branch-read-service/identity-attribution.ts",
      "FYI, mesh says Sibling session reported a blocker — subject: packages/api/src/types/session-mesh.ts",
    ]) {
      expect(
        classifySessionMeshSendMessage({
          summary: "Relaying the mesh row",
          message,
        })
      ).toBeNull();
    }
    await runtime.handle(
      sendMessageEvent({
        to: "a1",
        summary: "Relaying the mesh row",
        message: `Sibling session reported a finding${SESSION_MESH_SUBJECT_JOINER}apps/api/app/session-mesh/service.ts`,
      })
    );
    await runtime.whenIdle();
    expect(publishedBodies(harness.requests)).toHaveLength(0);
  });

  it("still mirrors a first-hand message that names the same path as a relayed row", () => {
    // The gate recognizes only shapes this repo composes, so it must not be a
    // path-mentions-anything filter: this is the finding, not the echo of one.
    const mirror = classifySessionMeshSendMessage({
      summary: "resolveOwnerProfiles leaks the email",
      message:
        "resolveOwnerProfiles falls back to email in apps/api/app/branches/branch-read-service/identity-attribution.ts",
    });
    expect(mirror?.kind).toBe("discovery");
    expect(mirror?.subjects).toContain(
      "apps/api/app/branches/branch-read-service/identity-attribution.ts"
    );
  });

  it("keeps a request a request rather than letting the generic default shadow it", () => {
    const mirror = classifySessionMeshSendMessage({
      summary: "Asking for a re-run",
      message:
        "can you re-run the gate on scripts/lint/rules/no-superseded-table-primitive.ts?",
    });
    // KIND_PATTERNS is consulted before the default, so an explicit phrase keeps
    // its specific kind and a request is never reported as a finding.
    expect(mirror?.kind).toBe("request");
  });

  it("demotes a negated blocker to the default kind instead of dropping it", () => {
    // Operator ruling 2026-10-01 replaced the terminal veto. It had made a
    // negation phrase silence a message that published without it, so a
    // subject-bearing negation now reaches the generic default. The veto still
    // denies the `blocker` classification, which is the only thing its reason
    // claimed; the subject-less cases above stay dropped by the subject gate.
    const mirror = classifySessionMeshSendMessage({
      summary: "Status",
      message:
        "nothing blocking on apps/api/app/session-mesh/service.ts any more",
    });
    expect(mirror?.kind).toBe(SessionMeshSendMessageKind.Discovery);
    expect(mirror?.kind).not.toBe(SessionMeshSendMessageKind.Blocker);
    expect(mirror?.paths).toEqual(["apps/api/app/session-mesh/service.ts"]);
  });

  it("keeps the branch symbol off the per-edit claim while presence carries it", async () => {
    const harness = createMeshHarness();
    const runtime = harness.runtime({
      resolveWorkspace: resolveWorkspaceAt({
        branch: "fix/iss-11729-lane-a",
        symbols: ["ISS-11729"],
      }),
    });
    await runtime.handle(
      sessionEvent("PreToolUse", "session-1", {
        tool_name: "Edit",
        tool_use_id: "toolu_claim_1",
        tool_input: { file_path: "apps/api/app/session-mesh/service.ts" },
      })
    );
    await runtime.whenIdle();
    // `messageKind` returns `claim` on every edit and `relevanceFor` ranks any
    // symbol overlap `overlap`, which the server QUEUES rather than holds. A
    // branch symbol here would make two worktrees on one ticket interrupt each
    // other on every write with disjoint files, so a lifecycle fact is placed by
    // the paths it names and carries no symbols.
    expect(publishedBodies(harness.requests)).toMatchObject([
      {
        kind: "claim",
        workspace: {
          symbols: [],
          paths: ["apps/api/app/session-mesh/service.ts"],
        },
      },
    ]);
    // Presence still carries it: it is the half `relevanceFor` matches AGAINST,
    // so dropping it there would restore the dead `symbolOverlap`.
    expect(
      harness.requests.filter(isPresencePost).map((request) => request.body)
    ).toMatchObject([{ workspace: { symbols: ["ISS-11729"] } }]);
  });

  it("carries ticket slugs as routable symbols and records its provenance", async () => {
    const harness = createMeshHarness();
    const runtime = harness.runtime();
    await runtime.handle(
      sendMessageEvent({
        to: "a38cd6f58b3ee04f4",
        summary: "Blocked on the migration",
        message: "I am blocked on ISS-11434 until the migration lands.",
      })
    );
    await runtime.whenIdle();
    const published = publishedBodies(harness.requests);
    expect(published).toHaveLength(1);
    // relevanceFor routes on exact path OR symbol overlap and never reads the
    // summary, so a slug left only in prose would store a message with no
    // recipients at all.
    expect(published[0]?.workspace).toMatchObject({ symbols: ["ISS-11434"] });
    expect(published[0]?.context).toMatchObject({
      origin: "native_send_message",
      harness: "claude",
      toolUseId: "toolu_mirror_1",
      originSessionId: "session-1",
      originSiblingRecipient: "a38cd6f58b3ee04f4",
    });
  });
});
