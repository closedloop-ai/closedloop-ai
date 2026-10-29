import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { PostHog } from "posthog-js";

/**
 * Shared harness for the two suites that drive a REAL posthog-js: the ISS-8295
 * default-property cases and the ISS-8305/8306/8307 redaction cases.
 *
 * Not `*.test.ts`, so vitest's include glob leaves it uncollected. It exists
 * because both suites need the same three things — the version the provider
 * really initializes, a transport that keeps events in-process, and a capture
 * of the WHOLE emitted payload — and a second copy of the capture helper had
 * already drifted: one recorded `$set_once` and the other did not, which
 * silently narrowed a whole-payload leak assertion that named a `$set_once`
 * property as its reason for existing.
 */

/**
 * Transport plumbing only — a memory store, no batching, no remote config, no
 * automatic capture. Nothing here touches property construction, which is the
 * thing both suites are actually asserting on.
 */
export const IN_PROCESS_POSTHOG_OPTIONS = {
  persistence: "memory",
  request_batching: false,
  disable_compression: true,
  disable_surveys: true,
  disable_external_dependency_loading: true,
  advanced_disable_flags: true,
  advanced_disable_decide: true,
  autocapture: false,
  capture_pageview: false,
  capture_pageleave: false,
  capture_performance: false,
  loaded: undefined,
} as const;

export type CapturedEvent = {
  event: string;
  properties: Record<string, unknown>;
  set?: Record<string, unknown>;
  setOnce?: Record<string, unknown>;
};

/**
 * The `posthog-js` version `@posthog/next` resolves — the copy production
 * initializes, which is not the one a bare `posthog-js` specifier finds here.
 */
export function shippedPostHogVersion(): string {
  const fromHere = createRequire(import.meta.url);
  const fromPostHogNext = createRequire(fromHere.resolve("@posthog/next"));
  let dir = path.dirname(fromPostHogNext.resolve("posthog-js"));
  while (dir !== path.dirname(dir)) {
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest)) {
      const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as {
        name?: string;
        version?: string;
      };
      if (parsed.name === "posthog-js" && parsed.version) {
        return parsed.version;
      }
    }
    dir = path.dirname(dir);
  }
  throw new Error(
    "could not locate the posthog-js manifest @posthog/next uses"
  );
}

export function navigateTo(pathWithQuery: string): void {
  window.history.replaceState({}, "", pathWithQuery);
}

/**
 * Capture one event and return the WHOLE payload posthog-js handed its
 * transport, `$set` and `$set_once` included — those carry `$initial_current_url`,
 * so a helper that dropped them would quietly narrow every leak assertion built
 * on top of it.
 */
export function captureEvent(
  client: PostHog,
  eventName: string,
  properties: Record<string, unknown>
): CapturedEvent {
  const captured: CapturedEvent[] = [];
  const unsubscribe = client._addCaptureHook((event, payload) => {
    if (payload) {
      captured.push({
        event,
        properties: payload.properties,
        set: payload.$set,
        setOnce: payload.$set_once,
      });
    }
  });
  client.capture(eventName, properties);
  unsubscribe();

  const event = captured.find((entry) => entry.event === eventName);
  if (!event) {
    throw new Error(`posthog-js captured no ${eventName} event`);
  }
  return event;
}

/** The autocapture shape: no `$current_url` of ours, so the one on the payload is posthog-js's own. */
export function captureAutocaptureClick(client: PostHog): CapturedEvent {
  return captureEvent(client, "$autocapture", { $event_type: "click" });
}

export function readCurrentUrl(payload: CapturedEvent): string {
  const currentUrl = payload.properties.$current_url;
  if (typeof currentUrl !== "string") {
    throw new Error("posthog-js attached no $current_url");
  }
  return currentUrl;
}
