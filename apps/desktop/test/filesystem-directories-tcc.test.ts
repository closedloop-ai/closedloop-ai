/**
 * FEA-3641: the gateway directory browser must not stat/probe TCC-protected
 * user folders (Music, Pictures, Documents, …) when browsing a home-like
 * directory. Browsing home previously ran `existsSync(<home>/Music/.git)` for
 * every child, triggering one macOS permission prompt per protected folder
 * (the "why is it asking for my music files?" symptom).
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
import { registerFilesystemDirectoriesRoutes } from "../src/server/operations/filesystem-directories.js";
import { TCC_PROTECTED_HOME_SUBDIRS } from "../src/shared/sandbox-policy.js";

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

function buildContext(pathParam: string): OperationRequestContext & {
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

  const query = new URLSearchParams();
  query.set("path", pathParam);

  return {
    method: "GET",
    pathname: "/api/gateway/directories",
    params: {},
    query,
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

const originalHomedir = os.homedir;
let fakeHome: string;

beforeEach(async () => {
  capturedRoutes.length = 0;
  fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "tcc-browser-home-"));
  (os as { homedir: typeof os.homedir }).homedir = () => fakeHome;
});

afterEach(async () => {
  (os as { homedir: typeof os.homedir }).homedir = originalHomedir;
  await fs.rm(fakeHome, { recursive: true, force: true });
});

test("browsing home excludes TCC-protected folders and never marks them as repos", async () => {
  // Materialize protected folders WITH a `.git` inside — if the browser probed
  // them it would surface isGitRepo:true (and, on macOS, prompt for access).
  for (const name of TCC_PROTECTED_HOME_SUBDIRS) {
    await fs.mkdir(path.join(fakeHome, name, ".git"), { recursive: true });
  }
  // A legitimate, non-protected project folder that IS a repo.
  await fs.mkdir(path.join(fakeHome, "Source", ".git"), { recursive: true });

  registerFilesystemDirectoriesRoutes(fakeDispatcher as never, () => [
    fakeHome,
  ]);
  const route = capturedRoutes.find((r) => r.method === "GET");
  assert.ok(route, "directories route registered");

  const ctx = buildContext("~");
  await route.handler(ctx);

  assert.equal(ctx._responseStatus, 200);
  const parsed = JSON.parse(ctx._responseBody) as {
    directories: { name: string; isGitRepo: boolean }[];
  };
  const names = parsed.directories.map((d) => d.name);

  // No protected folder appears in the listing at all.
  for (const name of TCC_PROTECTED_HOME_SUBDIRS) {
    assert.equal(
      names.includes(name),
      false,
      `${name} must not be listed when browsing home`
    );
  }

  // The legitimate repo is still listed and correctly detected.
  const source = parsed.directories.find((d) => d.name === "Source");
  assert.ok(source, "non-protected repo still listed");
  assert.equal(source.isGitRepo, true);
});

test("a same-named folder NOT directly under home is still browsable", async () => {
  // Nested "Documents" inside a workspace is a normal project folder.
  const workspace = path.join(fakeHome, "Workspace");
  await fs.mkdir(path.join(workspace, "Documents"), { recursive: true });

  registerFilesystemDirectoriesRoutes(fakeDispatcher as never, () => [
    fakeHome,
  ]);
  const route = capturedRoutes.find((r) => r.method === "GET");
  assert.ok(route);

  const ctx = buildContext(workspace);
  await route.handler(ctx);

  assert.equal(ctx._responseStatus, 200);
  const parsed = JSON.parse(ctx._responseBody) as {
    directories: { name: string }[];
  };
  assert.ok(
    parsed.directories.some((d) => d.name === "Documents"),
    "nested Documents (not under home) must remain browsable"
  );
});
