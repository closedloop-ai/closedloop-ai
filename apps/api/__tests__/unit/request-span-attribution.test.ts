/**
 * Span attribution on the `request_completed` line — ISS-7217 / ISS-7221 /
 * ISS-7224.
 *
 * These drive the PRODUCTION path: a real handler mounted under EACH of the
 * three auth wrappers (`withApiKeyAuth`, `withAuth`, `withDesktopSessionAuth`),
 * the real `errorResponse`, the real `logRequestCompleted`, and the real
 * contract builder. The only doubles are the auth services the wrappers call,
 * so the attribution plumbing between them — the AsyncLocalStorage scope, the
 * recorder call sites, the 5xx gating, and the schema projection — is exercised
 * end to end. Deleting any one of those, in any one wrapper, makes a test here
 * red.
 */
import { readFileSync } from "node:fs";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { TelemetryEmitMetadataKey } from "@closedloop-ai/telemetry-contract/emit";
import { TelemetrySchemaName } from "@closedloop-ai/telemetry-contract/schema-name";
import {
  SpanErrorSource,
  SpanTelemetrySchema,
} from "@closedloop-ai/telemetry-contract/span";
import { ApiKeyScope } from "@repo/api/src/types/api-key";
import { DesktopClientAttributionHeader } from "@repo/api/src/types/desktop-client-attribution";
import {
  DocumentStatus,
  DocumentType,
  IssueStatus,
} from "@repo/api/src/types/document";
import { ApiKeySource } from "@repo/database";
import type { RequestCompletedSpanAttribution } from "@repo/observability/telemetry/request-completed";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { z } from "zod";

const mockWaitUntil = vi.hoisted(() => vi.fn());

vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
    flush: vi.fn(async () => undefined),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));
vi.mock("@vercel/functions", () => ({
  waitUntil: mockWaitUntil,
}));
vi.mock("@/app/api-keys/service", () => ({
  apiKeysService: {
    touchLastUsedAt: vi.fn(),
    verifyKeyWithMetadata: vi.fn(),
  },
}));
vi.mock("@/app/organizations/service", () => ({
  organizationsService: { findById: vi.fn() },
}));
vi.mock("@/app/users/service", () => ({
  usersService: { findById: vi.fn() },
}));
vi.mock("@repo/auth/server", () => ({
  auth: vi.fn(),
}));
vi.mock("@/lib/auth/find-or-create-user", () => ({
  findOrCreateUser: vi.fn(),
}));
vi.mock("@/lib/auth/resolve-org-header", () => ({
  resolveOrgHeader: vi.fn(),
}));
vi.mock("@/lib/auth/desktop-session-auth", () => ({
  resolveDesktopSessionContext: vi.fn(),
}));
vi.mock("@/lib/auth/desktop-managed-pop", () => ({
  getDesktopManagedPopRequestFailure: vi.fn(),
}));

import { auth } from "@repo/auth/server";
import { log } from "@repo/observability/log";
import { apiKeysService } from "@/app/api-keys/service";
import { organizationsService } from "@/app/organizations/service";
import { usersService } from "@/app/users/service";
import { getDesktopManagedPopRequestFailure } from "@/lib/auth/desktop-managed-pop";
import { resolveDesktopSessionContext } from "@/lib/auth/desktop-session-auth";
import { findOrCreateUser } from "@/lib/auth/find-or-create-user";
import { resolveOrgHeader } from "@/lib/auth/resolve-org-header";
import { withApiKeyAuth } from "@/lib/auth/with-api-key-auth";
import { withAuth } from "@/lib/auth/with-auth";
import { withDesktopSessionAuth } from "@/lib/auth/with-desktop-session-auth";
import {
  recordRequestArtifact,
  recordRequestSyncBatch,
} from "@/lib/observability/request-span-attribution";
import { errorResponse, successResponse } from "@/lib/route-utils";

const mockVerifyKeyWithMetadata = apiKeysService.verifyKeyWithMetadata as Mock;
const mockTouchLastUsedAt = apiKeysService.touchLastUsedAt as Mock;
const mockFindUser = usersService.findById as Mock;
const mockFindOrg = organizationsService.findById as Mock;
const mockClerkAuth = auth as unknown as Mock;
const mockFindOrCreateUser = findOrCreateUser as unknown as Mock;
const mockResolveOrgHeader = resolveOrgHeader as unknown as Mock;
const mockResolveDesktopSession =
  resolveDesktopSessionContext as unknown as Mock;
const mockDesktopManagedPopFailure =
  getDesktopManagedPopRequestFailure as unknown as Mock;
const mockLogInfo = log.info as unknown as Mock;
const mockLogError = log.error as unknown as Mock;

