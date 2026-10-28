import { Script } from "node:vm";
import type { ElectronApplication } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { E2E_NO_REVEAL_ARG } from "../src/main/lifecycle/window-reveal-suppression.js";
import { evaluateElectronSynchronously } from "./e2e/helpers/evaluate-electron-synchronously.js";
import { installOpenExternalSpy } from "./e2e/helpers/open-external-spy.js";

const packageMetadata = vi.hoisted(() => ({ version: "1.60.0" }));
vi.mock("node:module", () => ({ createRequire: () => () => packageMetadata }));
afterEach(() => {
  packageMetadata.version = "1.60.0";
});

const resultSchema = z.object({ session: z.string(), signingKey: z.string() });
const parametersSchema = z.object({
  functionDeclaration: z.string(),
  objectId: z.string(),
  arguments: z.tuple([
    z.object({ objectId: z.string() }),
    z.object({ value: z.unknown() }),
  ]),
  returnByValue: z.boolean(),
  awaitPromise: z.boolean(),
});
const callbackSchema = z.custom<(module: unknown, payload: unknown) => unknown>(
  (value) => typeof value === "function"
);

function fixture(encryptionAvailable = true, argv: string[] = []) {
  const encryptString = vi.fn((value: string) =>
    Buffer.from(`encrypted:${value}`)
  );
  const initialOpenExternal = vi.fn((_url: string) => Promise.resolve());
  const globals: {
    process: { argv: string[] };
    __openedExternalUrls?: string[];
  } = { process: { argv } };
  const module = {
    shell: { openExternal: initialOpenExternal },
    safeStorage: {
      isEncryptionAvailable: () => encryptionAvailable,
      encryptString,
    },
  };
  const session = {
    send: vi.fn(
      async (
        _method: string,
        parameters: Record<string, unknown>
      ): Promise<unknown> => {
        await Promise.resolve();
        const request = parametersSchema.parse(parameters);
        const callback = callbackSchema.parse(
          new Script(`(${request.functionDeclaration})`).runInNewContext(
            globals
          )
        );
        try {
          const value = callback(module, request.arguments[1].value);
          const json = JSON.stringify(value);
          return {
            result: {
              type: typeof value,
              value: json === undefined ? undefined : JSON.parse(json),
            },
          };
        } catch (error) {
          return {
            exceptionDetails: {
              text: "Uncaught",
              exception: {
                description:
                  error instanceof Error ? error.message : String(error),
              },
            },
          };
        }
      }
    ),
  };
  const implementation = {
    _nodeSession: session,
    _nodeConnection: { rootSession: session },
    _nodeElectronHandlePromise: Promise.resolve({
      _objectId: "existing-electron-module",
      _context: { delegate: { _client: session } },
    }),
  };
  const toImpl = vi.fn(() => implementation);
  const app = {
    _connection: { toImpl },
    evaluate: vi.fn<ElectronApplication["evaluate"]>(),
  };
  return {
    app,
    implementation,
    session,
    encryptString,
    toImpl,
    module,
    globals,
    initialOpenExternal,
  };
}

const payload = {
  serializedSession: "canonical-session",
  privateKeyPkcs8Pem: "canonical-private-key",
};

function encrypt(
  {
    safeStorage,
  }: Parameters<Parameters<typeof evaluateElectronSynchronously>[1]>[0],
  seed: typeof payload
) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Electron safeStorage is unavailable for auth E2E.");
  }
  return {
    session: safeStorage
      .encryptString(seed.serializedSession)
      .toString("base64"),
    signingKey: safeStorage
      .encryptString(seed.privateKeyPkcs8Pem)
      .toString("base64"),
  };
}

