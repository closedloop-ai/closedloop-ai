/**
 * @file docs-help-ipc.test.ts
 * @description Behavioral tests for the FEA-3843 / PRD-555 M1 docs-help IPC
 * handlers (`src/main/ipc/docs-help-ipc.ts`) and the service they wrap
 * (`src/main/docs-help/docs-bundle.ts`). Proves every handler rejects untrusted
 * senders (the security boundary), that the happy path returns
 * search/getPage/status results, and that the empty bundle reports unavailable —
 * invoking the real handler registrations, not source-text scans.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDocsHelpService,
  type DocsHelpService,
} from "../src/main/docs-help/docs-bundle.js";
import type { DocsBundle } from "../src/main/docs-help/docs-bundle-types.js";
import { registerDocsHelpIpcHandlers } from "../src/main/ipc/docs-help-ipc.js";
import { DocsHelpIpcChannel } from "../src/shared/docs-help-contract.js";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function fixtureBundle(): DocsBundle {
  return {
    sourceCommit: "deadbeef",
    generatedAt: new Date(0).toISOString(),
    docsSiteUrl: "https://closedloop.ai/docs",
    pages: [
      {
        path: "getting-started/api-keys",
        title: "API keys",
        description: "Create and manage your API keys.",
        group: "Getting Started",
        headings: [{ level: 2, text: "Scopes", slug: "scopes" }],
        body: "An API key authenticates requests.",
      },
    ],
  };
}

/** Collect the registered handlers into a channel→handler map. */
function registerHandlers(
  service: DocsHelpService,
  isTrustedSender: (sender: unknown) => boolean
): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  registerDocsHelpIpcHandlers(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    { isTrustedSender, docsHelp: service }
  );
  return handlers;
}

const TRUSTED_EVENT = { sender: { id: 1 } };
const UNTRUSTED_SENDER_RE = /untrusted sender/;

test("every docs-help handler rejects an untrusted sender", () => {
  const service = createDocsHelpService(fixtureBundle());
  const handlers = registerHandlers(service, () => false);
  for (const channel of Object.values(DocsHelpIpcChannel)) {
    const handler = handlers.get(channel);
    assert.ok(handler, `handler registered for ${channel}`);
    assert.throws(
      () => handler?.(TRUSTED_EVENT, {}),
      UNTRUSTED_SENDER_RE,
      `${channel} must reject untrusted senders`
    );
  }
});

test("search handler returns ranked hits for a trusted sender", () => {
  const service = createDocsHelpService(fixtureBundle());
  const handlers = registerHandlers(service, () => true);
  const result = handlers.get(DocsHelpIpcChannel.Search)?.(TRUSTED_EVENT, {
    query: "api key",
  }) as { query: string; hits: Array<{ path: string }> };
  assert.equal(result.query, "api key");
  assert.equal(result.hits[0]?.path, "getting-started/api-keys");
});

test("search handler tolerates a malformed payload", () => {
  const service = createDocsHelpService(fixtureBundle());
  const handlers = registerHandlers(service, () => true);
  const result = handlers.get(DocsHelpIpcChannel.Search)?.(
    TRUSTED_EVENT,
    undefined
  ) as { query: string; hits: unknown[] };
  assert.equal(result.query, "");
  assert.deepEqual(result.hits, []);
});

test("getPage handler returns a found page, or missing for an unknown path", () => {
  const service = createDocsHelpService(fixtureBundle());
  const handlers = registerHandlers(service, () => true);
  const getPage = handlers.get(DocsHelpIpcChannel.GetPage);
  const found = getPage?.(TRUSTED_EVENT, {
    path: "getting-started/api-keys",
  }) as { kind: string; page?: { title: string } };
  assert.equal(found.kind, "found");
  assert.equal(found.page?.title, "API keys");

  const missing = getPage?.(TRUSTED_EVENT, { path: "does/not/exist" }) as {
    kind: string;
  };
  assert.equal(missing.kind, "missing");
});

test("status handler reports availability, version stamp, and page count", () => {
  const service = createDocsHelpService(fixtureBundle());
  const handlers = registerHandlers(service, () => true);
  const status = handlers.get(DocsHelpIpcChannel.Status)?.(TRUSTED_EVENT) as {
    available: boolean;
    sourceCommit: string;
    pageCount: number;
    docsSiteUrl: string;
  };
  assert.equal(status.available, true);
  assert.equal(status.sourceCommit, "deadbeef");
  assert.equal(status.pageCount, 1);
  assert.equal(status.docsSiteUrl, "https://closedloop.ai/docs");
});

test("an empty bundle reports unavailable and finds no pages", () => {
  const empty: DocsBundle = {
    sourceCommit: "",
    generatedAt: new Date(0).toISOString(),
    docsSiteUrl: "https://closedloop.ai/docs",
    pages: [],
  };
  const service = createDocsHelpService(empty);
  const handlers = registerHandlers(service, () => true);
  const status = handlers.get(DocsHelpIpcChannel.Status)?.(TRUSTED_EVENT) as {
    available: boolean;
    pageCount: number;
  };
  assert.equal(status.available, false);
  assert.equal(status.pageCount, 0);
  const search = handlers.get(DocsHelpIpcChannel.Search)?.(TRUSTED_EVENT, {
    query: "anything",
  }) as { hits: unknown[] };
  assert.deepEqual(search.hits, []);
});