const ORGANIZATION_ID = "0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f";
const USER_ID = "019c2500-1f4c-7a10-9d33-6b0f2c8e41aa";
const INSTALLATION_ID = "019c26aa-3c11-7bb2-8f04-1d7e5a9c3311";
const CLIENT_VERSION = "1.24.3";
const SYNC_BATCH_ID = "3f2a91c4-7d5e-4b18-9a03-6e8c1d47b2f5";
const CLERK_ORG_ID = "org_clerk_abc123";
const CLERK_USER_ID = "clerk_user_1";
const CLERK_ORG_ROLE = "org:admin";
const REQUEST_URL = "https://api.closedloop.ai/documents/ISS-7217";
const REQUEST_PATH = "/documents/ISS-7217";
const REQUEST_METHOD = "PUT";
const COLLECTOR_ALLOWLIST_PATH = new URL(
  "../../../../packages/telemetry-contract/collector/allowed-attributes.json",
  import.meta.url
);

/**
 * The COMPLETE attribution field set, as a compile-time keys-covered guard.
 *
 * This is the compile-time half of the no-content-leak contract (the shape
 * ISS-7248 established): a new field on the attribution type fails `tsc` right
 * here until someone writes it down, which is the moment to ask whether it can
 * carry user content. The runtime half is `contentLeaks` below, which walks the
 * VALUES that actually reached the line.
 */
const ATTRIBUTION_FIELDS: Record<keyof RequestCompletedSpanAttribution, true> =
  {
    organizationId: true,
    userId: true,
    installationId: true,
    clientVersion: true,
    errorSource: true,
    errorType: true,
    artifactType: true,
    artifactStatus: true,
    syncBatchId: true,
  };

/** The span attributes those fields become — the ones a request can add. */
const ATTRIBUTED_SPAN_ATTRIBUTES: ReadonlySet<string> = new Set<string>([
  TelemetryAttribute.AppOrganizationId,
  TelemetryAttribute.UserId,
  TelemetryAttribute.AppInstallationId,
  TelemetryAttribute.AppClientVersion,
  TelemetryAttribute.AppErrorSource,
  TelemetryAttribute.ErrorType,
  TelemetryAttribute.ArtifactType,
  TelemetryAttribute.ArtifactStatus,
  TelemetryAttribute.SyncBatchId,
]);

/**
 * A message shaped like every kind of user content a real 500 drags along: a
 * home-directory path, a prompt fragment, an address, and a live credential.
 */
const HOSTILE_MESSAGE =
  "Failed writing /Users/someone/notes/plan.md for owner@example.com: " +
  "Summarize the attached contract — key sk_live_A1b2C3d4E5f6G7h8";

class PrismaClientKnownRequestError extends Error {
  code = "P2002";
  constructor(message: string) {
    super(message);
    this.name = "PrismaClientKnownRequestError";
  }
}

function createRequest(attested: Record<string, string> = {}): Request {
  const headers = new Headers(attested);
  headers.set("authorization", "Bearer sk_live_testkey");
  return {
    headers,
    method: REQUEST_METHOD,
    url: REQUEST_URL,
  } as unknown as Request;
}

function authenticate(): void {
  mockVerifyKeyWithMetadata.mockResolvedValue({
    apiKeyId: "api-key-1",
    userId: USER_ID,
    organizationId: ORGANIZATION_ID,
    scopes: ["read", "write"],
    source: ApiKeySource.USER_CREATED,
    gatewayId: null,
    boundPublicKey: null,
  });
  mockFindUser.mockResolvedValue({
    id: USER_ID,
    clerkId: "clerk_user_1",
    organizationId: ORGANIZATION_ID,
    active: true,
  });
  mockFindOrg.mockResolvedValue({
    id: ORGANIZATION_ID,
    clerkId: CLERK_ORG_ID,
    name: "Test Org",
  });
  mockClerkAuth.mockResolvedValue({
    userId: CLERK_USER_ID,
    orgId: CLERK_ORG_ID,
    orgRole: CLERK_ORG_ROLE,
  });
  mockResolveOrgHeader.mockResolvedValue({
    kind: "session",
    clerkOrgId: CLERK_ORG_ID,
    orgRole: CLERK_ORG_ROLE,
  });
  mockFindOrCreateUser.mockResolvedValue({
    id: USER_ID,
    clerkId: CLERK_USER_ID,
    organizationId: ORGANIZATION_ID,
    active: true,
  });
  mockResolveDesktopSession.mockResolvedValue({
    user: {
      id: USER_ID,
      clerkId: CLERK_USER_ID,
      organizationId: ORGANIZATION_ID,
      active: true,
    },
    organizationId: ORGANIZATION_ID,
    clerkOrgId: CLERK_ORG_ID,
  });
}

/**
 * The three production wrappers, each of which opens its own attribution scope
 * and holds its own recorder calls.
 *
 * Every attribution test below runs against ALL THREE. A suite that mounted only
 * one would stay green after the scope or the recorders were deleted from the
 * other two — the wrappers share no code path here, only a contract.
 */
const AUTH_WRAPPERS = {
  apiKey: withApiKeyAuth,
  session: withAuth,
  desktopSession: withDesktopSessionAuth,
} as const;

type AuthWrapperName = keyof typeof AUTH_WRAPPERS;

const AUTH_WRAPPER_NAMES = Object.keys(AUTH_WRAPPERS) as AuthWrapperName[];

