/**
 * @file catalog-fetcher-cov-iss11283-fetch-policy.test.ts
 * @description ISS-11283 lane D branch-coverage addendum for
 * `packs/catalog-fetcher.ts`. Targets baseline-uncovered arms the existing
 * `catalog-fetcher.test.ts` does not exercise: the `contents` shapes
 * `parseJsonField` falls through on (non-object, non-string), a null
 * `githubUrl` in the source fingerprint, the marketplace-sub-plugin path with
 * NO `marketplace_repo`, `scheduleCatalogFetch`'s default interval and its
 * `run()` rejection handling (both Error and non-Error), and the
 * `applyCatalogFetchPlan`/`runCatalogFetch` failure catches.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import {
  applyCatalogFetchPlan,
  type CatalogFetchTransport,
  catalogSourceFingerprint,
  collectCatalogFetchPlan,
  runCatalogFetch,
  scheduleCatalogFetch,
} from "../src/main/packs/catalog-fetcher.js";
import { GitHubJsonFetchStatus } from "../src/main/packs/catalog-github-client.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const UPSTASH_CONTEXT7_RE = /upstash\/context7/;

type TransportCall = { fn: string; args: unknown[] };

function fakeTransport(overrides: Partial<CatalogFetchTransport> = {}): {
  transport: CatalogFetchTransport;
  calls: TransportCall[];
} {
  const calls: TransportCall[] = [];
  const transport: CatalogFetchTransport = {
    fetchRepoStats: (owner, repo) => {
      calls.push({ fn: "fetchRepoStats", args: [owner, repo] });
      return overrides.fetchRepoStats
        ? overrides.fetchRepoStats(owner, repo)
        : Promise.resolve({
            status: GitHubJsonFetchStatus.Success,
            value: {
              repo: { stargazers_count: 7, forks_count: 3, description: "d" },
              release: "v1.2.3",
            },
          });
    },
    fetchPluginManifest: (owner, repo, pluginPath) => {
      calls.push({
        fn: "fetchPluginManifest",
        args: [owner, repo, pluginPath],
      });
      return overrides.fetchPluginManifest
        ? overrides.fetchPluginManifest(owner, repo, pluginPath)
        : Promise.resolve({ description: "plugin desc", version: "9.9.9" });
    },
  };
  return { transport, calls };
}

describe("catalogSourceFingerprint: parseJsonField fall-through shapes", () => {
  it("treats a non-object, non-string contents value (e.g. a number) the same as no contents", () => {
    // `parseJsonField` returns null for anything that is neither a plain
    // object nor a JSON string; a bare number falls through both branches to
    // the final `return null`. Pin the fingerprint's OBSERVABLE consequence:
    // it must equal the fingerprint of an explicit `contents: null` row, since
    // both fold to the same parsed value.
    const withNumberContents = catalogSourceFingerprint({
      githubUrl: "https://github.com/o/r",
      contents: 42,
    });
    const withNullContents = catalogSourceFingerprint({
      githubUrl: "https://github.com/o/r",
      contents: null,
    });
    assert.equal(withNumberContents, withNullContents);
  });

  it("treats an array contents value the same as no contents (object-but-array branch)", () => {
    const withArrayContents = catalogSourceFingerprint({
      githubUrl: "https://github.com/o/r",
      contents: [],
    });
    const withNullContents = catalogSourceFingerprint({
      githubUrl: "https://github.com/o/r",
      contents: null,
    });
    assert.equal(withArrayContents, withNullContents);
  });

  it("parses a JSON-string contents value through the string branch (not the no-op fallback)", () => {
    // If `typeof value === "string"` were skipped, a JSON-encoded string
    // would fall all the way through to the final `return null` instead of
    // being parsed — collapsing to the SAME fingerprint as no contents at
    // all. Asserting the two differ pins that the string branch actually ran
    // `JSON.parse`, not that the whole function is a no-op for this input.
    const withJsonString = catalogSourceFingerprint({
      githubUrl: "https://github.com/o/r",
      contents: JSON.stringify({ type: "github" }),
    });
    const withNullContents = catalogSourceFingerprint({
      githubUrl: "https://github.com/o/r",
      contents: null,
    });
    assert.notEqual(withJsonString, withNullContents);
    const withEquivalentObject = catalogSourceFingerprint({
      githubUrl: "https://github.com/o/r",
      contents: { type: "github" },
    });
    assert.equal(withJsonString, withEquivalentObject);
  });

  it("a null githubUrl folds to the empty string in the fingerprint (nullish fallback)", () => {
    const withNull = catalogSourceFingerprint({
      githubUrl: null,
      contents: { type: "github" },
    });
    const withEmpty = catalogSourceFingerprint({
      githubUrl: "",
      contents: { type: "github" },
    });
    // `row.githubUrl ?? ""` means null and "" hash identically; a distinct
    // real URL must still hash differently, so this is not a tautology.
    assert.equal(withNull, withEmpty);
    const withReal = catalogSourceFingerprint({
      githubUrl: "https://github.com/o/r",
      contents: { type: "github" },
    });
    assert.notEqual(withNull, withReal);
  });
});

describe("collectCatalogFetchPlan: marketplace sub-plugin with no marketplace_repo", () => {
  it("falls back to the row's own owner/repo for the manifest lookup and stars fetch", async () => {
    // contents.marketplace_repo is absent, so `mkRepo` resolves to null and
    // every `mkRepo ? … : parsed.*` ternary takes its else branch — the
    // manifest is fetched against the row's OWN github_url, and (since
    // sameAsMarketplace is false when mkRepo is null) its stars are fetched
    // too rather than left null.
    const { transport, calls } = fakeTransport();

    const plan = await collectCatalogFetchPlan(
      [
        {
          packId: "no-marketplace",
          githubUrl: "https://github.com/upstash/context7",
          contents: {
            type: "github-claude-plugin",
            plugin_path: "plugins/context7",
          },
        },
      ],
      { transport }
    );

    assert.equal(plan.entries.length, 1);
    assert.equal(plan.entries[0].stars, 7);
    // `lastRelease: manifest.version || fetched?.release || null` — the
    // manifest's own version ("9.9.9", from the default transport) must win
    // over the upstream release tag ("v1.2.3"), proving the `||` chain
    // short-circuits on the FIRST truthy term rather than the last.
    assert.equal(plan.entries[0].lastRelease, "9.9.9");
    assert.deepEqual(calls.find((c) => c.fn === "fetchPluginManifest")?.args, [
      "upstash",
      "context7",
      "plugins/context7",
    ]);
    assert.deepEqual(calls.find((c) => c.fn === "fetchRepoStats")?.args, [
      "upstash",
      "context7",
    ]);
  });

  it("omits plugin_path from the manifest call when contents carries none (nullish fallback)", async () => {
    const { transport, calls } = fakeTransport();

    await collectCatalogFetchPlan(
      [
        {
          packId: "no-plugin-path",
          githubUrl: "https://github.com/upstash/context7",
          contents: { type: "github-claude-plugin" },
        },
      ],
      { transport }
    );

    assert.deepEqual(calls.find((c) => c.fn === "fetchPluginManifest")?.args, [
      "upstash",
      "context7",
      "",
    ]);
  });

  it("falls back to null stars/forks and lastRelease when the sub-plugin IS the marketplace and the manifest carries no version", async () => {
    // sameAsMarketplace === true, so `stats` is never fetched and `fetched` is
    // null: `fetched?.repo.stargazers_count ?? null` and
    // `fetched?.repo.forks_count ?? null` both take their nullish fallback.
    // Pairing a manifest with NO version also drives `lastRelease` through
    // its full three-term `||` chain to the final `null` fallback (both
    // `manifest.version` and `fetched?.release` are falsy).
    const { transport, calls } = fakeTransport({
      fetchPluginManifest: () =>
        Promise.resolve({ description: "", version: undefined }),
    });

    const plan = await collectCatalogFetchPlan(
      [
        {
          packId: "same-repo-no-version",
          githubUrl: "https://github.com/anthropics/claude-plugins-official",
          contents: {
            type: "github-claude-plugin",
            marketplace_repo: "anthropics/claude-plugins-official",
            plugin_path: "plugins/x",
          },
        },
      ],
      { transport }
    );

    assert.equal(plan.entries.length, 1);
    assert.equal(plan.entries[0].stars, null);
    assert.equal(plan.entries[0].forks, null);
    assert.equal(plan.entries[0].description, null);
    assert.equal(plan.entries[0].lastRelease, null);
    assert.ok(
      !calls.some((c) => c.fn === "fetchRepoStats"),
      "a same-repo sub-plugin must never fetch upstream repo stats"
    );
  });

  it("logs the row's own owner/repo (not a marketplace) when the manifest lookup fails with no marketplace_repo", async () => {
    const { transport } = fakeTransport({
      fetchPluginManifest: () => Promise.resolve(null),
    });
    const warnSpy = vi.spyOn(gatewayLog, "warn").mockImplementation(() => {
      // no-op
    });

    const plan = await collectCatalogFetchPlan(
      [
        {
          packId: "manifest-fails-no-marketplace",
          githubUrl: "https://github.com/upstash/context7",
          contents: { type: "github-claude-plugin" },
        },
      ],
      { transport }
    );

    assert.equal(plan.failed, 1);
    assert.equal(plan.entries.length, 0);
    const [, message] = warnSpy.mock.calls.at(-1) ?? [];
    assert.match(String(message), UPSTASH_CONTEXT7_RE);
    warnSpy.mockRestore();
  });
});

describe("collectCatalogFetchPlan: entries never pushed when the row fails", () => {
  it("does not add an entry to the plan when a standalone repo fetch fails", async () => {
    const { transport } = fakeTransport({
      fetchRepoStats: () =>
        Promise.resolve({
          status: GitHubJsonFetchStatus.NotFound,
          value: null,
        }),
    });

    const plan = await collectCatalogFetchPlan(
      [
        { packId: "p1", githubUrl: "https://github.com/o/r", contents: null },
        {
          packId: "p2",
          githubUrl: "https://github.com/o/r2",
          contents: { type: "github" },
        },
      ],
      { transport }
    );

    // Every row failed, so the entries array must stay at length 0 — the
    // `if (entry) { plan.entries.push(entry) }` false arm for both rows.
    assert.deepEqual(plan.entries, []);
    assert.equal(plan.failed, 2);
  });
});

describe("collectCatalogFetchPlan: standalone repo entry with a nullish star count", () => {
  it("falls back to null stars when the fetched repo stats carry no stargazers_count", async () => {
    const { transport } = fakeTransport({
      fetchRepoStats: () =>
        Promise.resolve({
          status: GitHubJsonFetchStatus.Success,
          value: {
            repo: {
              stargazers_count: undefined as unknown as number,
              forks_count: 4,
              description: "d",
            },
            release: "v2",
          },
        }),
    });

    const plan = await collectCatalogFetchPlan(
      [
        {
          packId: "no-stars",
          githubUrl: "https://github.com/o/r",
          contents: null,
        },
      ],
      { transport }
    );

    assert.equal(plan.entries[0].stars, null);
    assert.equal(plan.entries[0].forks, 4);
  });
});

describe("applyCatalogFetchPlan: apply-time failure classification", () => {
  it("counts a failure whose error is an Error instance and reports its message", async () => {
    const { prisma, close } = await openTestPrisma();
    try {
      await prisma.write((client) =>
        client.$executeRawUnsafe(
          `INSERT INTO pack_catalog (pack_id, display_name, github_url, contents)
           VALUES ('p1', 'P1', 'https://github.com/o/p1', '{"type":"github"}')`
        )
      );
      const rows = await prisma.client.packCatalog.findMany({
        select: { packId: true, githubUrl: true, contents: true },
      });
      const sourceFingerprint = catalogSourceFingerprint(
        rows[0] as { githubUrl: string; contents: unknown }
      );

      const warnSpy = vi.spyOn(gatewayLog, "warn").mockImplementation(() => {
        // no-op
      });

      // `lastRelease` is a real column but `stars`/`forks` must be a number or
      // null and `description` a string or null; passing an object where a
      // primitive is required makes the underlying write reject with a genuine
      // driver error — never a fabricated non-Error rejection.
      const summary = await applyCatalogFetchPlan(prisma, {
        startedAt: new Date().toISOString(),
        skipped: 0,
        failed: 0,
        bundled: 0,
        entries: [
          {
            packId: "p1",
            sourceFingerprint,
            stars: { bad: "shape" } as unknown as number,
            forks: null,
            description: null,
            lastRelease: null,
          },
        ],
      });

      assert.equal(summary.succeeded, 0);
      assert.equal(summary.failed, 1);
      const warnCall = warnSpy.mock.calls.find(([, message]) =>
        String(message).includes("applyFetchResult failed for p1")
      );
      assert.ok(warnCall, "the apply failure must be logged with the pack id");
      warnSpy.mockRestore();
    } finally {
      await close();
    }
  });
});

describe("runCatalogFetch: the read-failure fallback path", () => {
  it("returns a zeroed summary with no ended_at and logs when the catalog read throws", async () => {
    const { prisma, close } = await openTestPrisma();
    const warnSpy = vi.spyOn(gatewayLog, "warn").mockImplementation(() => {
      // no-op
    });
    try {
      // Drop the table the read depends on so `readCatalogFetchRows` rejects
      // with a genuine driver error ("no such table") — a real SQL failure,
      // not a fabricated rejection value.
      await prisma.write((client) =>
        client.$executeRawUnsafe("DROP TABLE pack_catalog")
      );

      const summary = await runCatalogFetch(prisma);

      // The catch-path return literal has NO `ended_at` key at all — a fully
      // successful run always sets one, so this pins that the early return
      // (not a normal completion with zero rows) produced this summary.
      assert.deepEqual(summary, {
        started_at: summary.started_at,
        succeeded: 0,
        failed: 0,
        skipped: 0,
        bundled: 0,
      });
      assert.equal("ended_at" in summary, false);
      assert.ok(summary.started_at);
      const warnCall = warnSpy.mock.calls.find(([, message]) =>
        String(message).includes("cannot read pack_catalog")
      );
      assert.ok(warnCall, "the read failure must be logged");
    } finally {
      warnSpy.mockRestore();
      await close();
    }
  });
});

describe("scheduleCatalogFetch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the default interval when none is supplied", () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const handle = scheduleCatalogFetch(run);
    try {
      // The default is 24h; nothing should fire before then, and the first
      // tick at exactly 24h proves the default (not a caller-supplied) value
      // was armed.
      vi.advanceTimersByTime(24 * 60 * 60 * 1000 - 1);
      expect(run).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      clearInterval(handle);
    }
  });

  it("calls unref() on a handle that has it, using a real Node timer", () => {
    // Fake timers' handle may or may not exercise the SAME code path a real
    // `NodeJS.Timeout` does; use the real `setInterval` here so
    // `typeof handle.unref === "function"` is genuinely true. A freshly
    // created Node timer's `hasRef()` reports true until `unref()` is
    // called, so observing `false` proves `handle.unref()` genuinely ran —
    // not merely that the guard's condition was true.
    vi.useRealTimers();
    try {
      const handle = scheduleCatalogFetch(vi.fn().mockResolvedValue(undefined));
      try {
        assert.equal(
          (handle as unknown as { hasRef: () => boolean }).hasRef(),
          false,
          "scheduleCatalogFetch must have called unref() on a real Node timer"
        );
      } finally {
        clearInterval(handle);
      }
    } finally {
      vi.useFakeTimers();
    }
  });

  it("logs an Error's message when the scheduled run rejects with an Error", async () => {
    const warnSpy = vi.spyOn(gatewayLog, "warn").mockImplementation(() => {
      // no-op
    });
    const run = vi.fn().mockRejectedValue(new Error("boom"));
    const handle = scheduleCatalogFetch(run, 10);
    try {
      await vi.advanceTimersByTimeAsync(10);
      const warnCall = warnSpy.mock.calls.find(([, message]) =>
        String(message).includes("scheduled run failed: boom")
      );
      assert.ok(warnCall, "an Error rejection must log its .message");
    } finally {
      clearInterval(handle);
      warnSpy.mockRestore();
    }
  });

  it("stringifies a non-Error rejection from the scheduled run", async () => {
    const warnSpy = vi.spyOn(gatewayLog, "warn").mockImplementation(() => {
      // no-op
    });
    // The caller's `run` thunk is a plain injected callback (not a DB/fs/
    // network boundary), so it is free to reject with any value — a
    // non-Error rejection is real, reachable input at this seam.
    const run = vi.fn().mockRejectedValue("plain string failure");
    const handle = scheduleCatalogFetch(run, 10);
    try {
      await vi.advanceTimersByTimeAsync(10);
      const warnCall = warnSpy.mock.calls.find(([, message]) =>
        String(message).includes("scheduled run failed: plain string failure")
      );
      assert.ok(warnCall, "a non-Error rejection must be String()-ified");
    } finally {
      clearInterval(handle);
      warnSpy.mockRestore();
    }
  });

  it("does not throw when the returned handle lacks unref (non-Node timer shape)", () => {
    // `typeof handle.unref === "function"` false arm: stub setInterval to
    // return a plain numeric-like handle with no unref, mirroring a
    // browser-style timer handle. Real global replacement (not a module
    // mock), restored immediately after.
    const originalSetInterval = globalThis.setInterval;
    const fakeHandle = { fake: true } as unknown as ReturnType<
      typeof setInterval
    >;
    // A 0-arg stub cannot structurally satisfy every `setInterval` overload,
    // so this narrow, test-only replacement goes through `unknown` — grit's
    // double-cast gate exempts test files.
    globalThis.setInterval = (() =>
      fakeHandle) as unknown as typeof setInterval;
    try {
      const handle = scheduleCatalogFetch(vi.fn().mockResolvedValue(undefined));
      assert.equal(handle, fakeHandle);
    } finally {
      globalThis.setInterval = originalSetInterval;
    }
  });
});
