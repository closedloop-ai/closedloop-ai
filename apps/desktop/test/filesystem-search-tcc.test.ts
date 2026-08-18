/**
 * FEA-3641: the gateway file search must never descend into TCC-protected user
 * folders. Even though the sandbox base can no longer be home (risky-dir
 * guard), a search rooted near home must not glob into Music/Pictures/… and
 * trigger a macOS permission prompt.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, test } from "node:test";
import type {
  OperationHandler,
  OperationRequestContext,
} from "../src/server/operation-dispatcher.js";
import { registerFilesystemSearchRoutes } from "../src/server/operations/filesystem-search.js";

const capturedRoutes: {
  method: string;
  path: string;
  handler: OperationHandler;
}[] = [];

const fakeDispatcher = {
  register(method: string, routePath: string, handler: OperationHandler) {
    capturedRoutes.push({ method, path: routePath, handler });
  },
};

function buildContext(
  query: Record<string, string>
): OperationRequestContext & {
  _responseStatus: number;
  _responseBody: string;
} {
  const req = new PassThrough() as unknown as http.IncomingMessage;
  const res = new PassThrough() as unknown as http.ServerResponse;
  let responseStatus = 0;
  let responseBody = "";
  Object.defineProperty(res, "statusCode", {
    get: () => responseStatus,
    set: (v: number) => {
      responseStatus = v;
    },
  });
  (res as unknown as { setHeader: (k: string, v: string) => void }).setHeader =
    () => {};
  (res as unknown as { end: (data?: string) => void }).end = (
    data?: string
  ) => {
    responseBody = data ?? "";
  };

  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    q.set(k, v);
  }

  return {
    method: "GET",
    pathname: "/api/gateway/files/search",
    params: {},
    query: q,
    rawBody: Buffer.from(""),
    body: "",
    request: req,
    response: res,
    get _responseStatus() {
      return responseStatus;
    },
    get _responseBody() {
      return responseBody;
    },
  } as OperationRequestContext & {
    _responseStatus: number;
    _responseBody: string;
  };
}

let sandbox: string;

beforeEach(() => {
  capturedRoutes.length = 0;
});

afterEach(async () => {
  if (sandbox) {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test("search preserves nested folders that merely share a protected name", async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "tcc-search-"));
  // A normal source file that SHOULD be found.
  await fs.mkdir(path.join(sandbox, "src"), { recursive: true });
  await fs.writeFile(path.join(sandbox, "src", "target.ts"), "// hi");
  // A nested project folder named Music is not the user's ~/Music directory and
  // must remain searchable.
  await fs.mkdir(path.join(sandbox, "Music"), { recursive: true });
  await fs.writeFile(path.join(sandbox, "Music", "target.ts"), "// nope");

  registerFilesystemSearchRoutes(fakeDispatcher as never, () => [sandbox]);
  const route = capturedRoutes.find((r) => r.method === "GET");
  assert.ok(route);

  const ctx = buildContext({ repo: sandbox, base: "true", query: "target" });
  await route.handler(ctx);

  assert.equal(ctx._responseStatus, 200);
  const parsed = JSON.parse(ctx._responseBody) as { files: string[] };
  assert.ok(
    parsed.files.some((f) => f.includes(path.join("src", "target.ts"))),
    "normal source file should be found"
  );
  assert.ok(
    parsed.files.some((f) => f.includes(path.join("Music", "target.ts"))),
    "nested Music/ project folder should remain searchable"
  );
});

// Security regression: on the case-insensitive macOS filesystem this targets,
// a differently-cased protected folder (`~/MUSIC`) is the same folder as
// `~/Music`. A case-sensitive exclusion `===` would let a search rooted at home
// descend into `~/MUSIC` and trigger the macOS TCC permission prompt. The
// exclusion must fold case.
test("search rooted at home excludes a differently-cased TCC-protected folder", async () => {
  const originalHomedir = os.homedir;
  // Treat the sandbox as the user's home directory so the search root == home
  // and the protected-subdir exclusion branch is exercised.
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "tcc-home-search-"));
  (os as { homedir: typeof os.homedir }).homedir = () => sandbox;
  try {
    // A normal source file at home root that SHOULD be found.
    await fs.mkdir(path.join(sandbox, "src"), { recursive: true });
    await fs.writeFile(path.join(sandbox, "src", "target.ts"), "// hi");
    // An UPPERCASE-cased protected folder (~/MUSIC) — same folder as ~/Music on
    // a case-insensitive FS. Its contents must be excluded from the search.
    await fs.mkdir(path.join(sandbox, "MUSIC"), { recursive: true });
    await fs.writeFile(path.join(sandbox, "MUSIC", "target.ts"), "// nope");

    registerFilesystemSearchRoutes(fakeDispatcher as never, () => [sandbox]);
    const route = capturedRoutes.find((r) => r.method === "GET");
    assert.ok(route);

    const ctx = buildContext({ repo: sandbox, base: "true", query: "target" });
    await route.handler(ctx);

    assert.equal(ctx._responseStatus, 200);
    const parsed = JSON.parse(ctx._responseBody) as { files: string[] };
    assert.ok(
      parsed.files.some((f) => f.includes(path.join("src", "target.ts"))),
      "normal source file at home root should be found"
    );
    assert.ok(
      !parsed.files.some((f) => f.includes(path.join("MUSIC", "target.ts"))),
      "differently-cased ~/MUSIC protected folder must be excluded"
    );
  } finally {
    (os as { homedir: typeof os.homedir }).homedir = originalHomedir;
  }
});
