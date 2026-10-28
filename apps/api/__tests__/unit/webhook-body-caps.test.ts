/**
 * ISS-7665. The four webhook receivers read the raw body BEFORE verifying the
 * signature over it, so the read is the one anonymous buffering surface a
 * default cap cannot cover. Each arm here is paired on purpose: a one-sided
 * "over-cap is refused" test passes just as well against a receiver that
 * refuses everything.
 */
import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockEnv,
  mockHeaders,
  mockLogFlush,
  mockLogWarn,
  mockSvixVerify,
  mockVerifyRequest,
} = vi.hoisted(() => ({
  mockEnv: {
    CLERK_WEBHOOK_SECRET: "whsec_test",
    SLACK_SIGNING_SECRET: "slack-signing-secret",
  },
  mockHeaders: vi.fn(),
  mockLogFlush: vi.fn(async () => undefined),
  mockLogWarn: vi.fn(),
  mockSvixVerify: vi.fn(),
  mockVerifyRequest: vi.fn(),
}));

vi.mock("@/env", () => ({ env: mockEnv }));

vi.mock("next/headers", () => ({ headers: mockHeaders }));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
    flush: mockLogFlush,
    info: vi.fn(),
    warn: mockLogWarn,
  },
}));

vi.mock("@repo/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/github")>()),
  verifyWebhookSignature: vi.fn(),
}));

vi.mock("svix", () => ({
  Webhook: class {
    verify = mockSvixVerify;
  },
}));

vi.mock("@repo/analytics/server", () => ({
  analytics: { shutdown: vi.fn() },
}));

vi.mock("@repo/collaboration/server/webhook", () => ({
  createWebhookHandler: () => ({ verifyRequest: mockVerifyRequest }),
}));

vi.mock("@/app/webhooks/liveblocks/handlers", () => ({
  handleCommentCreated: vi.fn(),
  handleCommentDeleted: vi.fn(),
  handleCommentEdited: vi.fn(),
  handleCommentReactionAdded: vi.fn(),
  handleCommentReactionRemoved: vi.fn(),
  handleThreadCreated: vi.fn(),
  handleThreadDeleted: vi.fn(),
  handleThreadResolved: vi.fn(),
  handleThreadUnresolved: vi.fn(),
}));

vi.mock("@/app/webhooks/slack/handlers", () => ({
  handleCreateIdea: vi.fn(async () => ({ text: "created" })),
  handleGetStatus: vi.fn(async () => ({ text: "status" })),
}));

vi.mock("@/app/webhooks/auth/auth-hooks", () => ({
  handleOrganizationCreated: vi.fn(),
  handleOrganizationDeleted: vi.fn(),
  handleOrganizationMembershipCreated: vi.fn(),
  handleOrganizationMembershipDeleted: vi.fn(),
  handleOrganizationMembershipUpdated: vi.fn(),
  handleOrganizationUpdated: vi.fn(),
  handleUserCreated: vi.fn(),
  handleUserDeleted: vi.fn(),
  handleUserUpdated: vi.fn(),
}));

import { verifyWebhookSignature } from "@repo/github";
import { log } from "@repo/observability/log";
import {
  countedEndlessBody,
  maxPullForCap,
  streamRequest,
} from "@/__tests__/utils/bounded-body.test-helpers";
import { POST as authPost } from "@/app/webhooks/auth/route";
import { POST as githubPost } from "@/app/webhooks/github/route";
import { POST as liveblocksPost } from "@/app/webhooks/liveblocks/route";
import { POST as slackPost } from "@/app/webhooks/slack/route";
import { slackVerifyWebhookSignature } from "@/app/webhooks/slack/webhook-utils";
import {
  CLERK_WEBHOOK_MAX_BYTES,
  GITHUB_WEBHOOK_MAX_BYTES,
  LIVEBLOCKS_WEBHOOK_MAX_BYTES,
  readVerifiableWebhookBody,
  SLACK_WEBHOOK_MAX_BYTES,
} from "@/app/webhooks/webhook-body";
import {
  REQUEST_BODY_OVER_CAP_EVENT,
  REQUEST_COMPLETED_EVENT,
} from "@/lib/route-utils";

