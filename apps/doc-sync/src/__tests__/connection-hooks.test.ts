import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { PassThrough } from "node:stream";
import { log } from "@repo/observability/log";
import { DESKTOP_RENDERER_ORIGIN } from "@repo/realtime-contract/desktop-renderer-origin";
import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import { GrantAccess } from "@repo/realtime-contract/grants";
import { createRevocations } from "@repo/realtime-contract/revocations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocSyncAuthError } from "../auth/authorize";
import {
  authenticateWithToken,
  DOC_SYNC_AUTH_REFUSED_EVENT,
  DOC_SYNC_AUTH_REFUSED_SUPPRESSED_EVENT,
  refuseDisallowedOrigin,
} from "../auth/connection-hooks";
import {
  DOCUMENT_NAME,
  documentToken,
  ORG,
  PUBLIC_KEYS,
  USER_ID,
} from "./auth/test-tokens";

const LIMIT = { maxPerWindow: 3, windowMs: 1000 };

let info: ReturnType<typeof vi.spyOn<typeof log, "info">>;

beforeEach(() => {
  vi.useFakeTimers();
  info = vi.spyOn(log, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Outcome = { refused: boolean; code?: string };

/** What the hook refuses a token that does not verify with, however many lines were logged. */
const REFUSED: Outcome = {
  refused: true,
  code: RealtimeErrorCode.Unauthorized,
};

/** Drives `count` connections whose token does not verify. */
async function refuse(
  authenticate: ReturnType<typeof authenticateWithToken>,
  count: number
): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  for (let attempt = 0; attempt < count; attempt += 1) {
    try {
      await authenticate({
        token: "not-a-token",
        documentName: DOCUMENT_NAME,
        connectionConfig: { readOnly: false, isAuthenticated: false },
      });
      outcomes.push({ refused: false });
    } catch (error) {
      outcomes.push(
        error instanceof DocSyncAuthError
          ? { refused: true, code: error.code }
          : { refused: false }
      );
    }
  }
  return outcomes;
}

function refusals(count: number): Outcome[] {
  return new Array(count).fill(REFUSED);
}

function lines(event: string): unknown[] {
  return info.mock.calls
    .map(([, fields]) => fields)
    .filter(
      (fields) =>
        typeof fields === "object" &&
        fields !== null &&
        "event" in fields &&
        fields.event === event
    );
}

describe("authenticateWithToken refusal log", () => {
  it("logs each refusal up to the cap", async () => {
    const authenticate = authenticateWithToken(PUBLIC_KEYS, {
      revocations: createRevocations(),
      refusalLogLimit: LIMIT,
    });

    expect(await refuse(authenticate, LIMIT.maxPerWindow)).toEqual(
      refusals(LIMIT.maxPerWindow)
    );

    expect(lines(DOC_SYNC_AUTH_REFUSED_EVENT)).toEqual(
      new Array(LIMIT.maxPerWindow).fill({
        event: DOC_SYNC_AUTH_REFUSED_EVENT,
        documentName: DOCUMENT_NAME,
        code: RealtimeErrorCode.Unauthorized,
      })
    );
  });

  it("suppresses refusals past the cap until the window ends, still refusing them", async () => {
    const authenticate = authenticateWithToken(PUBLIC_KEYS, {
      revocations: createRevocations(),
      refusalLogLimit: LIMIT,
    });

    expect(await refuse(authenticate, LIMIT.maxPerWindow + 2)).toEqual(
      refusals(LIMIT.maxPerWindow + 2)
    );

    expect(lines(DOC_SYNC_AUTH_REFUSED_EVENT)).toHaveLength(LIMIT.maxPerWindow);
    expect(lines(DOC_SYNC_AUTH_REFUSED_SUPPRESSED_EVENT)).toEqual([]);
  });

  it("reports the suppressed count once when the window ends", async () => {
    const authenticate = authenticateWithToken(PUBLIC_KEYS, {
      revocations: createRevocations(),
      refusalLogLimit: LIMIT,
    });

    await refuse(authenticate, LIMIT.maxPerWindow + 2);
    await vi.advanceTimersByTimeAsync(LIMIT.windowMs);
    await vi.advanceTimersByTimeAsync(LIMIT.windowMs * 5);

    expect(lines(DOC_SYNC_AUTH_REFUSED_SUPPRESSED_EVENT)).toEqual([
      {
        event: DOC_SYNC_AUTH_REFUSED_SUPPRESSED_EVENT,
        suppressedCount: 2,
        windowMs: LIMIT.windowMs,
      },
    ]);
  });

  it("reports nothing for a window that suppressed nothing", async () => {
    const authenticate = authenticateWithToken(PUBLIC_KEYS, {
      revocations: createRevocations(),
      refusalLogLimit: LIMIT,
    });

    await refuse(authenticate, LIMIT.maxPerWindow);
    await vi.advanceTimersByTimeAsync(LIMIT.windowMs * 5);

    expect(lines(DOC_SYNC_AUTH_REFUSED_SUPPRESSED_EVENT)).toEqual([]);
  });

  it("resets the cap and the count for the next window", async () => {
    const authenticate = authenticateWithToken(PUBLIC_KEYS, {
      revocations: createRevocations(),
      refusalLogLimit: LIMIT,
    });

    await refuse(authenticate, LIMIT.maxPerWindow + 2);
    await vi.advanceTimersByTimeAsync(LIMIT.windowMs);
    await refuse(authenticate, LIMIT.maxPerWindow + 1);
    await vi.advanceTimersByTimeAsync(LIMIT.windowMs);

    expect(lines(DOC_SYNC_AUTH_REFUSED_EVENT)).toHaveLength(
      LIMIT.maxPerWindow * 2
    );
    expect(
      lines(DOC_SYNC_AUTH_REFUSED_SUPPRESSED_EVENT).map(
        (fields) => (fields as { suppressedCount: number }).suppressedCount
      )
    ).toEqual([2, 1]);
  });

  it("reports a window the clock ended before its timer fired, once", async () => {
    let clock = 0;
    const authenticate = authenticateWithToken(PUBLIC_KEYS, {
      revocations: createRevocations(),
      refusalLogLimit: LIMIT,
      now: () => clock,
    });

    await refuse(authenticate, LIMIT.maxPerWindow + 2);
    clock = LIMIT.windowMs;
    await refuse(authenticate, 1);

    expect(lines(DOC_SYNC_AUTH_REFUSED_SUPPRESSED_EVENT)).toEqual([
      {
        event: DOC_SYNC_AUTH_REFUSED_SUPPRESSED_EVENT,
        suppressedCount: 2,
        windowMs: LIMIT.windowMs,
      },
    ]);
    expect(lines(DOC_SYNC_AUTH_REFUSED_EVENT)).toHaveLength(
      LIMIT.maxPerWindow + 1
    );

    await vi.advanceTimersByTimeAsync(LIMIT.windowMs * 5);

    expect(lines(DOC_SYNC_AUTH_REFUSED_SUPPRESSED_EVENT)).toHaveLength(1);
  });
});

describe("refuseDisallowedOrigin", () => {
  const ALLOWED_ORIGIN = "http://localhost:3000";

  /** Runs the hook for one upgrade: whether it was admitted, and what the socket was sent. */
  async function upgrade(
    origin: string | undefined
  ): Promise<{ admitted: boolean; answered: unknown[][] }> {
    const request = new IncomingMessage(new Socket());
    if (origin !== undefined) {
      request.headers.origin = origin;
    }
    const socket = new PassThrough();
    const end = vi.spyOn(socket, "end");
    const admitted = await refuseDisallowedOrigin([ALLOWED_ORIGIN])({
      request,
      socket,
    }).then(
      () => true,
      () => false
    );
    return { admitted, answered: end.mock.calls };
  }

  const ADMITTED = { admitted: true, answered: [] };
  const REFUSED_UPGRADE = {
    admitted: false,
    answered: [[expect.stringContaining("403 Forbidden")]],
  };

  it("admits the packaged desktop renderer's exact origin", async () => {
    expect(await upgrade(DESKTOP_RENDERER_ORIGIN)).toEqual(ADMITTED);
  });

  it("admits a configured browser origin and an upgrade with no origin", async () => {
    expect(await upgrade(ALLOWED_ORIGIN)).toEqual(ADMITTED);
    expect(await upgrade(undefined)).toEqual(ADMITTED);
  });

  it.each([
    "app://other",
    "app://renderer.evil",
    "null",
    "https://unlisted.example",
  ])("refuses %s", async (origin) => {
    expect(await upgrade(origin)).toEqual(REFUSED_UPGRADE);
  });
});

describe("authenticateWithToken on a deleted document", () => {
  it("refuses a valid token when the delete lands while it is being verified", async () => {
    const token = await documentToken(GrantAccess.Write);
    const payload = () => ({
      token,
      documentName: DOCUMENT_NAME,
      connectionConfig: { readOnly: false, isAuthenticated: false },
    });
    await expect(
      authenticateWithToken(PUBLIC_KEYS, { revocations: createRevocations() })(
        payload()
      )
    ).resolves.toEqual({
      userId: USER_ID,
      orgId: ORG,
      tokenIssuedAt: expect.any(Number),
    });
    let deleted = false;
    const authenticate = authenticateWithToken(PUBLIC_KEYS, {
      revocations: createRevocations(),
      // Not deleted when the hook starts; deleted by the time the verify resolves.
      isDeleted: () => {
        const answer = deleted;
        deleted = true;
        return answer;
      },
    });

    await expect(authenticate(payload())).rejects.toMatchObject({
      code: RealtimeErrorCode.Unauthorized,
    });
  });
});

describe("authenticateWithToken on a revoked token", () => {
  it("refuses a token its user's revoke binds as forbidden, and logs the refusal", async () => {
    const token = await documentToken(GrantAccess.Write);
    const revocations = createRevocations();
    revocations.record({ target: { userId: USER_ID }, at: Date.now() });

    await expect(
      authenticateWithToken(PUBLIC_KEYS, { revocations })({
        token,
        documentName: DOCUMENT_NAME,
        connectionConfig: { readOnly: false, isAuthenticated: false },
      })
    ).rejects.toMatchObject({ code: RealtimeErrorCode.Forbidden });
    expect(lines(DOC_SYNC_AUTH_REFUSED_EVENT)).toEqual([
      {
        event: DOC_SYNC_AUTH_REFUSED_EVENT,
        documentName: DOCUMENT_NAME,
        code: RealtimeErrorCode.Forbidden,
      },
    ]);
  });
});
