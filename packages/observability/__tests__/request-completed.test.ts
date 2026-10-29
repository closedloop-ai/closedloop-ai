import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { TelemetryEmitMetadataKey } from "@closedloop-ai/telemetry-contract/emit";
import { TelemetrySchemaName } from "@closedloop-ai/telemetry-contract/schema-name";
import {
  SpanErrorSource,
  SpanTelemetrySchema,
} from "@closedloop-ai/telemetry-contract/span";
import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "../log";
import {
  buildRequestCompletedContractAttributes,
  normalizeRequestCompletedUrlPath,
  REQUEST_COMPLETED_CONTRACT_EVENT_NAME,
  type RequestCompletedSpanAttribution,
} from "../telemetry/request-completed";

const ORGANIZATION_ID = "0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f";
const USER_ID = "019c2500-1f4c-7a10-9d33-6b0f2c8e41aa";
const INSTALLATION_ID = "019c26aa-3c11-7bb2-8f04-1d7e5a9c3311";
const CLIENT_VERSION = "1.24.3";
const SYNC_BATCH_ID = "3f2a91c4-7d5e-4b18-9a03-6e8c1d47b2f5";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("normalizeRequestCompletedUrlPath", () => {
  it.each([
    ["strips query", "https://api.test/api/loops?token=secret", "/api/loops"],
    [
      "ignores query control characters",
      "https://api.test/api/loops?token=\u0000secret",
      "/api/loops",
    ],
    ["strips fragment", "https://api.test/api/loops#section", "/api/loops"],
    [
      "preserves percent encoding",
      "https://api.test/api/%2Fencoded",
      "/api/%2Fencoded",
    ],
  ])("%s", (_name, requestUrl, expectedPath) => {
    expect(normalizeRequestCompletedUrlPath(requestUrl)).toBe(expectedPath);
  });

  it.each([
    ["embedded full URL", "https://api.test/http://evil.test/a"],
    ["protocol-relative path", "https://api.test//evil.test/a"],
    ["userinfo-like first segment", "https://api.test/user:pass@example.com/a"],
    ["raw control character", "https://api.test/api/\u0000loops"],
    ["parse failure", "not a valid absolute url"],
  ])("falls back for %s", (_name, requestUrl) => {
    expect(normalizeRequestCompletedUrlPath(requestUrl)).toBe("/");
  });
});