const PAYLOAD_TOO_LARGE = 413;
const UNAUTHORIZED = 401;
const SLACK_TIMESTAMP = "1787439480";
const PINNED_CLOCK_MS = Number(SLACK_TIMESTAMP) * 1000;
const OVER_CAP_BODY = { message: "Request body too large", ok: false };
const GITHUB_ENV_KEYS = [
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_WEBHOOK_SECRET",
];

// `.env.local` is loaded by __tests__/setup.ts, so these keys can arrive with
// real values; the suite fakes them and must hand back exactly what it found.
const GITHUB_ENV_BEFORE_SUITE = readGitHubEnv();
let githubEnvBeforeTest = GITHUB_ENV_BEFORE_SUITE;

// File-level, not per-describe: the pinned-clock arms live in two describes,
// and a `vi.useRealTimers()` written at the end of a test body is skipped by
// the first failing assertion above it, leaking the fake clock into the rest
// of the worker.
afterEach(() => {
  vi.useRealTimers();
  restoreGitHubEnv(githubEnvBeforeTest);
});

describe("webhook receivers bound the pre-verification body read", () => {
  beforeEach(armConfiguredReceivers);

  it("hands GitHub an at-cap body through to signature verification, byte for byte", async () => {
    mockHeaders.mockResolvedValue(
      new Headers({ "x-hub-signature-256": "sha256=deadbeef" })
    );
    const body = padTo(GITHUB_WEBHOOK_MAX_BYTES);

    const response = await githubPost(makeRequest("github", body));

    expect(response.status).toBe(UNAUTHORIZED);
    expect(verifyWebhookSignature).toHaveBeenCalledTimes(1);
    expect(receivedBodyDigest(vi.mocked(verifyWebhookSignature))).toBe(
      sha256(body)
    );
    expect(overCapWarnings()).toHaveLength(0);
  });

  it("refuses a GitHub body one byte over the cap before verification runs", async () => {
    mockHeaders.mockResolvedValue(
      new Headers({ "x-hub-signature-256": "sha256=deadbeef" })
    );

    const response = await githubPost(
      makeRequest("github", padTo(GITHUB_WEBHOOK_MAX_BYTES + 1))
    );

    expect(response.status).toBe(PAYLOAD_TOO_LARGE);
    await expect(response.json()).resolves.toEqual(OVER_CAP_BODY);
    expect(verifyWebhookSignature).not.toHaveBeenCalled();
    expect(overCapWarnings()).toEqual([
      {
        maxBytes: GITHUB_WEBHOOK_MAX_BYTES,
        method: "POST",
        path: "/webhooks/github",
      },
    ]);
    expect(requestCompletedRecords()).toEqual([
      expect.objectContaining({
        path: "/webhooks/github",
        status_code: PAYLOAD_TOO_LARGE,
      }),
    ]);
  });

  it("hands Clerk an at-cap body through to svix verification, byte for byte", async () => {
    mockHeaders.mockResolvedValue(svixHeaders());
    const body = padTo(CLERK_WEBHOOK_MAX_BYTES);

    const response = await authPost(makeRequest("auth", body));

    expect(response.status).toBe(400);
    expect(mockSvixVerify).toHaveBeenCalledTimes(1);
    expect(receivedBodyDigest(mockSvixVerify)).toBe(sha256(body));
    expect(overCapWarnings()).toHaveLength(0);
  });

  it("refuses a Clerk body one byte over the cap before verification runs", async () => {
    mockHeaders.mockResolvedValue(svixHeaders());

    const response = await authPost(
      makeRequest("auth", padTo(CLERK_WEBHOOK_MAX_BYTES + 1))
    );

    expect(response.status).toBe(PAYLOAD_TOO_LARGE);
    await expect(response.json()).resolves.toEqual(OVER_CAP_BODY);
    expect(mockSvixVerify).not.toHaveBeenCalled();
    expect(overCapWarnings()).toEqual([
      {
        maxBytes: CLERK_WEBHOOK_MAX_BYTES,
        method: "POST",
        path: "/webhooks/auth",
      },
    ]);
    expect(requestCompletedRecords()).toEqual([
      expect.objectContaining({
        path: "/webhooks/auth",
        status_code: PAYLOAD_TOO_LARGE,
      }),
    ]);
  });

  it("verifies a real Slack signature over an at-cap body end to end", async () => {
    const body = padTo(SLACK_WEBHOOK_MAX_BYTES, "command=%2Funknown&text=");
    mockHeaders.mockResolvedValue(
      new Headers({
        "x-slack-request-timestamp": SLACK_TIMESTAMP,
        "x-slack-signature": slackSignature(body),
      })
    );
    vi.setSystemTime(Number(SLACK_TIMESTAMP) * 1000);

    const response = await slackPost(makeRequest("slack", body));

    // Not 401: the digest computed over the body the bounded read produced
    // matched the one Slack computed over the bytes it sent.
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(overCapWarnings()).toHaveLength(0);
  });

  it("refuses a Slack body one byte over the cap before verification runs", async () => {
    const body = padTo(SLACK_WEBHOOK_MAX_BYTES + 1, "command=%2Funknown&text=");
    mockHeaders.mockResolvedValue(
      new Headers({
        "x-slack-request-timestamp": SLACK_TIMESTAMP,
        "x-slack-signature": slackSignature(body),
      })
    );
    vi.setSystemTime(Number(SLACK_TIMESTAMP) * 1000);

    const response = await slackPost(makeRequest("slack", body));

    expect(response.status).toBe(PAYLOAD_TOO_LARGE);
    await expect(response.json()).resolves.toEqual(OVER_CAP_BODY);
    expect(overCapWarnings()).toEqual([
      {
        maxBytes: SLACK_WEBHOOK_MAX_BYTES,
        method: "POST",
        path: "/webhooks/slack",
      },
    ]);
    expect(requestCompletedRecords()).toEqual([
      expect.objectContaining({
        path: "/webhooks/slack",
        status_code: PAYLOAD_TOO_LARGE,
      }),
    ]);
  });

  it("hands Liveblocks an at-cap body through to signature verification, byte for byte", async () => {
    const body = padTo(LIVEBLOCKS_WEBHOOK_MAX_BYTES);

    const response = await liveblocksPost(makeRequest("liveblocks", body));

    expect(response.status).toBe(UNAUTHORIZED);
    expect(mockVerifyRequest).toHaveBeenCalledTimes(1);
    expect(sha256(mockVerifyRequest.mock.calls[0][0].rawBody)).toBe(
      sha256(body)
    );
    expect(overCapWarnings()).toHaveLength(0);
  });

  it("refuses a Liveblocks body one byte over the cap before verification runs", async () => {
    const response = await liveblocksPost(
      makeRequest("liveblocks", padTo(LIVEBLOCKS_WEBHOOK_MAX_BYTES + 1))
    );

    expect(response.status).toBe(PAYLOAD_TOO_LARGE);
    await expect(response.json()).resolves.toEqual(OVER_CAP_BODY);
    expect(mockVerifyRequest).not.toHaveBeenCalled();
    expect(overCapWarnings()).toEqual([
      {
        maxBytes: LIVEBLOCKS_WEBHOOK_MAX_BYTES,
        method: "POST",
        path: "/webhooks/liveblocks",
      },
    ]);
    expect(requestCompletedRecords()).toEqual([
      expect.objectContaining({
        path: "/webhooks/liveblocks",
        status_code: PAYLOAD_TOO_LARGE,
      }),
    ]);
  });

  it("cancels an endless body instead of buffering it", async () => {
    // The whole point of the ticket: an anonymous caller must not be able to
    // make the process hold arbitrary bytes. A reader that measured after
    // buffering would drain this stream to its safety ceiling.
    const cap = 65_536;
    const endless = countedEndlessBody(cap);

    const result = await readVerifiableWebhookBody(
      streamRequest("https://api.test/webhooks/github", endless.body),
      cap
    );

    expect(result.response?.status).toBe(PAYLOAD_TOO_LARGE);
    await expect(result.response?.json()).resolves.toEqual(OVER_CAP_BODY);
    expect(endless.cancelled()).toBe(true);
    expect(endless.bytesPulled()).toBeLessThanOrEqual(maxPullForCap(cap));
  });

  it.each([
    ["a leading UTF-8 BOM", [0xef, 0xbb, 0xbf, 0x7b, 0x7d]],
    ["an invalid byte sequence", [0x7b, 0xff, 0xfe, 0x7d]],
    ["a truncated multi-byte sequence", [0x7b, 0xe2, 0x82, 0x7d]],
  ])("decodes %s exactly as request.text() would", async (_label, bytes) => {
    // The verifiers sign over the decoded string, so any divergence from
    // `request.text()` here rejects real deliveries with nothing but a 401 to
    // show for it. A BOM is the dangerous one: it decodes away silently.
    const payload = new Uint8Array(bytes);
    const expected = await new Request("https://api.test/webhooks/github", {
      method: "POST",
      body: payload,
    }).text();

    const result = await readVerifiableWebhookBody(
      new Request("https://api.test/webhooks/github", {
        method: "POST",
        body: payload,
      }),
      10_000
    );

    expect(result.body).toBe(expected);
  });

  it("preserves multi-byte characters split across stream chunks", async () => {
    // The HMAC is over the decoded text, so a chunk boundary landing mid
    // code-point would silently change the digest on real traffic only.
    const payload = `{"note":"${"é🎈ü".repeat(4096)}"}`;
    const request = new Request("https://api.test/webhooks/github", {
      method: "POST",
      body: payload,
    });

    const result = await readVerifiableWebhookBody(request, 10_000_000);

    expect(result.response).toBeNull();
    expect(result.body).toBe(payload);
    expect(sha256(result.body ?? "")).toBe(sha256(payload));
  });
});

