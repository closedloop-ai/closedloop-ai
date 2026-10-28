/**
 * ISS-11929: which requests the browser's PostHog session headers ride on.
 *
 * Driven through the posthog-js copy `@posthog/next` initializes in production
 * (this package's `vitest.config.ts` aliases `posthog-js` to it), initialized
 * with the `clientOptions` the real `AnalyticsProvider` renders, plus the
 * `tracing-headers.js` script that copy lazy-loads from PostHog's asset host.
 * So a renamed option the shipped copy ignores, or a host list wider than the
 * cl-api host, turns these red.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInThisContext } from "node:vm";
import { render } from "@testing-library/react";
import posthog, { type PostHog } from "posthog-js";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { IN_PROCESS_POSTHOG_OPTIONS } from "./posthog-test-harness";
import { POSTHOG_TRACING_HEADERS } from "./posthog-tracing-headers";

const API_ORIGIN = "https://api.example.test";
const OTHER_ORIGIN = "https://uploads.example.test";
const POSTHOG_HEADER_PREFIX = "x-posthog-";

const { mockPostHogProvider } = vi.hoisted(() => ({
  mockPostHogProvider: vi.fn(
    ({
      children,
    }: {
      children: React.ReactNode;
      clientOptions?: Record<string, unknown>;
    }) => children
  ),
}));

vi.mock("@next/third-parties/google", () => ({ GoogleAnalytics: () => null }));
vi.mock("@vercel/analytics/react", () => ({ Analytics: () => null }));
vi.mock("@posthog/next", () => ({
  usePostHog: () => null,
  PostHogProvider: mockPostHogProvider,
}));
vi.mock("./keys", () => ({
  isValidGaMeasurementId: () => false,
  keys: () => ({ NEXT_PUBLIC_POSTHOG_KEY: "phc_test" }),
}));

let instanceCounter = 0;
let sent: Request[] = [];

beforeAll(async () => {
  // The script posthog-js fetches from `/static/tracing-headers.js` at runtime,
  // as published with the version production initializes. Evaluated as the
  // browser would a classic script: it is not a module, it installs its patch
  // on `window`.
  const fromPostHogNext = createRequire(
    createRequire(import.meta.url).resolve("@posthog/next")
  );
  runInThisContext(
    readFileSync(
      fromPostHogNext.resolve("posthog-js/dist/tracing-headers.js"),
      "utf8"
    )
  );
  await import("./provider");
});

beforeEach(() => {
  vi.clearAllMocks();
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(new Request(input, init));
      return Promise.resolve(new Response("{}", { status: 200 }));
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PostHog session headers on browser requests", () => {
  it("sends the browser's session id to the cl-api host", async () => {
    const client = await initPostHogAsTheProviderConfiguresIt(API_ORIGIN);

    const request = await sendFrom(`${API_ORIGIN}/me`);

    expect(request.headers.get(POSTHOG_TRACING_HEADERS.SessionId)).toBe(
      client.get_session_id()
    );
    // apps/api's CORS allowlist is built from this constant; a header the
    // shipped posthog-js sends beyond it would fail every preflight.
    expect(postHogHeaderNames(request)).toEqual(
      Object.values(POSTHOG_TRACING_HEADERS)
        .map((name) => name.toLowerCase())
        .sort()
    );
  });

  it("sends no PostHog header to any other host", async () => {
    await initPostHogAsTheProviderConfiguresIt(API_ORIGIN);

    const request = await sendFrom(`${OTHER_ORIGIN}/upload`);

    expect(request.url).toBe(`${OTHER_ORIGIN}/upload`);
    expect(postHogHeaderNames(request)).toEqual([]);
  });

  it("sends no PostHog header when the surface names no API origin", async () => {
    await initPostHogAsTheProviderConfiguresIt(undefined);

    const request = await sendFrom(`${API_ORIGIN}/me`);

    expect(request.url).toBe(`${API_ORIGIN}/me`);
    expect(postHogHeaderNames(request)).toEqual([]);
  });
});

async function initPostHogAsTheProviderConfiguresIt(
  apiOrigin: string | undefined
): Promise<PostHog> {
  const { AnalyticsProvider } = await import("./provider");
  render(
    <AnalyticsProvider apiOrigin={apiOrigin}>
      <div>Application</div>
    </AnalyticsProvider>
  );

  const clientOptions =
    mockPostHogProvider.mock.calls.at(-1)?.[0]?.clientOptions;
  if (!clientOptions) {
    throw new Error("AnalyticsProvider rendered no clientOptions");
  }

  instanceCounter += 1;
  const client = posthog.init(
    "phc_test",
    { ...clientOptions, ...IN_PROCESS_POSTHOG_OPTIONS },
    `iss11929-${instanceCounter}`
  );
  if (!client) {
    throw new Error("posthog-js did not initialize");
  }
  return client;
}

async function sendFrom(url: string): Promise<Request> {
  await window.fetch(url);
  const request = sent.find((candidate) => candidate.url === url);
  if (!request) {
    throw new Error(`no request reached the network for ${url}`);
  }
  return request;
}

function postHogHeaderNames(request: Request): string[] {
  return [...request.headers.keys()]
    .filter((name) => name.startsWith(POSTHOG_HEADER_PREFIX))
    .sort();
}
