/**
 * @file catalog-github-client-transport.test.ts
 * @description ISS-8640 — the catalog GitHub client uses unauthenticated REST
 * only. The child-process mock stays installed so any accidental `gh` spawn is
 * observable, while `https.get` answers only from explicit fixtures.
 */

import { afterEach, assert, beforeEach, expect, test, vi } from "vitest";
import {
  contentsEndpoint,
  fetchPluginManifest,
  fetchRepoStats,
  GitHubJsonFetchStatus,
  parseGithubUrl,
} from "../src/main/packs/catalog-github-client.js";

const execFileMock = vi.hoisted(() => vi.fn());
const httpsGetMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ execFile: execFileMock }));
vi.mock("node:https", () => ({ default: { get: httpsGetMock } }));

/** The pinned transport settings, restated as literals so a drift fails here. */
const EXPECTED_TIMEOUT_MS = 5000;
const EXPECTED_USER_AGENT = "closedloop-electron-agent-monitor";

type RestOutcome = { statusCode: number; body: string } | { kind: "timeout" };

/** `https.get` path → what the fake socket does. Absent ⇒ socket error. */
const restResponses = new Map<string, RestOutcome>();

/** Every `https.get` options object, in order. */
const restOptions: Array<{
  host?: string;
  path?: string;
  timeout?: number;
  headers?: Record<string, string>;
}> = [];
/** Fake request handles handed back by `https.get`, in order. */
const restRequests: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];

function makeResponse(statusCode: number, body: string) {
  const handlers = new Map<string, (chunk?: string) => void>();
  const res = {
    statusCode,
    setEncoding: vi.fn(),
    resume: vi.fn(),
    on(event: string, handler: (chunk?: string) => void) {
      handlers.set(event, handler);
      if (event === "end") {
        queueMicrotask(() => {
          handlers.get("data")?.(body);
          handlers.get("end")?.();
        });
      }
      return res;
    },
  };
  return res;
}