/**
 * Make each wrapper's OWN catch produce the 5xx, rather than the handler's.
 *
 * The identity lookup is the last `await` before the handler in every wrapper,
 * so rejecting it lands the throw inside the wrapper's `catch` — the block that
 * holds `recordRequestErrorCause(error, SpanErrorSource.AuthWrapper)`.
 */
function failInsideWrapper(wrapper: AuthWrapperName, error: unknown): void {
  if (wrapper === "apiKey") {
    mockFindUser.mockRejectedValue(error);
    return;
  }
  if (wrapper === "session") {
    mockFindOrCreateUser.mockRejectedValue(error);
    return;
  }
  mockResolveDesktopSession.mockRejectedValue(error);
}

/** Make the wrapper reject the caller outright, so no organization resolves. */
function failAuthentication(wrapper: AuthWrapperName): void {
  if (wrapper === "apiKey") {
    mockVerifyKeyWithMetadata.mockResolvedValue(null);
    return;
  }
  if (wrapper === "session") {
    mockClerkAuth.mockResolvedValue({
      userId: null,
      orgId: null,
      orgRole: null,
    });
    return;
  }
  mockResolveDesktopSession.mockResolvedValue(null);
}

/**
 * A thrown value that is hostile to the very act of being inspected: every
 * field the error-cause reducer reads throws on access. A reducer that is not
 * total turns the intended JSON 500 into a rejected handler here.
 */
function hostileAccessorValue(): unknown {
  return new Proxy(new Error("boom"), {
    get() {
      throw new Error("hostile get trap");
    },
    getOwnPropertyDescriptor() {
      throw new Error("hostile getOwnPropertyDescriptor trap");
    },
    has() {
      throw new Error("hostile has trap");
    },
  });
}

async function runRequest(
  handler: () => Promise<Response> | Response,
  wrapper: AuthWrapperName = "apiKey",
  attested: Record<string, string> = {}
): Promise<void> {
  await runRequestForResponse(handler, wrapper, attested);
}

async function runRequestForResponse(
  handler: () => Promise<Response> | Response,
  wrapper: AuthWrapperName = "apiKey",
  attested: Record<string, string> = {}
): Promise<Response> {
  const wrapped = AUTH_WRAPPERS[wrapper]((() => handler()) as never);
  return (await wrapped(
    createRequest(attested) as never,
    {
      params: Promise.resolve({}),
    } as never
  )) as unknown as Response;
}

/** The headers a current Desktop build attaches to a first-party cloud call. */
function attestedDesktopHeaders(): Record<string, string> {
  return {
    [DesktopClientAttributionHeader.InstallationId]: INSTALLATION_ID,
    [DesktopClientAttributionHeader.ClientVersion]: CLIENT_VERSION,
  };
}

/**
 * The single `request_completed` line the request emitted, whatever its level.
 *
 * Throws rather than asserting, so it stays usable from any test. The
 * one-line-per-request property itself is asserted by its own test below —
 * ISS-5039 made "exactly one line" literal, and every deployed log call is
 * billed twice, so a second line is two more billed events per request.
 */
function emittedLine(): {
  level: "info" | "error";
  fields: Record<string, unknown>;
} {
  const lines = emittedRequestCompletedLines();
  if (lines.length !== 1) {
    throw new Error(
      `expected exactly one request_completed line, saw ${lines.length}`
    );
  }
  return lines[0];
}

function emittedRequestCompletedLines(): Array<{
  level: "info" | "error";
  fields: Record<string, unknown>;
}> {
  const lines: Array<{
    level: "info" | "error";
    fields: Record<string, unknown>;
  }> = [];
  for (const call of mockLogInfo.mock.calls) {
    if (call[0] === "request_completed") {
      lines.push({ level: "info", fields: call[1] });
    }
  }
  for (const call of mockLogError.mock.calls) {
    if (call[0] === "request_completed") {
      lines.push({ level: "error", fields: call[1] });
    }
  }
  return lines;
}

/**
 * Every string that reached the line which is neither a value the caller
 * supplied nor a member of a closed vocabulary.
 *
 * Key coverage alone would pass a line whose `error.type` had been widened to a
 * raw server message, so this walks the VALUES: a path, a prompt, an address,
 * or a credential has nowhere to hide because it matches nothing in `allowed`.
 */
function contentLeaks(
  fields: Record<string, unknown>,
  allowedStrings: Iterable<string>
): string[] {
  const allowed = new Set<string>(allowedStrings);
  const leaked: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (!allowed.has(value)) {
        leaked.push(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) {
        visit(item);
      }
    }
  };
  visit(fields);
  return leaked;
}

/** The strings a `request_completed` line is allowed to carry, before attribution. */
function baselineAllowedStrings(): string[] {
  return [REQUEST_PATH, REQUEST_METHOD, TelemetrySchemaName.Span];
}

/**
 * The snake_case fields this line has always carried — the ones the Datadog
 * log-based metrics (`api.requests.count`, `api.errors.count`,
 * `api.requests.latency`) group on.
 */
