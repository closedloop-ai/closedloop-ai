import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMeshHarness,
  disposeMeshHarnesses,
  identityA,
  identityB,
  meshDelivery,
  meshEvent,
  meshRepository,
  sessionEvent,
} from "./session-mesh-runtime-cov-iss11283-harness.js";

const messageOne = "1a2b3c4d-0000-4000-8000-000000000001";
const messageTwo = "1a2b3c4d-0000-4000-8000-000000000002";
const INBOX_LINE_PREFIX = "Inbox preview is bounded";

afterEach(() => {
  vi.useRealTimers();
  disposeMeshHarnesses();
});

function deliveries(agentId: string, ids: string[]) {
  return ids.map((id) =>
    meshDelivery({ id, recipientAgentId: agentId, summary: `about ${id}` })
  );
}

async function previewLines(
  roster: string[],
  inbox: (agentId: string) => ReturnType<typeof meshDelivery>[] = () => []
): Promise<string[]> {
  const h = createMeshHarness();
  h.state.roster = () => roster;
  h.state.inboxFor = inbox;
  const runtime = h.runtime();
  await runtime.handle(sessionEvent("SessionStart"));
  await runtime.whenIdle();
  const context = (await runtime.handle(sessionEvent("AwaitContext")))
    .additionalContext;
  return (context ?? "").split("\n");
}

describe("Session Mesh runtime preview text", () => {
  it("renders a five-line roster-only preview with no optional lines", async () => {
    const lines = await previewLines(["codex:peer"]);
    expect(lines).toHaveLength(5);
    expect(lines[3]).toBe("Live peers: codex:peer.");
    expect(lines[4]?.startsWith(INBOX_LINE_PREFIX)).toBe(true);
  });

  it("does not add the roster-preview line for exactly twenty peers", async () => {
    const peers = Array.from({ length: 20 }, (_, index) => `codex:p${index}`);
    const lines = await previewLines(peers);
    expect(lines).toHaveLength(5);
    expect(lines[3]).toBe(`Live peers: ${peers.join(", ")}.`);
  });

  it("adds the continuation line when the roster page has a next cursor", async () => {
    const h = createMeshHarness();
    h.state.rosterCursor = "cursor-2";
    const runtime = h.runtime();
    await runtime.handle(sessionEvent("SessionStart"));
    await runtime.whenIdle();
    const lines = (
      (await runtime.handle(sessionEvent("AwaitContext"))).additionalContext ??
      ""
    ).split("\n");
    expect(lines).toHaveLength(6);
    expect(lines[4]).toContain('cursor:"cursor-2"');
    expect(lines[4]).toContain(`repository:"${meshRepository}"`);
    expect(lines[5]?.startsWith(INBOX_LINE_PREFIX)).toBe(true);
  });

  it("quotes a short and an exactly-600-character summary without the truncation suffix", async () => {
    const exact = "y".repeat(600);
    const lines = await previewLines(["codex:peer"], (agentId) => [
      meshDelivery({
        id: messageOne,
        recipientAgentId: agentId,
        summary: "short",
      }),
      meshDelivery({
        id: messageTwo,
        recipientAgentId: agentId,
        summary: exact,
      }),
    ]);
    expect(lines.slice(5)).toEqual([
      `[claim; ${messageOne}; codex:peer] short`,
      `[claim; ${messageTwo}; codex:peer] ${exact}`,
    ]);
  });

  it("suppresses an unchanged roster preview per agent, not across agents", async () => {
    const h = createMeshHarness();
    const runtime = h.runtime();
    await runtime.handle(sessionEvent("SessionStart", "session-a"));
    await runtime.handle(sessionEvent("SessionStart", "session-b"));
    await runtime.whenIdle();
    expect(
      (await runtime.handle(sessionEvent("AwaitContext", "session-a")))
        .additionalContext
    ).toContain("claude:session-a");
    await runtime.handle(sessionEvent("UserPromptSubmit", "session-a"));
    await runtime.whenIdle();
    expect(
      await runtime.handle(sessionEvent("AwaitContext", "session-a"))
    ).toEqual({ awaitContext: false });
  });
});

