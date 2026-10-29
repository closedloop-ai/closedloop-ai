import { describe, expect, it } from "vitest";
import {
  buildDesktopClientAttributionHeaders,
  buildDesktopUpdaterRequestHeaders,
  DESKTOP_CLIENT_VERSION_MAX_LENGTH,
  DesktopClientAttributionHeader,
  DesktopUpdaterRingHeader,
  narrowDesktopUpdaterHeadersForRedirect,
  parseDesktopClientAttributionHeaders,
  parseDesktopUpdaterComputeTargetId,
} from "./desktop-client-attribution";

const INSTALLATION_ID = "0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f";

/**
 * The published wire names, written out rather than read off the const the
 * module exports. Comparing the map to itself would pin nothing, and these two
 * strings are a cross-process contract: a Desktop build in the field keeps
 * sending the old spelling long after a rename here, so the rename has to fail
 * a test rather than silently stop matching.
 */
describe("DesktopClientAttributionHeader", () => {
  it("exports the exact published header names", () => {
    expect(DesktopClientAttributionHeader).toEqual({
      InstallationId: "x-desktop-installation-id",
      ClientVersion: "x-desktop-client-version",
      ComputeTargetId: "x-desktop-compute-target-id",
    });
  });
});

describe("buildDesktopClientAttributionHeaders", () => {
  it("renders both headers when both values validate", () => {
    expect(
      buildDesktopClientAttributionHeaders({
        installationId: INSTALLATION_ID,
        clientVersion: "1.24.3",
      })
    ).toEqual({
      "x-desktop-installation-id": INSTALLATION_ID,
      "x-desktop-client-version": "1.24.3",
    });
  });

  it("omits an absent field rather than sending an empty or null header", () => {
    const headers = buildDesktopClientAttributionHeaders({
      installationId: INSTALLATION_ID,
    });

    expect(headers).toEqual({ "x-desktop-installation-id": INSTALLATION_ID });
    expect(
      Object.hasOwn(headers, DesktopClientAttributionHeader.ClientVersion)
    ).toBe(false);
  });

  it("sends nothing at all when the process has published no attribution", () => {
    expect(buildDesktopClientAttributionHeaders(undefined)).toEqual({});
  });

  it("drops one bad value without dropping its sibling", () => {
    expect(
      buildDesktopClientAttributionHeaders({
        installationId: INSTALLATION_ID,
        clientVersion: "/Users/someone/Applications/ClosedLoop.app",
      })
    ).toEqual({ "x-desktop-installation-id": INSTALLATION_ID });

    expect(
      buildDesktopClientAttributionHeaders({
        installationId: "not-a-uuid",
        clientVersion: "1.24.3",
      })
    ).toEqual({ "x-desktop-client-version": "1.24.3" });
  });
});