beforeEach(() => {
  restResponses.clear();
  restOptions.length = 0;
  restRequests.length = 0;

  execFileMock.mockReset();
  execFileMock.mockImplementation((...args: unknown[]) => {
    const done = args.at(-1) as (
      err: Error | null,
      out?: { stdout: string; stderr: string }
    ) => void;
    done(new Error("gh must not be spawned by catalog-github-client"));
  });

  httpsGetMock.mockReset();
  httpsGetMock.mockImplementation(
    (
      options: { path: string },
      onResponse: (res: ReturnType<typeof makeResponse>) => void
    ) => {
      restOptions.push(options);
      const listeners = new Map<string, () => void>();
      const req = {
        destroy: vi.fn(),
        on(event: string, handler: () => void) {
          listeners.set(event, handler);
          return req;
        },
      };
      restRequests.push(req);
      const outcome = restResponses.get(options.path);
      queueMicrotask(() => {
        if (outcome === undefined || "kind" in outcome) {
          listeners.get(outcome?.kind === "timeout" ? "timeout" : "error")?.();
          return;
        }
        onResponse(makeResponse(outcome.statusCode, outcome.body));
      });
      return req;
    }
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("fetchRepoStats uses REST for repo and release without spawning gh", async () => {
  restResponses.set("/repos/acme/widgets", {
    statusCode: 200,
    body: JSON.stringify({
      stargazers_count: 42,
      forks_count: 7,
      description: "hi",
    }),
  });
  restResponses.set("/repos/acme/widgets/releases/latest", {
    statusCode: 200,
    body: JSON.stringify({ tag_name: "v1.2.3" }),
  });

  const stats = await fetchRepoStats("acme", "widgets");

  assert.deepEqual(stats, {
    status: "success",
    value: {
      repo: { stargazers_count: 42, forks_count: 7, description: "hi" },
      release: "v1.2.3",
    },
  });
  assert.deepEqual(
    restOptions.map((o) => o.path),
    ["/repos/acme/widgets", "/repos/acme/widgets/releases/latest"]
  );
  assert.deepEqual(restOptions[0]?.host, "api.github.com");
  assert.deepEqual(restOptions[0]?.timeout, EXPECTED_TIMEOUT_MS);
  assert.deepEqual(
    restOptions[0]?.headers?.["User-Agent"],
    EXPECTED_USER_AGENT
  );
  expect(execFileMock).not.toHaveBeenCalled();
});

test("a failed repo call reports unavailable without fetching release", async () => {
  restResponses.set("/repos/acme/widgets", { statusCode: 500, body: "{}" });
  restResponses.set("/repos/acme/widgets/releases/latest", {
    statusCode: 200,
    body: JSON.stringify({ tag_name: "must-not-fetch" }),
  });

  const stats = await fetchRepoStats("acme", "widgets");

  assert.deepEqual(stats, { status: "unavailable", value: null });
  assert.deepEqual(
    restOptions.map((o) => o.path),
    ["/repos/acme/widgets"]
  );
  expect(execFileMock).not.toHaveBeenCalled();
});

test("a repo with no latest release still returns repo stats with a null release", async () => {
  restResponses.set("/repos/acme/widgets", {
    statusCode: 200,
    body: JSON.stringify({
      stargazers_count: 42,
      forks_count: 7,
      description: "hi",
    }),
  });
  restResponses.set("/repos/acme/widgets/releases/latest", {
    statusCode: 404,
    body: JSON.stringify({ message: "Not Found" }),
  });

  const stats = await fetchRepoStats("acme", "widgets");

  assert.deepEqual(stats, {
    status: "success",
    value: {
      repo: { stargazers_count: 42, forks_count: 7, description: "hi" },
      release: null,
    },
  });
  assert.deepEqual(
    restOptions.map((o) => o.path),
    ["/repos/acme/widgets", "/repos/acme/widgets/releases/latest"]
  );
  expect(execFileMock).not.toHaveBeenCalled();
});

test("a release lookup rate limit makes repo stats unavailable rather than partially fresh", async () => {
  restResponses.set("/repos/acme/widgets", {
    statusCode: 200,
    body: JSON.stringify({
      stargazers_count: 42,
      forks_count: 7,
      description: "hi",
    }),
  });
  restResponses.set("/repos/acme/widgets/releases/latest", {
    statusCode: 403,
    body: JSON.stringify({
      message: "API rate limit exceeded",
      documentation_url:
        "https://docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api",
    }),
  });

  const stats = await fetchRepoStats("acme", "widgets");

  assert.deepEqual(stats, { status: "unavailable", value: null });
  assert.deepEqual(
    restOptions.map((o) => o.path),
    ["/repos/acme/widgets", "/repos/acme/widgets/releases/latest"]
  );
  expect(execFileMock).not.toHaveBeenCalled();
});

/**
 * ISS-10605: a 404 and a 403 both used to arrive as a bare `null`, so the caller
 * could not say whether retrying had any chance of a different answer. A repo
 * that is absent or private stays absent; a rate limit clears on its own. The
 * statuses are asserted as literals rather than through the enum so a rename
 * that silently re-pairs the two cases still fails here.
 */
test("a 404 reports NotFound while a 403 or malformed body reports Unavailable", async () => {
  restResponses.set("/repos/acme/gone", {
    statusCode: 404,
    body: JSON.stringify({
      message: "Not Found",
      documentation_url: "https://docs.github.com/rest",
    }),
  });
  restResponses.set("/repos/acme/rate-limited", {
    statusCode: 403,
    body: JSON.stringify({
      message: "API rate limit exceeded",
      documentation_url:
        "https://docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api",
    }),
  });
  restResponses.set("/repos/acme/garbled", {
    statusCode: 200,
    body: "<html>rate limited</html>",
  });

  assert.deepEqual(await fetchRepoStats("acme", "gone"), {
    status: "not_found",
    value: null,
  });
  assert.deepEqual(await fetchRepoStats("acme", "rate-limited"), {
    status: "unavailable",
    value: null,
  });
  assert.deepEqual(await fetchRepoStats("acme", "garbled"), {
    status: "unavailable",
    value: null,
  });
  // The enum must actually carry the two spellings this test hardcodes, or the
  // literals above would pin a vocabulary the production code no longer speaks.
  assert.equal(GitHubJsonFetchStatus.NotFound, "not_found");
  assert.equal(GitHubJsonFetchStatus.Unavailable, "unavailable");
  // The release call is only reached when the repo call produced stats, so a
  // null repo must cost exactly one request, not two.
  assert.deepEqual(
    restOptions.map((o) => o.path),
    ["/repos/acme/gone", "/repos/acme/rate-limited", "/repos/acme/garbled"]
  );
});

test("a socket timeout destroys the request and reports unavailable rather than hanging or throwing", async () => {
  restResponses.set("/repos/acme/slow", { kind: "timeout" });

  const stats = await fetchRepoStats("acme", "slow");

  // ISS-10605 changed the representation, not the meaning: a timeout was always
  // the retryable class, and it must land there rather than in NotFound, which
  // would tell the caller to stop trying.
  assert.deepEqual(stats, { status: "unavailable", value: null });
  expect(restRequests[0]?.destroy).toHaveBeenCalledTimes(1);
});

test("fetchPluginManifest reads plugin manifests over REST", async () => {
  restResponses.set(
    "/repos/acme/market/contents/plugins/tools/.claude-plugin/plugin.json",
    {
      statusCode: 200,
      body: JSON.stringify({ description: "Tools", version: "2.0.0" }),
    }
  );

  const manifest = await fetchPluginManifest("acme", "market", "plugins/tools");

  assert.deepEqual(manifest, { description: "Tools", version: "2.0.0" });
  expect(execFileMock).not.toHaveBeenCalled();
  assert.deepEqual(
    restOptions[0]?.headers?.["User-Agent"],
    EXPECTED_USER_AGENT
  );
  assert.deepEqual(
    restOptions[0]?.headers?.Accept,
    "application/vnd.github.raw"
  );
  assert.deepEqual(restOptions[0]?.timeout, EXPECTED_TIMEOUT_MS);
});

test("fetchPluginManifest maps a realistic JSON 403 rate-limit response to null", async () => {
  restResponses.set(
    "/repos/acme/market/contents/plugins/tools/.claude-plugin/plugin.json",
    {
      statusCode: 403,
      body: JSON.stringify({
        message: "API rate limit exceeded",
        documentation_url:
          "https://docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api",
      }),
    }
  );

  const manifest = await fetchPluginManifest("acme", "market", "plugins/tools");

  assert.equal(manifest, null);
  expect(execFileMock).not.toHaveBeenCalled();
});

test("fetchPluginManifest never spawns gh, whatever is on the runner's PATH", async () => {
  restResponses.set(
    "/repos/acme/market/contents/plugins/tools/.claude-plugin/plugin.json",
    { statusCode: 200, body: JSON.stringify({ version: "0.1.0" }) }
  );

  const manifest = await fetchPluginManifest("acme", "market", "plugins/tools");

  assert.deepEqual(manifest, { version: "0.1.0" });
  expect(execFileMock).not.toHaveBeenCalled();
});

/**
 * ISS-7951. The `.git` cases below are real coverage now, and were not before:
 * `GITHUB_URL_PATTERN`'s repo capture used to exclude `.`, so it stopped before
 * the suffix and `TRAILING_DOT_GIT` never ran — an assertion on such a URL was
 * green with the strip deleted. Both halves of that are pinned here: the strip
 * has to run for `widgets.git`, and it has to NOT run for `next.js`.
 */
test("parseGithubUrl keeps a dotted repository name instead of truncating it at the dot", () => {
  // The defect: `[^/?#.]+` yielded `next`, whose lookup 404s into a null the
  // catalog renders as a pack with no stars and no forks.
  assert.deepEqual(parseGithubUrl("https://github.com/vercel/next.js"), {
    owner: "vercel",
    repo: "next.js",
  });
  assert.deepEqual(parseGithubUrl("https://github.com/socketio/socket.io"), {
    owner: "socketio",
    repo: "socket.io",
  });
  // A dotted name that ALSO carries the clone suffix: only the suffix goes.
  assert.deepEqual(parseGithubUrl("git@github.com:vercel/next.js.git"), {
    owner: "vercel",
    repo: "next.js",
  });
});

test("parseGithubUrl resolves every documented URL form", () => {
  assert.deepEqual(parseGithubUrl("https://github.com/acme/widgets"), {
    owner: "acme",
    repo: "widgets",
  });
  assert.deepEqual(parseGithubUrl("https://github.com/acme/widgets/"), {
    owner: "acme",
    repo: "widgets",
  });
  assert.deepEqual(parseGithubUrl("https://github.com/acme/widgets.git"), {
    owner: "acme",
    repo: "widgets",
  });
  assert.deepEqual(
    parseGithubUrl("https://github.com/acme/widgets/tree/main"),
    {
      owner: "acme",
      repo: "widgets",
    }
  );
  assert.deepEqual(
    parseGithubUrl("https://github.com/acme/widgets?tab=readme-ov-file"),
    { owner: "acme", repo: "widgets" }
  );
  assert.deepEqual(parseGithubUrl("https://github.com/acme/widgets#install"), {
    owner: "acme",
    repo: "widgets",
  });
  assert.deepEqual(parseGithubUrl("https://github.com/acme/widgets.name"), {
    owner: "acme",
    repo: "widgets.name",
  });
  assert.deepEqual(parseGithubUrl("git@github.com:acme/widgets.git"), {
    owner: "acme",
    repo: "widgets",
  });
});

/**
 * The docstring's accepted list is exhaustive, and the bare `owner/repo` form
 * it used to claim is NOT on it. `marketplaceSourceRepo` in `catalog-contents`
 * is the one caller holding a bare pair and it wraps it in `https://github.com/`
 * first, so accepting it here would only widen the parser to every two-segment
 * string in the corpus.
 */
test("parseGithubUrl does not accept the bare owner/repo form its callers wrap", () => {
  assert.equal(parseGithubUrl("acme/widgets.name"), null);
  assert.deepEqual(parseGithubUrl("https://github.com/acme/widgets.name"), {
    owner: "acme",
    repo: "widgets.name",
  });
});

/**
 * The pattern used to be unanchored, so `github.com` ANYWHERE in the string was
 * a match and the catalog fetched a repository the row never named. Each case
 * here resolved to a real `owner/repo` before ISS-7951 anchored it.
 */
test("parseGithubUrl rejects a host that merely contains github.com", () => {
  assert.equal(parseGithubUrl("https://notgithub.com/acme/widgets"), null);
  assert.equal(
    parseGithubUrl("https://github.com.evil.example/acme/widgets"),
    null
  );
  assert.equal(
    parseGithubUrl("https://evil.example/mirror/github.com/acme/widgets"),
    null
  );
  assert.equal(
    parseGithubUrl("https://api.github.com/repos/acme/widgets"),
    null
  );
});

/**
 * Without a boundary after the repo segment the character class simply stopped
 * at the first character it did not admit, so an encoded separator truncated to
 * a DIFFERENT, real repository instead of being refused. A dots-only segment is
 * the same failure with teeth: `owner` is interpolated straight into
 * `/repos/${owner}/${repo}`, so `..` would traverse the REST path.
 */
test("parseGithubUrl refuses a segment carrying characters GitHub does not permit", () => {
  assert.equal(
    parseGithubUrl("https://github.com/acme/widgets%2Fprivate"),
    null
  );
  assert.equal(parseGithubUrl("https://github.com/acme/wid gets"), null);
  assert.equal(parseGithubUrl("https://github.com/../widgets"), null);
  assert.equal(parseGithubUrl("https://github.com/acme/.."), null);
});

test("parseGithubUrl returns null for input it cannot resolve rather than a truncated guess", () => {
  assert.equal(parseGithubUrl("https://gitlab.com/acme/widgets"), null);
  assert.equal(parseGithubUrl(null), null);
  assert.equal(parseGithubUrl(undefined), null);
  assert.equal(parseGithubUrl(""), null);
  // An owner with no repository segment.
  assert.equal(parseGithubUrl("https://github.com/acme"), null);
  assert.equal(parseGithubUrl("https://github.com/acme/"), null);
  // Nothing survives the `.git` strip, so there is no repo to look up.
  assert.equal(parseGithubUrl("https://github.com/acme/.git"), null);
});

/**
 * ISS-8883. `encodeURI` on the joined path left `#` and `?` alone and, being
 * a whole-path encoder, could not refuse `..` — and `encodeURIComponent` does
 * not either (`encodeURIComponent("..") === ".."`), so per-segment encoding
 * comes with a segment refusal.
 */
const ENCODED_MANIFEST_REST =
  "repos/acme/market/contents/plugins/a%23b/.claude-plugin/plugin.json";
const ENCODED_MANIFEST_REST_PATH = `/${ENCODED_MANIFEST_REST}`;

test("ISS-8883 fetchPluginManifest percent-encodes a `#` in the plugin path over REST", async () => {
  restResponses.set(ENCODED_MANIFEST_REST_PATH, {
    statusCode: 200,
    body: JSON.stringify({ version: "2.0.0" }),
  });

  const manifest = await fetchPluginManifest("acme", "market", "plugins/a#b");

  assert.deepEqual(manifest, { version: "2.0.0" });
  expect(execFileMock).not.toHaveBeenCalled();
  assert.deepEqual(restOptions[0]?.path, ENCODED_MANIFEST_REST_PATH);
});

test("ISS-8883 fetchPluginManifest issues no request for a traversing plugin path", async () => {
  restResponses.set(
    "/repos/acme/market/contents/../x/.claude-plugin/plugin.json",
    {
      statusCode: 200,
      body: JSON.stringify({ version: "must-not-serve" }),
    }
  );

  assert.equal(await fetchPluginManifest("acme", "market", "../x"), null);
  expect(execFileMock).not.toHaveBeenCalled();
  expect(httpsGetMock).not.toHaveBeenCalled();
});

test("ISS-8883 contentsEndpoint refuses an empty, `.` or `..` segment and encodes every other one", () => {
  for (const refused of ["", ".", "..", "a/../b", "/a", "a/", "a//b"]) {
    assert.equal(contentsEndpoint("o", "r", refused), null, refused);
  }
  assert.equal(
    contentsEndpoint("o", "r", "a/b c/d#e"),
    "repos/o/r/contents/a/b%20c/d%23e"
  );
  assert.equal(
    contentsEndpoint("o", "r", "plugins/code-review"),
    "repos/o/r/contents/plugins/code-review"
  );
});