const LEGACY_LINE_FIELDS: ReadonlySet<string> = new Set([
  "path",
  "method",
  "status_code",
  "duration_ms",
]);

function isDeclaredLineField(key: string): boolean {
  return (
    LEGACY_LINE_FIELDS.has(key) ||
    key === TelemetryEmitMetadataKey.SchemaName ||
    key in SpanTelemetrySchema.shape
  );
}

/**
 * The allow-list the collector will actually enforce, read from the committed
 * generated artifact. Validated rather than trusted: it is a file on disk, so
 * a truncated or hand-edited copy must fail loudly here instead of silently
 * satisfying the assertion with an empty list.
 */
function committedCollectorAllowedKeys(): string[] {
  const artifact = JSON.parse(
    readFileSync(COLLECTOR_ALLOWLIST_PATH, "utf-8")
  ) as unknown;
  return z
    .object({ allowedKeys: z.array(z.string()).min(1) })
    .loose()
    .parse(artifact).allowedKeys;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTouchLastUsedAt.mockResolvedValue(undefined);
  mockDesktopManagedPopFailure.mockResolvedValue(undefined);
  authenticate();
});

describe("tenant attribution (ISS-7221)", () => {
  it("stamps the authenticated organization under the attribute desktop telemetry already uses", async () => {
    await runRequest(() => successResponse({ ok: true }));

    // The SAME attribute name desktop emits (`app.organization.id`). A per-side
    // spelling would leave the two sides unjoinable, which is the defect.
    expect(emittedLine().fields).toMatchObject({
      [TelemetryAttribute.AppOrganizationId]: ORGANIZATION_ID,
      [TelemetryEmitMetadataKey.SchemaName]: TelemetrySchemaName.Span,
    });
  });

  it("leaves the organization absent when the request never authenticated", async () => {
    mockVerifyKeyWithMetadata.mockResolvedValue(null);
    const handler = vi.fn(() => successResponse({ ok: true }));

    await runRequest(handler);

    const { fields } = emittedLine();
    expect(handler).not.toHaveBeenCalled();
    expect(fields.status_code).toBe(401);
    // Absent, not blank and not a placeholder: a fabricated tenant would make
    // "which org is failing" answerable and wrong.
    expect(fields).not.toHaveProperty(TelemetryAttribute.AppOrganizationId);
  });

  it("leaves the organization absent when the org lookup finds nothing", async () => {
    mockFindOrg.mockResolvedValue(null);

    await runRequest(() => successResponse({ ok: true }));

    const { fields } = emittedLine();
    expect(fields.status_code).toBe(401);
    expect(fields).not.toHaveProperty(TelemetryAttribute.AppOrganizationId);
  });
});

/**
 * Every auth wrapper, not just the one that happened to be convenient.
 *
 * `withApiKeyAuth`, `withAuth`, and `withDesktopSessionAuth` each open their own
 * `runWithRequestSpanAttribution` scope and each carry their own recorder calls,
 * so coverage of one proves nothing about the other two: deleting the scope or
 * the recorders from an uncovered wrapper leaves every assertion elsewhere
 * green while that lane silently emits unattributed spans. The desktop lane in
 * particular is the one the sync client rides.
 */