describe("parseDesktopClientAttributionHeaders", () => {
  it("reads both attested values off the request", () => {
    expect(
      parseDesktopClientAttributionHeaders(
        new Headers({
          "x-desktop-installation-id": INSTALLATION_ID,
          "x-desktop-client-version": "2.0.0-beta.1",
        })
      )
    ).toEqual({
      installationId: INSTALLATION_ID,
      clientVersion: "2.0.0-beta.1",
    });
  });

  /**
   * The version-skew case: an older Desktop build sends neither header. The
   * result must be an EMPTY object, not one carrying explicit `undefined`
   * members — the span emitter reads field presence, and a declared-but-
   * undefined key is a different fact from an absent one.
   */
  it("returns an empty attribution for a client that sends neither header", () => {
    const attribution = parseDesktopClientAttributionHeaders(new Headers());

    expect(attribution).toEqual({});
    expect(Object.keys(attribution)).toEqual([]);
  });

  it("drops malformed and hostile values without throwing", () => {
    for (const [name, headers] of [
      ["blank", { "x-desktop-installation-id": "" }],
      ["a Clerk id", { "x-desktop-installation-id": "user_2abcDEFghi" }],
      ["an email", { "x-desktop-client-version": "owner@example.com" }],
      ["a sentence", { "x-desktop-client-version": "version one point two" }],
      [
        "an over-long version",
        {
          "x-desktop-client-version": `1.${"0".repeat(
            DESKTOP_CLIENT_VERSION_MAX_LENGTH
          )}`,
        },
      ],
    ] as const) {
      expect(
        parseDesktopClientAttributionHeaders(new Headers(headers)),
        name
      ).toEqual({});
    }
  });

  /**
   * A suffix must be identifiers, not punctuation. The earlier
   * `[0-9A-Za-z.-]+` suffix class admitted every value on the left, none of
   * which any Desktop resolver emits — they are a caller putting junk in the
   * `app.client.version` facet. The right-hand cases are the real pre-release
   * and build shapes and must survive the narrowing.
   */
  it("refuses a punctuation-only version suffix but keeps real ones", () => {
    for (const junk of ["1.2.3+.", "1.2.3+-", "1.2.3-", "1.2.3-a..b"]) {
      expect(
        parseDesktopClientAttributionHeaders(
          new Headers({ "x-desktop-client-version": junk })
        ),
        junk
      ).toEqual({});
    }

    for (const real of ["0.16.69", "2.0.0-beta.1", "1.2.3+build.5"]) {
      expect(
        parseDesktopClientAttributionHeaders(
          new Headers({ "x-desktop-client-version": real })
        ),
        real
      ).toEqual({ clientVersion: real });
    }
  });

  it("keeps the valid header when its sibling is malformed", () => {
    expect(
      parseDesktopClientAttributionHeaders(
        new Headers({
          "x-desktop-installation-id": INSTALLATION_ID,
          "x-desktop-client-version": "not a version",
        })
      )
    ).toEqual({ installationId: INSTALLATION_ID });
  });

  /**
   * Positive control. Without it, every omission assertion above would still
   * pass against a parser that returned `{}` unconditionally.
   */
  it("actually reads a header rather than always returning empty", () => {
    expect(
      parseDesktopClientAttributionHeaders(
        new Headers({ "x-desktop-client-version": "9.9.9" })
      )
    ).toEqual({ clientVersion: "9.9.9" });
  });
});

/**
 * The ISS-9164 updater wire, pinned the same way and for the same reason: an
 * installed build keeps sending these spellings for as long as it is installed,
 * so a rename here has to fail rather than silently stop matching. Written out,
 * never read off the module.
 */
const COMPUTE_TARGET_ID_HEADER = "x-desktop-compute-target-id";
const COMPUTE_TARGET_ID = "01a06a86-56fa-7213-ae2d-3f5fe0932ec5";

describe("DesktopUpdaterRingHeader", () => {
  it("exports the exact published response header name", () => {
    expect(DesktopUpdaterRingHeader).toBe("x-desktop-ring");
  });
});

describe("buildDesktopUpdaterRequestHeaders", () => {
  it("renders the compute-target id and the client version together", () => {
    expect(
      buildDesktopUpdaterRequestHeaders({
        computeTargetId: COMPUTE_TARGET_ID,
        clientVersion: "1.24.3",
      })
    ).toEqual({
      [COMPUTE_TARGET_ID_HEADER]: COMPUTE_TARGET_ID,
      "x-desktop-client-version": "1.24.3",
    });
  });

  it("omits the compute-target id when this install has none", () => {
    const headers = buildDesktopUpdaterRequestHeaders({
      computeTargetId: null,
      clientVersion: "1.24.3",
    });

    expect(headers).toEqual({ "x-desktop-client-version": "1.24.3" });
    expect(COMPUTE_TARGET_ID_HEADER in headers).toBe(false);
  });

  it("drops a malformed compute-target id without taking the version with it", () => {
    expect(
      buildDesktopUpdaterRequestHeaders({
        computeTargetId: "not-a-uuid",
        clientVersion: "1.24.3",
      })
    ).toEqual({ "x-desktop-client-version": "1.24.3" });
  });

  it("sends nothing at all when neither value validates", () => {
    expect(
      buildDesktopUpdaterRequestHeaders({
        computeTargetId: undefined,
        clientVersion: "a sentence, not a version",
      })
    ).toEqual({});
  });
});