describe("Session Mesh runtime delivery receipts", () => {
  it("acknowledges every message in a receipt and hides all of them from the next preview", async () => {
    const h = createMeshHarness();
    h.state.inboxFor = (agentId) =>
      deliveries(agentId, [messageOne, messageTwo]);
    const runtime = h.runtime();
    await runtime.handle(sessionEvent("SessionStart"));
    await runtime.whenIdle();
    const first = await runtime.handle(sessionEvent("AwaitContext"));
    await runtime.handle(
      meshEvent("ContextDelivered", { receipt: first.receipt })
    );
    await runtime.whenIdle();
    expect(
      h.requests
        .filter((request) => request.path.endsWith("/disposition"))
        .map((request) => request.body?.messageId)
    ).toEqual([messageOne, messageTwo]);
    await runtime.handle(sessionEvent("UserPromptSubmit"));
    await runtime.whenIdle();
    const next = await runtime.handle(sessionEvent("AwaitContext"));
    expect(next.additionalContext).not.toContain("about ");
    expect(next.receipt).toBeUndefined();
  });

  it("drops an unread cached preview once its own receipt is delivered", async () => {
    const h = createMeshHarness();
    h.state.inboxFor = (agentId) => deliveries(agentId, [messageOne]);
    const runtime = h.runtime();
    await runtime.handle(sessionEvent("SessionStart"));
    await runtime.whenIdle();
    const [receipt] = Object.keys(h.ledger().receipts);
    await runtime.handle(meshEvent("ContextDelivered", { receipt }));
    await runtime.whenIdle();
    expect(await runtime.handle(sessionEvent("UserPromptSubmit"))).toEqual({});
  });

  it("drops a newer cached preview that repeats any message an earlier delivered receipt covered", async () => {
    const h = createMeshHarness();
    let ids = [messageOne];
    h.state.inboxFor = (agentId) => deliveries(agentId, ids);
    const runtime = h.runtime();
    await runtime.handle(sessionEvent("SessionStart"));
    await runtime.whenIdle();
    const earlier = await runtime.handle(sessionEvent("AwaitContext"));
    ids = [messageOne, messageTwo];
    await runtime.handle(sessionEvent("UserPromptSubmit"));
    await runtime.whenIdle();
    await runtime.handle(
      meshEvent("ContextDelivered", { receipt: earlier.receipt })
    );
    await runtime.whenIdle();
    expect(await runtime.handle(sessionEvent("UserPromptSubmit"))).toEqual({});
  });

  it("keeps another account's cached preview for the same session when a receipt is delivered", async () => {
    const h = createMeshHarness();
    h.state.inboxFor = (agentId) => deliveries(agentId, [messageOne]);
    const runtime = h.runtime();
    await runtime.handle(sessionEvent("SessionStart"));
    await runtime.whenIdle();
    const forA = await runtime.handle(sessionEvent("AwaitContext"));
    h.state.identity = identityB;
    await runtime.handle(sessionEvent("SessionStart"));
    await runtime.whenIdle();
    h.state.identity = identityA;
    await runtime.handle(
      meshEvent("ContextDelivered", { receipt: forA.receipt })
    );
    await runtime.whenIdle();
    h.state.identity = identityB;
    const forB = await runtime.handle(sessionEvent("UserPromptSubmit"));
    expect(forB.additionalContext).toContain(`about ${messageOne}`);
    expect(forB.receipt).toEqual(expect.any(String));
    expect(forB.receipt).not.toBe(forA.receipt);
  });
});

describe("Session Mesh runtime waiter timeouts", () => {
  it("treats a cached preview exactly one minute old as expired", async () => {
    const h = createMeshHarness();
    const runtime = h.runtime();
    await runtime.handle(sessionEvent("SessionStart"));
    await runtime.whenIdle();
    h.state.now += 60_000;
    // The stale preview was built from an empty inbox; the next published
    // context carries messageOne.
    h.state.inboxFor = (agentId) => deliveries(agentId, [messageOne]);
    const waiting = runtime.handle(sessionEvent("AwaitContext"));
    await runtime.handle(sessionEvent("UserPromptSubmit"));
    await runtime.whenIdle();
    // An expired preview parks the call, so it receives the context the next
    // hook publishes. Serving the stale preview would resolve without it.
    expect((await waiting).additionalContext).toContain(`about ${messageOne}`);
  });

  it("keeps a later waiter registered after an earlier one times out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = createMeshHarness();
    h.state.inboxFor = (agentId) => deliveries(agentId, [messageOne]);
    const runtime = h.runtime();
    await runtime.handle(sessionEvent("SessionStart"));
    await runtime.whenIdle();
    await runtime.handle(sessionEvent("AwaitContext"));
    const earlier = runtime.handle(sessionEvent("AwaitContext"));
    await vi.advanceTimersByTimeAsync(1000);
    const later = runtime.handle(sessionEvent("AwaitContext"));
    await vi.advanceTimersByTimeAsync(4000);
    expect(await earlier).toEqual({});
    await runtime.handle(sessionEvent("UserPromptSubmit"));
    await runtime.whenIdle();
    // Run `later` past its own timeout so it settles either way. Only a waiter
    // still registered at the publish above receives the message; a dropped
    // one settles empty.
    await vi.advanceTimersByTimeAsync(5000);
    expect((await later).additionalContext).toContain(`about ${messageOne}`);
  });

  it("frees an agent's waiter slot once its only waiter times out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = createMeshHarness();
    const runtime = h.runtime();
    const timedOut = Array.from({ length: 500 }, (_, index) =>
      runtime.handle(sessionEvent("AwaitContext", `session-${index}`))
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(await Promise.all(timedOut)).toEqual(
      Array.from({ length: 500 }, () => ({}))
    );
    const fresh = runtime.handle(sessionEvent("AwaitContext", "session-new"));
    await runtime.handle(sessionEvent("SessionStart", "session-new"));
    await runtime.whenIdle();
    // Run `fresh` past its own timeout so it settles either way. Only a
    // registered waiter receives the published context; a waiter refused at
    // the 500-agent cap settles empty at once.
    await vi.advanceTimersByTimeAsync(5000);
    expect((await fresh).additionalContext).toContain(
      "Your canonical Mesh ID: claude:session-new."
    );
  });
});