describe.each(AUTH_WRAPPER_NAMES)("%s wrapper attribution", (wrapper) => {
  it("stamps the authenticated organization on a successful request", async () => {
    await runRequest(() => successResponse({ ok: true }), wrapper);

    const { level, fields } = emittedLine();
    expect(level).toBe("info");
    expect(fields.status_code).toBe(200);
    expect(fields).toMatchObject({
      [TelemetryAttribute.AppOrganizationId]: ORGANIZATION_ID,
      [TelemetryEmitMetadataKey.SchemaName]: TelemetrySchemaName.Span,
    });
  });

  it("leaves the organization absent when the caller never authenticated", async () => {
    failAuthentication(wrapper);
    const handler = vi.fn(() => successResponse({ ok: true }));

    await runRequest(handler, wrapper);

    const { fields } = emittedLine();
    expect(handler).not.toHaveBeenCalled();
    expect(fields.status_code).toBe(401);
    expect(fields).not.toHaveProperty(TelemetryAttribute.AppOrganizationId);
  });

  /**
   * ISS-8748. The internal database user id under the canonical OTel key, at
   * the same boundary the tenant is recorded at — so a failure is answerable as
   * "which customers did this reach", not only "which tenant".
   */
  it("stamps the authenticated user on a successful request", async () => {
    await runRequest(() => successResponse({ ok: true }), wrapper);

    const { fields } = emittedLine();
    expect(fields.status_code).toBe(200);
    expect(fields).toMatchObject({ [TelemetryAttribute.UserId]: USER_ID });
  });

  it("carries no email, name, or Clerk id alongside the user", async () => {
    await runRequest(() => successResponse({ ok: true }), wrapper);

    const { fields } = emittedLine();
    // The Clerk id is the one identity the wrapper demonstrably holds — it is
    // in the `AuthContext` it just built — so its absence is the assertion that
    // the boundary emits the internal id and nothing else it could reach for.
    expect(
      contentLeaks(fields, [
        ...baselineAllowedStrings(),
        ORGANIZATION_ID,
        USER_ID,
      ]),
      "a string reached the span that is neither the tenant nor the internal user id"
    ).toEqual([]);
  });

  it("leaves the user absent when the caller never authenticated", async () => {
    failAuthentication(wrapper);

    await runRequest(() => successResponse({ ok: true }), wrapper);

    const { fields } = emittedLine();
    expect(fields.status_code).toBe(401);
    expect(fields).not.toHaveProperty(TelemetryAttribute.UserId);
  });

  /**
   * ISS-8749. The caller's own account of which install and build it is,
   * recorded on the authenticated span so a request can be joined to the
   * desktop records from the same machine.
   */
  it("records the Desktop install and build the caller attested", async () => {
    await runRequest(
      () => successResponse({ ok: true }),
      wrapper,
      attestedDesktopHeaders()
    );

    expect(emittedLine().fields).toMatchObject({
      [TelemetryAttribute.AppInstallationId]: INSTALLATION_ID,
      [TelemetryAttribute.AppClientVersion]: CLIENT_VERSION,
    });
  });

  /**
   * The version-skew case, which is most of the fleet on the day this ships: a
   * Desktop build that predates the headers sends neither, and the request must
   * complete normally with both attributes simply absent.
   */
  it("completes normally for a client that attests nothing", async () => {
    const response = await runRequestForResponse(
      () => successResponse({ ok: true }),
      wrapper
    );

    const { fields } = emittedLine();
    expect(response.status).toBe(200);
    expect(fields).not.toHaveProperty(TelemetryAttribute.AppInstallationId);
    expect(fields).not.toHaveProperty(TelemetryAttribute.AppClientVersion);
  });

  /**
   * The trust boundary. These headers are whatever the caller typed, so the
   * hostile shapes have to be unrepresentable rather than merely unlikely — and
   * one bad header must not cost the other, nor the request.
   */
  it("drops malformed attested metadata without failing the request", async () => {
    const response = await runRequestForResponse(
      () => successResponse({ ok: true }),
      wrapper,
      {
        [DesktopClientAttributionHeader.InstallationId]: INSTALLATION_ID,
        [DesktopClientAttributionHeader.ClientVersion]:
          "/Users/someone/Applications/ClosedLoop.app",
      }
    );

    const { fields } = emittedLine();
    expect(response.status).toBe(200);
    expect(fields[TelemetryAttribute.AppInstallationId]).toBe(INSTALLATION_ID);
    expect(fields).not.toHaveProperty(TelemetryAttribute.AppClientVersion);
  });

  /**
   * ISS-11431: a 401 burst has to name the installs and build it rejected. The
   * attestation is the only identity a rejected request has; the server-side
   * identity stays absent, so the two are never confused.
   */
  it("records the attested install and build on a rejected request", async () => {
    failAuthentication(wrapper);

    await runRequest(
      () => successResponse({ ok: true }),
      wrapper,
      attestedDesktopHeaders()
    );

    const { fields } = emittedLine();
    expect(fields.status_code).toBe(401);
    expect(fields).toMatchObject({
      [TelemetryAttribute.AppInstallationId]: INSTALLATION_ID,
      [TelemetryAttribute.AppClientVersion]: CLIENT_VERSION,
    });
    expect(fields).not.toHaveProperty(TelemetryAttribute.AppOrganizationId);
    expect(fields).not.toHaveProperty(TelemetryAttribute.UserId);
  });

  it("leaves the user absent when the wrapper's own catch produced the 5xx", async () => {
    failInsideWrapper(wrapper, new TypeError("boom"));

    await runRequest(() => successResponse({ ok: true }), wrapper);

    const { fields } = emittedLine();
    expect(fields.status_code).toBe(500);
    // The throw lands on the identity lookup itself, so nothing authenticated.
    expect(fields).not.toHaveProperty(TelemetryAttribute.UserId);
    expect(fields).not.toHaveProperty(TelemetryAttribute.AppOrganizationId);
  });

  it("attributes a 5xx the wrapper's own catch produced", async () => {
    failInsideWrapper(
      wrapper,
      new PrismaClientKnownRequestError(HOSTILE_MESSAGE)
    );

    await runRequest(() => successResponse({ ok: true }), wrapper);

    const { level, fields } = emittedLine();
    expect(level).toBe("error");
    expect(fields).toMatchObject({
      status_code: 500,
      [TelemetryAttribute.AppErrorSource]: SpanErrorSource.AuthWrapper,
      [TelemetryAttribute.ErrorType]: "PrismaClientKnownRequestError.P2002",
    });
    expect(
      contentLeaks(fields, [
        ...baselineAllowedStrings(),
        SpanErrorSource.AuthWrapper,
        "PrismaClientKnownRequestError.P2002",
      ]),
      "a string reached the span that is neither a supplied id nor a closed vocabulary member"
    ).toEqual([]);
  });

  it("attributes a 5xx the route handler produced, and the artifact it touched", async () => {
    await runRequest(() => {
      recordRequestArtifact({
        type: DocumentType.ImplementationPlan,
        status: DocumentStatus.Approved,
      });
      return errorResponse("failed", new TypeError(HOSTILE_MESSAGE));
    }, wrapper);

    const { level, fields } = emittedLine();
    expect(level).toBe("error");
    expect(fields).toMatchObject({
      status_code: 500,
      [TelemetryAttribute.AppOrganizationId]: ORGANIZATION_ID,
      [TelemetryAttribute.AppErrorSource]: SpanErrorSource.RouteHandler,
      [TelemetryAttribute.ErrorType]: "TypeError",
      [TelemetryAttribute.ArtifactType]: DocumentType.ImplementationPlan,
      [TelemetryAttribute.ArtifactStatus]: DocumentStatus.Approved,
    });
  });

  it("marks a 5xx nobody attributed rather than leaving it blank", async () => {
    await runRequest(
      () => Response.json({ ok: false }, { status: 503 }),
      wrapper
    );

    const { fields } = emittedLine();
    expect(fields[TelemetryAttribute.AppErrorSource]).toBe(
      SpanErrorSource.Unattributed
    );
    expect(fields).not.toHaveProperty(TelemetryAttribute.ErrorType);
  });

  /**
   * Totality of the reducer, driven through the real production path
   * (wrapper catch → `recordRequestErrorCause` → `resolveSpanErrorType`).
   *
   * A thrown value whose accessors throw must not make the attribution path
   * throw: that would reject the handler instead of returning the intended JSON
   * 500, turning an instrumented failure into a worse one.
   */
  it("still returns a JSON 500 when the thrown value has hostile accessors", async () => {
    failInsideWrapper(wrapper, hostileAccessorValue());

    const response = await runRequestForResponse(
      () => successResponse({ ok: true }),
      wrapper
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toMatchObject({ success: false });

    const { fields } = emittedLine();
    expect(fields.status_code).toBe(500);
    // The layer still reports itself; only the unreadable class is absent.
    expect(fields[TelemetryAttribute.AppErrorSource]).toBe(
      SpanErrorSource.AuthWrapper
    );
    expect(fields).not.toHaveProperty(TelemetryAttribute.ErrorType);
  });
});

/**
 * Where the identity boundary actually falls, on the exits that are neither a
 * 401 nor a throw.
 *
 * BEFORE it: Clerk answered "not a member" (403), the org lookup FAILED so
 * nobody decided anything (503), the user is inactive, proof-of-possession
 * failed. Each runs with a credential in hand, which is exactly when an
 * identity attribute is most tempting and least earned — none of them
 * established who is calling.
 *
 * AFTER it: the scope-forbidden 403, which did establish that, and therefore
 * keeps its attribution. Asserting both sides is what makes the omissions
 * meaningful rather than a spy nothing ever writes to.
 */
describe("the identity boundary on non-401 exits (ISS-8748)", () => {
  it.each([
    ["forbidden", { kind: "forbidden" }, 403],
    ["unverifiable", { kind: "unverifiable" }, 503],
  ])(
    "leaves the user and tenant absent on %s",
    async (_name, resolution, status) => {
      mockResolveOrgHeader.mockResolvedValue(resolution);
      const handler = vi.fn(() => successResponse({ ok: true }));

      await runRequest(handler, "session");

      const { fields } = emittedLine();
      expect(handler).not.toHaveBeenCalled();
      expect(fields.status_code).toBe(status);
      expect(fields).not.toHaveProperty(TelemetryAttribute.UserId);
      expect(fields).not.toHaveProperty(TelemetryAttribute.AppOrganizationId);
    }
  );

  it("leaves the user and tenant absent when proof-of-possession fails", async () => {
    // The API-key wrapper's own pre-identity exit, and the one that is NOT a
    // rejected credential: the key verified, the user is live, and the request
    // still never established that this caller holds the key.
    mockDesktopManagedPopFailure.mockResolvedValue({
      message: "desktop proof-of-possession required",
      status: 403,
    });
    const handler = vi.fn(() => successResponse({ ok: true }));

    await runRequest(handler, "apiKey");

    const { fields } = emittedLine();
    expect(handler).not.toHaveBeenCalled();
    expect(fields.status_code).toBe(403);
    expect(fields).not.toHaveProperty(TelemetryAttribute.UserId);
    expect(fields).not.toHaveProperty(TelemetryAttribute.AppOrganizationId);
  });

  /**
   * The deliberate counter-case, and the reason the omission assertions above
   * are not vacuous: the scope-forbidden 403 sits on the far side of the
   * identity recorder and DOES carry the org and user. It is an authorization
   * verdict on an established caller, not a failure to establish one — "which
   * key is hitting endpoints it lacks scopes for" is unanswerable otherwise.
   */
  it("still names the caller on a scope-forbidden 403", async () => {
    const handler = vi.fn(() => successResponse({ ok: true }));
    const wrapped = withApiKeyAuth((() => handler()) as never, {
      requiredScopes: [ApiKeyScope.Admin],
    });

    await wrapped(
      createRequest() as never,
      { params: Promise.resolve({}) } as never
    );

    const { fields } = emittedLine();
    expect(handler).not.toHaveBeenCalled();
    expect(fields.status_code).toBe(403);
    expect(fields).toMatchObject({
      [TelemetryAttribute.UserId]: USER_ID,
      [TelemetryAttribute.AppOrganizationId]: ORGANIZATION_ID,
    });
  });

  it("leaves the user absent when the resolved user is inactive", async () => {
    mockFindOrCreateUser.mockResolvedValue({
      id: USER_ID,
      clerkId: CLERK_USER_ID,
      organizationId: ORGANIZATION_ID,
      active: false,
    });

    await runRequest(() => successResponse({ ok: true }), "session");

    const { fields } = emittedLine();
    expect(fields.status_code).toBe(401);
    expect(fields).not.toHaveProperty(TelemetryAttribute.UserId);
  });
});

describe("error cause on a 5xx span (ISS-7217)", () => {
  it("names the failure class and the layer that reported it", async () => {
    await runRequest(() =>
      errorResponse(
        "Failed to update artifact",
        new PrismaClientKnownRequestError(HOSTILE_MESSAGE)
      )
    );

    const { level, fields } = emittedLine();
    expect(fields).toMatchObject({
      status_code: 500,
      [TelemetryAttribute.ErrorType]: "PrismaClientKnownRequestError.P2002",
      [TelemetryAttribute.AppErrorSource]: SpanErrorSource.RouteHandler,
    });
    // `status:error`, so error-rate monitors and `status:error` searches see it.
    expect(level).toBe("error");
  });

  it("still emits exactly one line when it moves to the error level", async () => {
    await runRequest(() => errorResponse("failed", new TypeError("boom")));

    // ISS-5039: one line per request. Routing a 5xx to `log.error` must move
    // the line, not add a second one — every deployed log call is billed twice.
    expect(emittedRequestCompletedLines()).toHaveLength(1);
  });

  it("marks a 5xx nobody attributed rather than leaving it blank", async () => {
    await runRequest(() => Response.json({ ok: false }, { status: 503 }));

    const { fields } = emittedLine();
    // A member, not an omission: an uninstrumented failure has to stay
    // countable and visibly distinct from an attributed one, or the attributed
    // counts silently claim to describe every 5xx.
    expect(fields[TelemetryAttribute.AppErrorSource]).toBe(
      SpanErrorSource.Unattributed
    );
    expect(fields).not.toHaveProperty(TelemetryAttribute.ErrorType);
  });

  it("attributes a failure the auth wrapper itself produced", async () => {
    mockFindUser.mockRejectedValue(new TypeError(HOSTILE_MESSAGE));

    await runRequest(() => successResponse({ ok: true }));

    expect(emittedLine().fields).toMatchObject({
      status_code: 500,
      [TelemetryAttribute.AppErrorSource]: SpanErrorSource.AuthWrapper,
      [TelemetryAttribute.ErrorType]: "TypeError",
    });
  });

  it("keeps error attribution off a request that recovered", async () => {
    await runRequest(() => {
      errorResponse("transient sub-step failed", new TypeError("boom"));
      return successResponse({ ok: true });
    });

    const { level, fields } = emittedLine();
    expect(level).toBe("info");
    expect(fields.status_code).toBe(200);
    // A cause that never became a failure must not stamp a successful span.
    expect(fields).not.toHaveProperty(TelemetryAttribute.AppErrorSource);
    expect(fields).not.toHaveProperty(TelemetryAttribute.ErrorType);
  });

  it("does not attribute a 4xx as a server-error cause", async () => {
    await runRequest(() =>
      errorResponse("bad input", new TypeError("boom"), 400)
    );

    const { level, fields } = emittedLine();
    expect(level).toBe("info");
    expect(fields).not.toHaveProperty(TelemetryAttribute.AppErrorSource);
  });
});

describe("no user content reaches the span (ISS-7217)", () => {
  it("carries only supplied ids and closed-vocabulary members on a hostile 5xx", async () => {
    await runRequest(
      () => {
        recordRequestArtifact({
          type: DocumentType.Feature,
          status: IssueStatus.InProgress,
        });
        recordRequestSyncBatch({ batchId: SYNC_BATCH_ID });
        return errorResponse(
          HOSTILE_MESSAGE,
          new PrismaClientKnownRequestError(HOSTILE_MESSAGE)
        );
      },
      "apiKey",
      attestedDesktopHeaders()
    );

    const { fields } = emittedLine();

    expect(
      Object.keys(fields).filter((key) => !isDeclaredLineField(key)),
      "the line grew a field outside the declared span contract"
    ).toEqual([]);
    // This request supplied every attribution field, so every one of them must
    // have reached the line. Paired with the compile-time guard above, a new
    // field cannot be added to the contract and then quietly never projected.
    expect(
      Object.keys(fields).filter((key) => ATTRIBUTED_SPAN_ATTRIBUTES.has(key))
    ).toHaveLength(Object.keys(ATTRIBUTION_FIELDS).length);
    expect(
      contentLeaks(fields, [
        ...baselineAllowedStrings(),
        ORGANIZATION_ID,
        USER_ID,
        INSTALLATION_ID,
        CLIENT_VERSION,
        DocumentType.Feature,
        IssueStatus.InProgress,
        SpanErrorSource.RouteHandler,
        "PrismaClientKnownRequestError.P2002",
        SYNC_BATCH_ID,
      ]),
      "a string reached the span that is neither a supplied id nor a closed vocabulary member"
    ).toEqual([]);
  });

  it("emits nothing at all rather than a partially-redacted class name", async () => {
    const error = new Error("boom");
    error.name = "sk_live_A1b2C3d4E5f6G7h8";

    await runRequest(() => errorResponse("failed", error));

    const { fields } = emittedLine();
    expect(fields).not.toHaveProperty(TelemetryAttribute.ErrorType);
    // The layer still reports itself, so the 5xx stays countable.
    expect(fields[TelemetryAttribute.AppErrorSource]).toBe(
      SpanErrorSource.RouteHandler
    );
    expect(
      contentLeaks(fields, [
        ...baselineAllowedStrings(),
        ORGANIZATION_ID,
        USER_ID,
        SpanErrorSource.RouteHandler,
      ])
    ).toEqual([]);
  });

  /**
   * Positive control. Without this, every assertion above would still pass
   * against a `contentLeaks` that never reports anything — the classic
   * test-cannot-fail shape.
   */
  it("the leak walk actually reports content it is not told to allow", async () => {
    await runRequest(() => successResponse({ ok: true }));

    expect(contentLeaks(emittedLine().fields, [REQUEST_METHOD])).toEqual(
      expect.arrayContaining([REQUEST_PATH])
    );
  });
});

/**
 * The silent-production-failure guard.
 *
 * The keyless-telemetry collector strips any attribute absent from its
 * generated allow-list, with no error at the producer, in the collector, or in
 * Datadog. An attribute added to the contract but missing from a regenerated
 * `collector/allowed-attributes.json` therefore validates locally, passes every
 * schema test, ships — and is never seen again, while the dashboards built on
 * it read empty forever.
 *
 * The assertion reads the COMMITTED artifact, not the in-process
 * `CollectorAllowedAttributeKeys` projection. The projection is derived from
 * the same `TelemetryAttribute` const the emitter stamps from, so it can never
 * disagree with what this request emitted — asserting against it would restate
 * a guarantee it does not provide. The committed file is the thing that can
 * actually be stale, and staleness is the failure being guarded.
 */
describe("collector allow-list coverage", () => {
  it("emits no attribute the committed collector allow-list would strip", async () => {
    // Every attribute a request can add, on one request — including the
    // caller-attested pair, which is only present when the caller sends the
    // headers. Without them this guard would silently stop covering the
    // attributes most recently added to the contract.
    await runRequest(
      () => {
        recordRequestArtifact({
          type: DocumentType.Prd,
          status: DocumentStatus.Draft,
        });
        recordRequestSyncBatch({ batchId: SYNC_BATCH_ID });
        return errorResponse("failed", new TypeError("boom"));
      },
      "apiKey",
      attestedDesktopHeaders()
    );

    const emitted = Object.keys(emittedLine().fields).filter(
      (key) => key in SpanTelemetrySchema.shape
    );

    expect(emitted.length).toBeGreaterThan(0);
    const allowedKeys = committedCollectorAllowedKeys();
    for (const attribute of emitted) {
      expect(
        allowedKeys,
        `${attribute} is emitted but absent from the committed collector allow-list — run \`pnpm --filter @closedloop-ai/telemetry-contract generate:collector-allowlist\``
      ).toContain(attribute);
    }
  });
});

describe("artifact attribution (ISS-7224)", () => {
  it("stamps the artifact subtype and status the handler read off the row", async () => {
    await runRequest(() => {
      recordRequestArtifact({
        type: DocumentType.ImplementationPlan,
        status: DocumentStatus.Approved,
      });
      return successResponse({ ok: true });
    });

    const { fields } = emittedLine();
    // The URL says `/documents/ISS-7217` — an `ISS-` slug, which a
    // path-derived guess would read as a FEATURE. The row said
    // IMPLEMENTATION_PLAN, and the row is what the span carries.
    expect(fields.path).toBe(REQUEST_PATH);
    expect(fields).toMatchObject({
      [TelemetryAttribute.ArtifactType]: DocumentType.ImplementationPlan,
      [TelemetryAttribute.ArtifactStatus]: DocumentStatus.Approved,
    });
  });

  it("leaves the artifact attributes absent on a request that touched none", async () => {
    await runRequest(() => successResponse({ ok: true }));

    const { fields } = emittedLine();
    expect(fields).not.toHaveProperty(TelemetryAttribute.ArtifactType);
    expect(fields).not.toHaveProperty(TelemetryAttribute.ArtifactStatus);
  });
});