describe("parseDesktopUpdaterComputeTargetId", () => {
  it("reads the attested compute-target id", () => {
    expect(
      parseDesktopUpdaterComputeTargetId(
        new Headers({ [COMPUTE_TARGET_ID_HEADER]: COMPUTE_TARGET_ID })
      )
    ).toBe(COMPUTE_TARGET_ID);
  });

  it("answers undefined for a request from a build that predates the header", () => {
    expect(parseDesktopUpdaterComputeTargetId(new Headers())).toBeUndefined();
  });

  it("answers undefined for a malformed id rather than passing it through", () => {
    expect(
      parseDesktopUpdaterComputeTargetId(
        new Headers({ [COMPUTE_TARGET_ID_HEADER]: "../../etc/passwd" })
      )
    ).toBeUndefined();
  });

  it("ignores the general attribution headers, which are a different lane", () => {
    expect(
      parseDesktopUpdaterComputeTargetId(
        new Headers({ "x-desktop-installation-id": INSTALLATION_ID })
      )
    ).toBeUndefined();
  });
});

/**
 * ISS-9790 — `autoUpdater.requestHeaders` is one property read by the feed check
 * and again by the asset download, which 302s cross-origin to the release host.
 * The pinned `builder-util-runtime@9.6.2` replays every header onto the new
 * origin except `authorization`, so what protects a first-party value is that it
 * is not on the property when the download starts.
 *
 * What the REAL dependency does on a real two-origin hop is executed in
 * `apps/desktop/test/updater-redirect-header-leak.test.ts`; this file owns the
 * classification itself.
 */
describe("narrowDesktopUpdaterHeadersForRedirect", () => {
  it("keeps the client version, which the asset URL already spells", () => {
    expect(
      narrowDesktopUpdaterHeadersForRedirect({
        "x-desktop-client-version": "1.24.3",
      })
    ).toEqual({ "x-desktop-client-version": "1.24.3" });
  });

  it("drops the compute-target id and keeps its sibling in one pass", () => {
    // Both in, one out: a narrowing that returned {} would satisfy the drop
    // assertion alone while silently un-attributing every download.
    expect(
      narrowDesktopUpdaterHeadersForRedirect({
        "x-desktop-compute-target-id": COMPUTE_TARGET_ID,
        "x-desktop-client-version": "1.24.3",
      })
    ).toEqual({ "x-desktop-client-version": "1.24.3" });
  });

  it("drops a header nothing classified rather than passing it through", () => {
    // Fail-closed is the whole mechanism: a header stamped straight onto the
    // singleton never reaches the exhaustive Record, so the only safe default
    // for an unrecognised name is to drop it.
    expect(
      narrowDesktopUpdaterHeadersForRedirect({
        "x-desktop-future-header": "whatever-the-next-person-adds",
        authorization: "Bearer synthetic-sentinel-not-a-credential",
        "x-desktop-client-version": "1.24.3",
      })
    ).toEqual({ "x-desktop-client-version": "1.24.3" });
  });

  it("matches header names case-insensitively, as HTTP does", () => {
    expect(
      narrowDesktopUpdaterHeadersForRedirect({
        "X-Desktop-Client-Version": "1.24.3",
        "X-Desktop-Compute-Target-Id": COMPUTE_TARGET_ID,
      })
    ).toEqual({ "X-Desktop-Client-Version": "1.24.3" });
  });

  it.each([
    ["a never-stamped property", undefined],
    ["a cleared property", null],
    ["an empty set", {}],
  ])("narrows %s to an empty set rather than throwing", (_label, headers) => {
    expect(narrowDesktopUpdaterHeadersForRedirect(headers)).toEqual({});
  });

  it("narrows exactly what the builder stamps on a fully attributed check", () => {
    // The production pairing, so the two functions cannot drift apart: whatever
    // the check stamps is what the download leg narrows.
    const stamped = buildDesktopUpdaterRequestHeaders({
      computeTargetId: COMPUTE_TARGET_ID,
      clientVersion: "1.24.3",
    });

    expect(stamped["x-desktop-compute-target-id"]).toBe(COMPUTE_TARGET_ID);
    expect(narrowDesktopUpdaterHeadersForRedirect(stamped)).toEqual({
      "x-desktop-client-version": "1.24.3",
    });
  });
});