describe("synchronous Electron fixture evaluation", () => {
  it("executes the production spy installer once and preserves ordered async OS handoff recording", async () => {
    const owner = fixture();
    await installOpenExternalSpy(owner.app as unknown as ElectronApplication);
    expect(owner.session.send).toHaveBeenCalledOnce();
    expect(owner.session.send.mock.calls[0][1]).toMatchObject({
      awaitPromise: false,
      returnByValue: true,
    });
    expect(owner.app.evaluate).not.toHaveBeenCalled();
    const first = owner.module.shell.openExternal("https://first.example.test");
    const second = owner.module.shell.openExternal(
      "https://second.example.test"
    );
    expect(typeof first.then).toBe("function");
    expect(typeof second.then).toBe("function");
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(owner.globals.__openedExternalUrls).toEqual([
      "https://first.example.test",
      "https://second.example.test",
    ]);
    expect(owner.initialOpenExternal).not.toHaveBeenCalled();
  });

  it("propagates a spy callback exception without reinstalling or retrying", async () => {
    const owner = fixture();
    const setter = vi.fn(() => {
      throw new Error("OS spy assignment failed");
    });
    Object.defineProperty(owner.module.shell, "openExternal", {
      get: () => owner.initialOpenExternal,
      set: setter,
    });
    await expect(
      installOpenExternalSpy(owner.app as unknown as ElectronApplication)
    ).rejects.toThrow("OS spy assignment failed");
    expect(setter).toHaveBeenCalledOnce();
    expect(owner.session.send).toHaveBeenCalledOnce();
    expect(owner.globals.__openedExternalUrls).toEqual([]);
    expect(owner.initialOpenExternal).not.toHaveBeenCalled();
    expect(owner.app.evaluate).not.toHaveBeenCalled();
  });

  it("preserves a synchronous undefined result without awaiting a promise", async () => {
    const owner = fixture();
    await expect(
      evaluateElectronSynchronously(
        owner.app,
        () => undefined,
        undefined,
        z.undefined()
      )
    ).resolves.toBeUndefined();
    expect(owner.session.send).toHaveBeenCalledOnce();
    expect(owner.session.send.mock.calls[0][1]).toMatchObject({
      awaitPromise: false,
    });
  });

  it.each([
    { expected: true, argv: [E2E_NO_REVEAL_ARG] },
    { expected: false, argv: [] },
  ])(
    "preserves the reveal check Boolean $expected with one synchronous call",
    async ({ expected, argv }) => {
      const owner = fixture(true, argv);
      const result = await evaluateElectronSynchronously(
        owner.app,
        () => process.argv.includes("--e2e-no-reveal"),
        undefined,
        z.boolean()
      );
      expect(result).toBe(expected);
      expect(owner.session.send).toHaveBeenCalledOnce();
      expect(owner.session.send.mock.calls[0][1]).toMatchObject({
        awaitPromise: false,
        returnByValue: true,
        arguments: [{ objectId: "existing-electron-module" }, {}],
      });
    }
  );

  it("refuses an unsupported Playwright version before inspecting the app", async () => {
    const owner = fixture();
    packageMetadata.version = "1.61.0";
    await expect(
      evaluateElectronSynchronously(owner.app, encrypt, payload, resultSchema)
    ).rejects.toThrow();
    expect(owner.toImpl).not.toHaveBeenCalled();
    expect(owner.session.send).not.toHaveBeenCalled();
  });

  it("preserves protocol exception text when no description is available", async () => {
    const owner = fixture();
    owner.session.send.mockResolvedValueOnce({
      exceptionDetails: { text: "native exception text" },
    });
    await expect(
      evaluateElectronSynchronously(owner.app, encrypt, payload, resultSchema)
    ).rejects.toThrow("native exception text");
    expect(owner.session.send).toHaveBeenCalledOnce();
  });

  it("rejects a nonserializable result without another call", async () => {
    const owner = fixture();
    await expect(
      evaluateElectronSynchronously(
        owner.app,
        () => {
          const result: { self?: unknown } = {};
          result.self = result;
          return result;
        },
        payload,
        resultSchema
      )
    ).rejects.toThrow("circular");
    expect(owner.session.send).toHaveBeenCalledOnce();
  });

  it("encrypts both canonical payload fields once through the existing root handle", async () => {
    const owner = fixture();
    const result = await evaluateElectronSynchronously(
      owner.app,
      encrypt,
      payload,
      resultSchema
    );
    expect(owner.toImpl).toHaveBeenCalledExactlyOnceWith(owner.app);
    expect(owner.session.send).toHaveBeenCalledOnce();
    const [method, request] = owner.session.send.mock.calls[0];
    expect(method).toBe("Runtime.callFunctionOn");
    expect(request).toMatchObject({
      objectId: "existing-electron-module",
      arguments: [{ objectId: "existing-electron-module" }, { value: payload }],
      returnByValue: true,
      awaitPromise: false,
    });
    expect(owner.encryptString.mock.calls).toEqual([
      [payload.serializedSession],
      [payload.privateKeyPkcs8Pem],
    ]);
    expect(result).toEqual({
      session: Buffer.from(`encrypted:${payload.serializedSession}`).toString(
        "base64"
      ),
      signingKey: Buffer.from(
        `encrypted:${payload.privateKeyPkcs8Pem}`
      ).toString("base64"),
    });
  });

  it("preserves the safeStorage availability failure before encryption", async () => {
    const owner = fixture(false);
    await expect(
      evaluateElectronSynchronously(owner.app, encrypt, payload, resultSchema)
    ).rejects.toThrow("Electron safeStorage is unavailable for auth E2E.");
    expect(owner.encryptString).not.toHaveBeenCalled();
    expect(owner.session.send).toHaveBeenCalledOnce();
  });

  it("refuses an async callback before any protocol request", async () => {
    const owner = fixture();
    await expect(
      evaluateElectronSynchronously(
        owner.app,
        async () => "value",
        payload,
        z.string()
      )
    ).rejects.toThrow("refuses async callbacks");
    expect(owner.session.send).not.toHaveBeenCalled();
  });

  it("refuses a synchronous callback returning a promise", async () => {
    const owner = fixture();
    await expect(
      evaluateElectronSynchronously(
        owner.app,
        () => Promise.resolve("value"),
        payload,
        z.string()
      )
    ).rejects.toThrow("refuses promise results");
    expect(owner.session.send).toHaveBeenCalledOnce();
  });

  it("rejects a module handle from another session before calling it", async () => {
    const owner = fixture();
    owner.implementation._nodeElectronHandlePromise = Promise.resolve({
      _objectId: "other-module",
      _context: { delegate: { _client: fixture().session } },
    });
    await expect(
      evaluateElectronSynchronously(owner.app, encrypt, payload, resultSchema)
    ).rejects.toThrow("different session");
    expect(owner.session.send).not.toHaveBeenCalled();
  });

  it("rejects another root session without issuing a request", async () => {
    const owner = fixture();
    owner.implementation._nodeConnection.rootSession = fixture().session;
    await expect(
      evaluateElectronSynchronously(owner.app, encrypt, payload, resultSchema)
    ).rejects.toThrow("existing Node root session");
    expect(owner.session.send).not.toHaveBeenCalled();
  });

  it("rejects a malformed encrypted result", async () => {
    const owner = fixture();
    await expect(
      evaluateElectronSynchronously(
        owner.app,
        () => ({ session: "only-one-key" }),
        payload,
        resultSchema
      )
    ).rejects.toThrow();
    expect(owner.session.send).toHaveBeenCalledOnce();
  });

  it("propagates a protocol error without another request", async () => {
    const owner = fixture();
    owner.session.send.mockRejectedValueOnce(
      new Error("native inspector failure")
    );
    await expect(
      evaluateElectronSynchronously(owner.app, encrypt, payload, resultSchema)
    ).rejects.toThrow("native inspector failure");
    expect(owner.session.send).toHaveBeenCalledOnce();
  });
});
