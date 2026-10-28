import { createRequire } from "node:module";
import type * as Electron from "electron";
import { z } from "zod";

type InspectorSession = {
  send: (
    method: string,
    parameters: Record<string, unknown>
  ) => Promise<unknown>;
};
type InspectorConnection = { toImpl: (app: unknown) => unknown };
const sendSchema = z.custom<InspectorSession["send"]>(
  (value) => typeof value === "function"
);
const sessionShape = z.object({ send: sendSchema });
const sessionSchema = z.custom<InspectorSession>(
  (value) => sessionShape.safeParse(value).success
);
const connectionShape = z.object({
  toImpl: z.custom<InspectorConnection["toImpl"]>(
    (value) => typeof value === "function"
  ),
});
const applicationSchema = z.object({
  _connection: z.custom<InspectorConnection>(
    (value) => connectionShape.safeParse(value).success
  ),
});
const implementationSchema = z.object({
  _nodeSession: sessionSchema,
  _nodeConnection: z.object({ rootSession: z.unknown() }),
  _nodeElectronHandlePromise: z.custom<PromiseLike<unknown>>(
    (value) => value instanceof Promise
  ),
});
const handleSchema = z.object({
  _objectId: z.string().min(1),
  _context: z.object({ delegate: z.object({ _client: z.unknown() }) }),
});
const responseSchema = z.object({
  result: z
    .object({ type: z.string(), value: z.unknown().optional() })
    .optional(),
  exceptionDetails: z
    .object({
      text: z.string(),
      exception: z.object({ description: z.string().optional() }).optional(),
    })
    .optional(),
});
const require = createRequire(import.meta.url);
const playwrightPackageSchema = z.object({ version: z.literal("1.60.0") });
const asyncFunctionPrefix = /^\s*async(?:\s|\()/;

/**
 * Run a synchronous fixture callback once on Playwright's existing Node session.
 * Pinned Playwright 1.60 always awaits inspector results, whose temporary promise
 * can be collected even when this callback returns synchronously. No new handle
 * is created; the ElectronModule handle remains owned by Playwright.
 */
export async function evaluateElectronSynchronously<Payload, Result>(
  app: unknown,
  callback: (electronModule: typeof Electron, payload: Payload) => unknown,
  payload: Payload,
  resultSchema: z.ZodType<Result>
): Promise<Result> {
  playwrightPackageSchema.parse(require("@playwright/test/package.json"));
  const source = Function.prototype.toString.call(callback);
  if (asyncFunctionPrefix.test(source)) {
    throw new Error("Synchronous Electron fixture refuses async callbacks.");
  }
  const connection = applicationSchema.parse(app)._connection;
  const implementation = implementationSchema.parse(connection.toImpl(app));
  const session = implementation._nodeSession;
  if (implementation._nodeConnection.rootSession !== session) {
    throw new Error(
      "Electron fixture requires the existing Node root session."
    );
  }
  const handle = handleSchema.parse(
    await implementation._nodeElectronHandlePromise
  );
  if (handle._context.delegate._client !== session) {
    throw new Error("ElectronModule handle belongs to a different session.");
  }
  const response = responseSchema.parse(
    await session.send("Runtime.callFunctionOn", {
      functionDeclaration: `function (electronModule, payload) {
        const result = (${source})(electronModule, payload);
        if (result !== null && (typeof result === "object" || typeof result === "function") && typeof result.then === "function") {
          throw new Error("Synchronous Electron fixture refuses promise results.");
        }
        return result;
      }`,
      objectId: handle._objectId,
      arguments: [{ objectId: handle._objectId }, { value: payload }],
      returnByValue: true,
      awaitPromise: false,
    })
  );
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text
    );
  }
  if (!response.result) {
    throw new Error(
      "Synchronous Electron fixture returned no protocol result."
    );
  }
  return resultSchema.parse(response.result.value);
}
