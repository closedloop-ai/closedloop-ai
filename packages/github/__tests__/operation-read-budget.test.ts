import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubOperationReadBudget } from "../operation-read-budget";
import { getUserTokenOctokit } from "../user-token-auth";

describe("operation read budget", () => {
  afterEach(() => vi.useRealTimers());

  it("shares a physical ceiling across real Octokit REST and GraphQL requests", async () => {
    const transport = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ data: { viewer: { login: "fixture" } } }))
    );
    const budget = createGitHubOperationReadBudget({
      maxRequests: 2,
      maxDurationMs: 1000,
      fetch: transport,
    });
    const client = getUserTokenOctokit("synthetic-test-credential", {
      fetch: budget.fetch,
    });
    try {
      await client.rest.repos.get({ owner: "fixture", repo: "app" });
      await client.graphql("query { viewer { login } }");
      await expect(
        client.rest.repos.get({ owner: "fixture", repo: "app" })
      ).rejects.toThrow("budget exhausted");
      expect(transport).toHaveBeenCalledTimes(2);
      expect(budget.requestsUsed()).toBe(2);
      expect(transport.mock.calls.map(([request]) => String(request))).toEqual([
        "https://api.github.com/repos/fixture/app",
        "https://api.github.com/graphql",
      ]);
    } finally {
      budget.dispose();
    }
  });

  it("restores the outer reserve after a nested phase exhausts its allowance", async () => {
    const transport = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({}))
    );
    const budget = createGitHubOperationReadBudget({
      maxRequests: 5,
      maxDurationMs: 1000,
      fetch: transport,
    });
    try {
      await budget.withRequestLimit(2, async () => {
        await budget.fetch("https://api.github.test/discovery-a");
        await budget.fetch("https://api.github.test/discovery-b");
        await expect(
          budget.fetch("https://api.github.test/discovery-c")
        ).rejects.toThrow("budget exhausted");
        expect(budget.exhausted()).toBe(true);
      });
      expect(budget.requestsRemaining()).toBe(3);
      await budget.fetch("https://api.github.test/verification");
      expect(transport).toHaveBeenCalledTimes(3);
      expect(budget.requestsRemaining()).toBe(2);
    } finally {
      budget.dispose();
    }
  });

  it("bounds physical reads without sharing state with another operation", async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response("{}"));
    const budget = createGitHubOperationReadBudget({
      maxRequests: 2,
      maxDurationMs: 1000,
      fetch: transport,
    });
    const other = createGitHubOperationReadBudget({
      maxRequests: 2,
      maxDurationMs: 1000,
      fetch: transport,
    });
    try {
      await budget.fetch("https://api.github.test/a");
      await budget.fetch("https://api.github.test/b");
      await expect(budget.fetch("https://api.github.test/c")).rejects.toThrow(
        "budget exhausted"
      );
      await other.fetch("https://api.github.test/d");
      expect(transport).toHaveBeenCalledTimes(3);
      expect(budget.requestsUsed()).toBe(2);
      expect(other.requestsUsed()).toBe(1);
    } finally {
      budget.dispose();
      other.dispose();
    }
  });

  it("aborts an in-flight call at the shared deadline and clears its timer", async () => {
    vi.useFakeTimers();
    const transport = vi.fn<typeof fetch>(
      (_request, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true }
          );
        })
    );
    const budget = createGitHubOperationReadBudget({
      maxRequests: 10,
      maxDurationMs: 1000,
      fetch: transport,
    });
    const pending = expect(
      budget.fetch("https://api.github.test/a")
    ).rejects.toThrow("aborted");
    try {
      await vi.advanceTimersByTimeAsync(1000);
      await pending;
      expect(budget.exhausted()).toBe(true);
      await expect(budget.fetch("https://api.github.test/b")).rejects.toThrow(
        "budget exhausted"
      );
      expect(transport).toHaveBeenCalledTimes(1);
    } finally {
      budget.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
