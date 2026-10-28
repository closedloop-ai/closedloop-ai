/**
 * @file catalog-contents.test-harness.ts
 * @description Fixtures and the per-case reset the `catalog-contents` suites
 * share, on top of `catalog-contents.test-mocks.ts`.
 *
 * The REST transport is stubbed for every case. Fixture hits answer from
 * `githubResponses`; misses answer 404 and are logged in `restPaths`, so a case
 * can still assert which optional reads fell through without touching the real
 * network.
 */
import { vi } from "vitest";
import type { DesktopPrisma } from "../../src/main/database/prisma-client.js";
import type { CatalogEntry } from "../../src/main/packs/catalog-contents.js";
import {
  applyContentsFetchMock,
  gatewayLogWarnMock,
  httpsGetMock,
  telemetryEmitMock,
} from "./catalog-contents.test-mocks.js";

export type TreeEntry = {
  name: string;
  path: string;
  type: "file" | "dir";
  content?: string;
};

/** GitHub REST endpoint, without the leading slash, to the JSON it returns. */
export const githubResponses = new Map<string, unknown>();
/** Every GitHub REST endpoint requested, without the leading slash. */
export const githubEndpoints: string[] = [];
/** Every fixture miss, with the path shape passed to https.get. */
export const restPaths: string[] = [];

export const prisma = {} as unknown as DesktopPrisma;

export function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

export function entryFor(contents: Record<string, unknown>): CatalogEntry {
  return {
    packId: "acme-pack",
    githubUrl: "https://github.com/acme/widgets",
    contents,
  };
}

/** The `beforeEach` body: clear every fixture and re-arm the REST transport. */
export function resetCatalogContentsMocks(): void {
  githubResponses.clear();
  githubEndpoints.length = 0;
  restPaths.length = 0;

  httpsGetMock.mockReset();
  httpsGetMock.mockImplementation(
    (
      options: { path: string },
      onResponse: (res: ReturnType<typeof responseOf>) => void
    ) => {
      const endpoint = options.path.startsWith("/")
        ? options.path.slice(1)
        : options.path;
      githubEndpoints.push(endpoint);
      const req = {
        destroy: vi.fn(),
        on: () => req,
      };
      queueMicrotask(() => {
        if (!githubResponses.has(endpoint)) {
          restPaths.push(options.path);
          onResponse(responseOf(404, ""));
          return;
        }
        onResponse(
          responseOf(200, JSON.stringify(githubResponses.get(endpoint)))
        );
      });
      return req;
    }
  );

  applyContentsFetchMock.mockReset();
  applyContentsFetchMock.mockResolvedValue(undefined);
  gatewayLogWarnMock.mockReset();
  telemetryEmitMock.mockReset();
}

/** The `afterEach` body. */
export function restoreCatalogContentsMocks(): void {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
}

function responseOf(statusCode: number, body: string) {
  const handlers = new Map<string, (chunk?: string) => void>();
  const response = {
    statusCode,
    resume: vi.fn(),
    setEncoding: vi.fn(),
    on(event: string, handler: (chunk?: string) => void) {
      handlers.set(event, handler);
      if (event === "end") {
        queueMicrotask(() => {
          handlers.get("data")?.(body);
          handlers.get("end")?.();
        });
      }
      return response;
    },
  };
  return response;
}