function makeRequest(provider: string, body: string): Request {
  return new Request(`https://api.test/webhooks/${provider}`, {
    method: "POST",
    body,
  });
}

function padTo(byteLength: number, prefix = ""): string {
  return `${prefix}${"a".repeat(byteLength - prefix.length)}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function slackSignature(body: string): string {
  const digest = createHmac("sha256", mockEnv.SLACK_SIGNING_SECRET)
    .update(`v0:${SLACK_TIMESTAMP}:${body}`)
    .digest("hex");
  return `v0=${digest}`;
}

function svixHeaders(): Headers {
  return new Headers({
    "svix-id": "msg_1",
    "svix-signature": "v1,deadbeef",
    "svix-timestamp": SLACK_TIMESTAMP,
  });
}

function receivedBodyDigest(mock: { mock: { calls: unknown[][] } }): string {
  return sha256(mock.mock.calls[0][0] as string);
}

function overCapWarnings(): unknown[] {
  return mockLogWarn.mock.calls
    .filter(([event]) => event === REQUEST_BODY_OVER_CAP_EVENT)
    .map(([, metadata]) => metadata);
}

// ISS-9053: each receiver exports its POST through `withRequestCompleted`, so
// a refusal is on the record every cl-api monitor keys on. These arms pin that
// wiring per receiver; a route exported bare would record nothing here.
function requestCompletedRecords(): unknown[] {
  return vi
    .mocked(log.info)
    .mock.calls.filter(([event]) => event === REQUEST_COMPLETED_EVENT)
    .map(([, fields]) => fields);
}

function readGitHubEnv(): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of GITHUB_ENV_KEYS) {
    snapshot[key] = process.env[key];
  }
  return snapshot;
}

function restoreGitHubEnv(snapshot: Record<string, string | undefined>): void {
  for (const key of GITHUB_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      // Assigning `undefined` stores the STRING "undefined" in process.env,
      // which `isGitHubConfigured()` reads as configured.
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
}

function armConfiguredReceivers(): void {
  vi.clearAllMocks();
  githubEnvBeforeTest = readGitHubEnv();
  process.env.GITHUB_APP_ID = "app-id";
  process.env.GITHUB_APP_PRIVATE_KEY = "private-key";
  process.env.GITHUB_APP_WEBHOOK_SECRET = "webhook-secret";
  mockEnv.CLERK_WEBHOOK_SECRET = "whsec_test";
  mockEnv.SLACK_SIGNING_SECRET = "slack-signing-secret";
  mockSvixVerify.mockImplementation(() => {
    throw new Error("unverified");
  });
  mockVerifyRequest.mockImplementation(() => {
    throw new Error("unverified");
  });
  vi.mocked(verifyWebhookSignature).mockReturnValue(false);
}

/**
 * ISS-9053, review follow-up. `withRequestCompleted` flushes from its `finally`,
 * so a receiver that ALSO scheduled one of its own queued two deferred log
 * flushes — and two post-response span flushes with tracing active — for every
 * delivery, the receiver's running before the `request_completed` record it was
 * meant to carry even existed. The wrapper is now the sole terminal flush owner
 * and the receivers schedule none; each arm drives the production `POST` and
 * counts the real `log.flush()` that `scheduleLogFlush` defers, so re-adding a
 * receiver-side flush reads as two here.
 *
 * Deliberately NOT one flush everywhere: an over-cap read still flushes its own
 * `REQUEST_BODY_OVER_CAP_EVENT` warning, because `logRequestBodyOverCap` also
 * serves callers that answer their own 413 with nothing downstream to flush
 * them. The last arm pins that exception rather than letting it drift.
 */
describe("withRequestCompleted is the sole terminal flush owner", () => {
  beforeEach(armConfiguredReceivers);

  it("schedules one flush for a GitHub delivery", async () => {
    mockHeaders.mockResolvedValue(
      new Headers({ "x-hub-signature-256": "sha256=deadbeef" })
    );

    const response = await githubPost(makeRequest("github", "{}"));

    expect(response.status).toBe(UNAUTHORIZED);
    expect(mockLogFlush).toHaveBeenCalledTimes(1);
  });

  it("schedules one flush for a Clerk delivery", async () => {
    mockHeaders.mockResolvedValue(svixHeaders());

    const response = await authPost(makeRequest("auth", "{}"));

    expect(response.status).toBe(400);
    expect(mockLogFlush).toHaveBeenCalledTimes(1);
  });

  it("schedules one flush for a Slack delivery", async () => {
    const body = "command=%2Funknown";
    mockHeaders.mockResolvedValue(
      new Headers({
        "x-slack-request-timestamp": SLACK_TIMESTAMP,
        "x-slack-signature": slackSignature(body),
      })
    );
    vi.setSystemTime(PINNED_CLOCK_MS);

    const response = await slackPost(makeRequest("slack", body));

    expect(response.status).toBe(200);
    expect(mockLogFlush).toHaveBeenCalledTimes(1);
  });

  it("schedules one flush for a Liveblocks delivery", async () => {
    const response = await liveblocksPost(makeRequest("liveblocks", "{}"));

    expect(response.status).toBe(UNAUTHORIZED);
    expect(mockLogFlush).toHaveBeenCalledTimes(1);
  });

  it("keeps the over-cap reader's own flush alongside the wrapper's", async () => {
    const response = await liveblocksPost(
      makeRequest("liveblocks", padTo(LIVEBLOCKS_WEBHOOK_MAX_BYTES + 1))
    );

    expect(response.status).toBe(PAYLOAD_TOO_LARGE);
    expect(overCapWarnings()).toHaveLength(1);
    expect(mockLogFlush).toHaveBeenCalledTimes(2);
  });
});

/**
 * Every arm above sizes its fixture FROM the constant it is testing, so the
 * bound and its own proof move together: halve a cap and the whole suite stays
 * green while real deliveries start taking a 413. These pin the values — a
 * literal so a swap or a typo fails, and the floor each constant's own
 * docstring derives so a bound that would refuse a legitimate payload fails
 * for the reason that actually matters.
 */
describe("per-provider caps stay above the payloads they must accept", () => {
  it("pins the four values", () => {
    expect(GITHUB_WEBHOOK_MAX_BYTES).toBe(4_718_592);
    expect(CLERK_WEBHOOK_MAX_BYTES).toBe(1_048_576);
    expect(SLACK_WEBHOOK_MAX_BYTES).toBe(262_144);
    expect(LIVEBLOCKS_WEBHOOK_MAX_BYTES).toBe(65_536);
  });

  it("clears the platform request-body ceiling GitHub deliveries traverse", () => {
    // Vercel refuses a body over 4.5 MB with its own 413
    // FUNCTION_PAYLOAD_TOO_LARGE before this route is invoked, so a cap under
    // that ceiling is the only thing that could refuse a delivery which
    // actually arrived. GitHub's own 25 MB envelope is unreachable from here.
    expect(GITHUB_WEBHOOK_MAX_BYTES).toBeGreaterThanOrEqual(4_500_000);
  });

  it("clears the worst GitHub push payload measured from this repo", () => {
    // 20-commit `commits[]` + `head_commit` 264,994 B (400 first-parent commits
    // of `main`) + repository 7,612 B + sender 89 B.
    expect(GITHUB_WEBHOOK_MAX_BYTES).toBeGreaterThan(272_695);
  });

  it("clears Svix's documented message-payload ceiling for Clerk", () => {
    // Svix cannot deliver more than 1 MiB, so at or above it no legitimate
    // Clerk event can ever be refused.
    expect(CLERK_WEBHOOK_MAX_BYTES).toBeGreaterThanOrEqual(1_048_576);
  });

  it("clears Slack's 4,000-character message limit, percent-encoded", () => {
    // 4,000 chars x 4 bytes UTF-8 = 16,000, x3 for worst-case percent-encoding.
    expect(SLACK_WEBHOOK_MAX_BYTES).toBeGreaterThan(48_000);
  });

  it("clears a Liveblocks ID envelope with room to spare", () => {
    // Events carry ids only — the handlers lazy-fetch content — so a generous
    // envelope is a few KiB.
    expect(LIVEBLOCKS_WEBHOOK_MAX_BYTES).toBeGreaterThan(8192);
  });
});

// Guards the digest-preservation claim above at the source: if the shared Slack
// verifier ever stopped signing over the raw body, the end-to-end case would
// start passing for the wrong reason.
describe("slack signature verification", () => {
  it("rejects a signature computed over a re-serialized body", () => {
    const raw = '{"a":1,  "b":2}';
    const reserialized = JSON.stringify(JSON.parse(raw));
    const signature = createHmac("sha256", "secret")
      .update(`v0:${SLACK_TIMESTAMP}:${reserialized}`)
      .digest("hex");
    vi.setSystemTime(Number(SLACK_TIMESTAMP) * 1000);

    expect(
      slackVerifyWebhookSignature(
        raw,
        SLACK_TIMESTAMP,
        `v0=${signature}`,
        "secret"
      )
    ).toBe(false);
  });
});

/**
 * Both leaks these guard against are invisible from inside the arm that causes
 * them —
 * what sees a faked `GITHUB_APP_ID` or a stopped clock is a LATER test in the
 * same worker. So each asserts the observable state after every arm above has
 * run, rather than that a cleanup function was called.
 */
describe("the suite leaves the worker as it found it", () => {
  it("hands back the GitHub env it faked, unset keys deleted", () => {
    expect(readGitHubEnv()).toEqual(GITHUB_ENV_BEFORE_SUITE);
  });

  it("leaves the real clock running after the pinned-clock arms", () => {
    expect(Date.now()).not.toBe(PINNED_CLOCK_MS);
  });

  it("deletes a key it found unset instead of storing the string 'undefined'", () => {
    // The branch CI takes and a `.env.local` box does not: with the key unset,
    // `process.env[key] = undefined` would store "undefined", which
    // `isGitHubConfigured()` reads as configured. The afterEach above puts the
    // real value back.
    Reflect.deleteProperty(process.env, "GITHUB_APP_ID");
    const unsetSnapshot = readGitHubEnv();
    process.env.GITHUB_APP_ID = "app-id";

    restoreGitHubEnv(unsetSnapshot);

    expect("GITHUB_APP_ID" in process.env).toBe(false);
  });
});