describe("buildRequestCompletedContractAttributes", () => {
  it("returns the schema-marked span attributes for the caller to merge", () => {
    expect(
      buildRequestCompletedContractAttributes({
        requestUrl: "https://api.test/api/loops?token=secret",
        method: "POST",
        statusCode: 201,
        durationMs: 34,
      })
    ).toEqual({
      [TelemetryAttribute.HttpRequestMethod]: "POST",
      [TelemetryAttribute.HttpResponseStatusCode]: 201,
      [TelemetryAttribute.UrlPath]: "/api/loops",
      [TelemetryAttribute.DurationMs]: 34,
      [TelemetryEmitMetadataKey.SchemaName]: TelemetrySchemaName.Span,
    });
  });

  it("carries the resolved tenant, artifact, and error attribution", () => {
    expect(
      buildRequestCompletedContractAttributes({
        requestUrl: "https://api.test/documents/ISS-7217",
        method: "PUT",
        statusCode: 500,
        durationMs: 34,
        attribution: {
          organizationId: ORGANIZATION_ID,
          userId: USER_ID,
          installationId: INSTALLATION_ID,
          clientVersion: CLIENT_VERSION,
          errorSource: SpanErrorSource.RouteHandler,
          errorType: "PrismaClientKnownRequestError.P2002",
          artifactType: "FEATURE",
          artifactStatus: "IN_PROGRESS",
          syncBatchId: SYNC_BATCH_ID,
        },
      })
    ).toMatchObject({
      [TelemetryAttribute.AppOrganizationId]: ORGANIZATION_ID,
      [TelemetryAttribute.UserId]: USER_ID,
      [TelemetryAttribute.AppInstallationId]: INSTALLATION_ID,
      [TelemetryAttribute.AppClientVersion]: CLIENT_VERSION,
      [TelemetryAttribute.AppErrorSource]: SpanErrorSource.RouteHandler,
      [TelemetryAttribute.ErrorType]: "PrismaClientKnownRequestError.P2002",
      [TelemetryAttribute.ArtifactType]: "FEATURE",
      [TelemetryAttribute.ArtifactStatus]: "IN_PROGRESS",
      [TelemetryAttribute.SyncBatchId]: SYNC_BATCH_ID,
    });
  });

  /**
   * ISS-7221: an unauthenticated or org-less request must leave the tenant
   * attribute ABSENT. A default, a placeholder, or an empty string would make
   * "which org is failing" answerable and wrong, which is worse than the gap
   * the ticket set out to close.
   */
  it("omits every attribution attribute the request could not supply", () => {
    const attributes = buildRequestCompletedContractAttributes({
      requestUrl: "https://api.test/documents",
      method: "GET",
      statusCode: 401,
      durationMs: 2,
    });

    for (const attribute of [
      TelemetryAttribute.AppOrganizationId,
      TelemetryAttribute.UserId,
      TelemetryAttribute.AppInstallationId,
      TelemetryAttribute.AppClientVersion,
      TelemetryAttribute.AppErrorSource,
      TelemetryAttribute.ErrorType,
      TelemetryAttribute.ArtifactType,
      TelemetryAttribute.ArtifactStatus,
    ]) {
      expect(attributes).not.toHaveProperty(attribute);
    }
  });

  /**
   * The `.strict()` boundary trap. Folding an unvalidated attribution value
   * into the parse would let ONE bad optional field fail the whole `safeParse`
   * and silently drop `url.path`, `duration_ms`, and the status code with it —
   * the exact whole-payload loss this repo has shipped before.
   */
  it("drops only the offending attribution value, never the whole span", () => {
    const attributes = buildRequestCompletedContractAttributes({
      requestUrl: "https://api.test/documents/ISS-7217",
      method: "GET",
      statusCode: 200,
      durationMs: 7,
      attribution: {
        organizationId: ORGANIZATION_ID,
        artifactType: "a title that is not an enum token",
        artifactStatus: "IN_REVIEW",
      },
    });

    expect(attributes).toMatchObject({
      [TelemetryAttribute.UrlPath]: "/documents/ISS-7217",
      [TelemetryAttribute.DurationMs]: 7,
      [TelemetryAttribute.HttpResponseStatusCode]: 200,
      [TelemetryAttribute.AppOrganizationId]: ORGANIZATION_ID,
      [TelemetryAttribute.ArtifactStatus]: "IN_REVIEW",
    });
    expect(attributes).not.toHaveProperty(TelemetryAttribute.ArtifactType);
  });

  /**
   * ISS-7227: the same per-attribute isolation for the sync join key. The
   * server validates `batchId` as a UUID before recording it, so a value that
   * fails here means a version-skewed or hostile producer reached the store —
   * it must cost itself the attribute and take nothing else off the line, least
   * of all the error attribution the same 500 depends on.
   */
  it("drops a sync batch id that is not a UUID without dropping the error attribution", () => {
    const attributes = buildRequestCompletedContractAttributes({
      requestUrl: "https://api.test/desktop/agent-sessions/sync",
      method: "POST",
      statusCode: 500,
      durationMs: 9,
      attribution: {
        organizationId: ORGANIZATION_ID,
        errorSource: SpanErrorSource.RouteHandler,
        errorType: "PrismaClientKnownRequestError.P2002",
        syncBatchId: "batch-1",
      },
    });

    expect(attributes).toMatchObject({
      [TelemetryAttribute.UrlPath]: "/desktop/agent-sessions/sync",
      [TelemetryAttribute.DurationMs]: 9,
      [TelemetryAttribute.HttpResponseStatusCode]: 500,
      [TelemetryAttribute.AppOrganizationId]: ORGANIZATION_ID,
      [TelemetryAttribute.AppErrorSource]: SpanErrorSource.RouteHandler,
      [TelemetryAttribute.ErrorType]: "PrismaClientKnownRequestError.P2002",
    });
    expect(attributes).not.toHaveProperty(TelemetryAttribute.SyncBatchId);
  });

  /**
   * ISS-8748: the same per-attribute isolation for the identity half. A user id
   * that is not a UUID — a Clerk id from a version-skewed caller, an email a
   * future recorder reaches for — costs itself and nothing else, and in
   * particular does not take the tenant down with it.
   */
  it("drops a user id that is not a UUID without dropping the tenant", () => {
    const attributes = buildRequestCompletedContractAttributes({
      requestUrl: "https://api.test/documents/ISS-8748",
      method: "GET",
      statusCode: 200,
      durationMs: 3,
      attribution: {
        organizationId: ORGANIZATION_ID,
        userId: "owner@example.com",
      },
    });

    expect(attributes).toMatchObject({
      [TelemetryAttribute.AppOrganizationId]: ORGANIZATION_ID,
      [TelemetryAttribute.UrlPath]: "/documents/ISS-8748",
    });
    expect(attributes).not.toHaveProperty(TelemetryAttribute.UserId);
  });

  /**
   * ISS-8749: the attested half degrades the same way. A version-skewed Desktop
   * that reports a build string the span schema rejects keeps its installation
   * id, and neither can take the span down with it.
   */
  it("drops an attested client version the span schema rejects", () => {
    const attributes = buildRequestCompletedContractAttributes({
      requestUrl: "https://api.test/documents/ISS-8749",
      method: "GET",
      statusCode: 200,
      durationMs: 3,
      attribution: {
        installationId: INSTALLATION_ID,
        clientVersion: "1.24.3\u0007",
      },
    });

    expect(attributes).toMatchObject({
      [TelemetryAttribute.AppInstallationId]: INSTALLATION_ID,
      [TelemetryAttribute.UrlPath]: "/documents/ISS-8749",
    });
    expect(attributes).not.toHaveProperty(TelemetryAttribute.AppClientVersion);
  });

  /**
   * Guards the gap between "mapped" and "actually projected": a field can be
   * added to `SpanAttributionAttribute` and still never reach the span if the
   * projection forgets to spread it. Supplying every field at once and
   * requiring every mapped attribute to appear closes that.
   */
  it("projects every attribution field it declares a span attribute for", () => {
    const attributes =
      buildRequestCompletedContractAttributes({
        requestUrl: "https://api.test/documents/ISS-7217",
        method: "PUT",
        statusCode: 500,
        durationMs: 1,
        attribution: {
          organizationId: ORGANIZATION_ID,
          userId: USER_ID,
          installationId: INSTALLATION_ID,
          clientVersion: CLIENT_VERSION,
          errorSource: SpanErrorSource.AuthWrapper,
          errorType: "TypeError",
          artifactType: "PRD",
          artifactStatus: "DRAFT",
          syncBatchId: SYNC_BATCH_ID,
        },
      }) ?? {};

    const declared: Record<keyof RequestCompletedSpanAttribution, string> = {
      organizationId: TelemetryAttribute.AppOrganizationId,
      userId: TelemetryAttribute.UserId,
      installationId: TelemetryAttribute.AppInstallationId,
      clientVersion: TelemetryAttribute.AppClientVersion,
      errorSource: TelemetryAttribute.AppErrorSource,
      errorType: TelemetryAttribute.ErrorType,
      artifactType: TelemetryAttribute.ArtifactType,
      artifactStatus: TelemetryAttribute.ArtifactStatus,
      syncBatchId: TelemetryAttribute.SyncBatchId,
    };

    for (const attribute of Object.values(declared)) {
      expect(attributes).toHaveProperty(attribute);
    }
  });

  // ISS-5039: the whole point of returning attributes is that no second log
  // line is billed. A future refactor that reinstates an emit() here would
  // silently restore the duplicate event this change removed.
  it("emits no log line of its own", () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);

    buildRequestCompletedContractAttributes({
      requestUrl: "https://api.test/api/loops",
      method: "GET",
      statusCode: 200,
      durationMs: 1,
    });

    expect(info).not.toHaveBeenCalled();
  });

  it("returns undefined when the values fail span-schema validation", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    expect(
      buildRequestCompletedContractAttributes({
        requestUrl: "https://api.test/api/loops",
        method: "GET",
        statusCode: 99,
        durationMs: 1,
      })
    ).toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      `${REQUEST_COMPLETED_CONTRACT_EVENT_NAME} build skipped`,
      expect.objectContaining({
        reason: "schema_validation_failed",
        [TelemetryEmitMetadataKey.SchemaName]: TelemetrySchemaName.Span,
      })
    );
  });

  it("contains contract build failures", () => {
    vi.spyOn(SpanTelemetrySchema, "safeParse").mockImplementation(() => {
      throw new Error("validator unavailable");
    });
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    expect(() =>
      buildRequestCompletedContractAttributes({
        requestUrl: "https://api.test/api/loops",
        method: "GET",
        statusCode: 200,
        durationMs: 1,
      })
    ).not.toThrow();

    expect(warn).toHaveBeenCalledWith(
      `${REQUEST_COMPLETED_CONTRACT_EVENT_NAME} build skipped`,
      expect.objectContaining({
        reason: "build_failed",
        [TelemetryEmitMetadataKey.SchemaName]: TelemetrySchemaName.Span,
      })
    );
  });
});
