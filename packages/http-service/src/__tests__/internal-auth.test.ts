import { log } from "@repo/observability/log";
import { Hono } from "hono";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import { HttpServiceErrorCode, serviceErrorHandler } from "../errors";
import {
  type InternalAuthVariables,
  requireInternalOidc,
} from "../internal-auth";
import {
  InternalOidcVerdict,
  type InternalOidcVerification,
  type InternalOidcVerifier,
} from "../internal-oidc";

const TOKEN = "header.payload.signature";
const FAULT_EVENT = "test.fault";

let downstream: Mock<() => void>;
let rejection: string | undefined;

function appWith(verify: InternalOidcVerifier) {
  const app = new Hono<{ Variables: InternalAuthVariables }>();
  app.onError(serviceErrorHandler(FAULT_EVENT));
  app.use("*", async (c, next) => {
    await next();
    rejection = c.get("internalOidcRejection");
  });
  app.use("*", requireInternalOidc(verify));
  app.get("/internal/x", (c) => {
    downstream();
    return c.json({ ok: true });
  });
  return app;
}

const verifying = (verification: InternalOidcVerification) =>
  vi.fn<InternalOidcVerifier>(() => Promise.resolve(verification));

const get = (app: Hono<{ Variables: InternalAuthVariables }>, auth?: string) =>
  app.request("/internal/x", {
    headers: auth === undefined ? {} : { authorization: auth },
  });

beforeEach(() => {
  downstream = vi.fn<() => void>();
  rejection = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("requireInternalOidc", () => {
  it("hands a verified bearer to the next handler", async () => {
    const verify = verifying({ verdict: InternalOidcVerdict.Verified });

    const response = await get(appWith(verify), `Bearer ${TOKEN}`);

    expect(response.status).toBe(200);
    expect(verify).toHaveBeenCalledExactlyOnceWith(TOKEN);
    expect(downstream).toHaveBeenCalledOnce();
  });

  it("answers a rejected bearer 401 unauthorized and records the reason", async () => {
    const verify = verifying({
      verdict: InternalOidcVerdict.Rejected,
      reason: "aud",
    });

    const response = await get(appWith(verify), `Bearer ${TOKEN}`);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      code: HttpServiceErrorCode.Unauthorized,
    });
    expect(rejection).toBe("aud");
    expect(downstream).not.toHaveBeenCalled();
  });

  it("fails closed with an empty 503 when the JWKS is unavailable", async () => {
    const verify = verifying({ verdict: InternalOidcVerdict.Unavailable });

    const response = await get(appWith(verify), `Bearer ${TOKEN}`);

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("");
    expect(downstream).not.toHaveBeenCalled();
  });

  it.each([
    ["no Authorization header", undefined],
    ["a non-bearer scheme", `Basic ${TOKEN}`],
    ["a bearer with no token", "Bearer "],
    ["a token with a space in it", `Bearer ${TOKEN} extra`],
  ])("answers %s 401 without verifying", async (_label, auth) => {
    const verify = verifying({ verdict: InternalOidcVerdict.Verified });

    const response = await get(appWith(verify), auth);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      code: HttpServiceErrorCode.Unauthorized,
    });
    expect(verify).not.toHaveBeenCalled();
    expect(downstream).not.toHaveBeenCalled();
  });

  it("lets a throwing verifier reach onError, which answers 500", async () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const verify = vi.fn<InternalOidcVerifier>(() =>
      Promise.reject(new Error("boom"))
    );

    const response = await get(appWith(verify), `Bearer ${TOKEN}`);

    expect(response.status).toBe(500);
    expect(error).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      expect.objectContaining({ event: FAULT_EVENT })
    );
    expect(downstream).not.toHaveBeenCalled();
  });
});
