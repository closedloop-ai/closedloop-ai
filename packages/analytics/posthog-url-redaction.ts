import type { usePostHog } from "@posthog/next";
import { z } from "zod";
import { redactAnalyticsUrl } from "./redact-analytics-url";
import { ANALYTICS_REDACTION_MARKER } from "./sensitive-query-params";

// Typed off the hook that hands the client out, for the same reason `./provider`
// types its options off the provider prop: two posthog-js versions coexist in
// the store, and naming one here would compile against a client never run.
type AnalyticsClient = NonNullable<ReturnType<typeof usePostHog>>;
type ClientConfig = AnalyticsClient["config"];
type BeforeSendConfig = NonNullable<ClientConfig["before_send"]>;
/** The single-function member of the `fn | fn[]` the option accepts. */
type BeforeSend = Extract<BeforeSendConfig, (event: never) => unknown>;
type CapturedEvent = NonNullable<ReturnType<BeforeSend>>;
type NetworkMasker = NonNullable<
  ClientConfig["session_recording"]["maskCapturedNetworkRequestFn"]
>;
type CapturedRequest = Parameters<NetworkMasker>[0];

/**
 * Bounds DESCENT only — a string is redacted at whatever depth it is found, so
 * the ceiling can never leave a url unscanned. Past it a subtree is replaced by
 * the marker rather than passed through, so "too deep to walk" is distinguish-
 * able from "walked and clean". posthog-js's own deepest shape is
 * `$exception_list[].stacktrace.frames[].filename` at six.
 */
const MAX_REDACTION_DEPTH = 12;

/**
 * The rrweb payload on a `$snapshot`, megabytes per capture and owned by the
 * SEPARATE masker below. Only this subtree is skipped: the rest of a `$snapshot`
 * envelope is swept like any other event's, because `_calculate_set_once_properties`
 * runs for `$snapshot` too (1.359.1 `posthog-core.ts:941`) and can attach the
 * persistence-derived `$initial_current_url` / `$initial_referrer` to it.
 */
const REPLAY_PAYLOAD_KEY = "$snapshot_data";

/**
 * posthog-js's own persistence keys. A release that renamed one makes
 * {@link remaskPersistedUrls} degrade to a no-op — never a throw and never a
 * leak, because {@link redactCapturedEvent} redacts the same values again on
 * their way out of every capture.
 */
const PERSISTED_PERSON_INFO_KEY = "$initial_person_info";
const PERSISTED_SESSION_PROPS_KEY = "$client_session_props";

/**
 * posthog-js's `{ r: referrer, u: url }` (`utils/event-utils.ts:204-214`), loose
 * so a future sibling field is carried over. `r` is optional because a record
 * written without one must still have its `u` swept.
 */
const persistedPersonInfoSchema = z.looseObject({
  u: z.string(),
  r: z.string().optional(),
});
type PersistedPersonInfo = z.infer<typeof persistedPersonInfoSchema>;
const persistedSessionPropsSchema = z.looseObject({
  props: persistedPersonInfoSchema,
});

/**
 * The client {@link redactCapturedEvent} re-sweeps persistence for, and the
 * session it last swept. `before_send` is handed only the event, and posthog-js
 * is a module singleton, so the reference is held here rather than closed over
 * — a closure would give every install a fresh function identity and defeat the
 * idempotency check.
 */
let redactionTarget: AnalyticsClient | undefined;
let lastSweptSessionId: string | undefined;

/**
 * Install the redaction `./provider`'s option object cannot express, because
 * these are FUNCTIONS and it crosses a Server-to-Client boundary (ISS-8295).
 *
 * `before_send` covers the event path, including values posthog-js restored
 * from persistence (ISS-8306) and the encoded key spellings its own masker
 * compares raw (ISS-8307). `maskCapturedNetworkRequestFn` is a SEPARATE sink
 * with a SEPARATE masker — replay's rrweb `Meta` href runs through it alone, so
 * adding a name to `custom_personal_data_properties` cannot reach it (ISS-8305).
 *
 * Idempotent: the chain is only extended when this module's own function is not
 * already in it.
 */
export function installAnalyticsUrlRedaction(client: AnalyticsClient): void {
  redactionTarget = client;
  remaskPersistedUrls(client);

  const existing = client.config.before_send;
  const chain = existing ? asArray(existing) : [];
  if (chain.includes(redactCapturedEvent)) {
    return;
  }

  client.set_config({
    before_send: [...chain, redactCapturedEvent],
    // `set_config` merges shallowly, so the options `./provider` already set
    // (`maskAllInputs`) have to be carried across by hand or they are dropped.
    session_recording: {
      ...client.config.session_recording,
      maskCapturedNetworkRequestFn: maskCapturedNetworkRequest,
    },
  });
}

function asArray(value: BeforeSendConfig): BeforeSend[] {
  return Array.isArray(value) ? value : [value];
}

function redactCapturedEvent(
  event: CapturedEvent | null
): CapturedEvent | null {
  if (!event) {
    return event;
  }
  sweepPersistenceOnSessionRoll(event);

  const redacted: CapturedEvent = {
    ...event,
    properties: redactEventProperties(event.properties),
  };
  // Redacted only where present, so an absent optional stays ABSENT: an event
  // that carried no `$set_once` must not acquire an empty one.
  if (event.$set) {
    redacted.$set = redactProperties(event.$set, 0);
  }
  if (event.$set_once) {
    redacted.$set_once = redactProperties(event.$set_once, 0);
  }
  return redacted;
}

function maskCapturedNetworkRequest(request: CapturedRequest): CapturedRequest {
  return {
    ...request,
    name:
      typeof request.name === "string"
        ? redactAnalyticsUrl(request.name)
        : request.name,
    // Setting this hook REPLACES posthog-js's own `scrubPayloads` step rather
    // than running alongside it (1.359.1 `replay/external/config.ts:253-260`),
    // so bodies it would have scrubbed for passwords would arrive raw. Dropping
    // them keeps this a strict tightening; `recordBody` is off by default.
    requestBody: null,
    responseBody: null,
  };
}

/**
 * Rewrite every url-shaped string in a payload, as a VALUE or as an object KEY
 * (`$heatmap_data` buckets clicks under the url). Deliberately not an
 * enumerated property list: the recurring failure is a NEW posthog-js property
 * inheriting the default url that nobody remembers to add.
 */
function redactProperties(
  properties: Record<string, unknown>,
  depth: number
): Record<string, unknown> {
  const entries = new Map<string, unknown>();
  for (const [key, value] of Object.entries(properties)) {
    const redactedKey = redactIfUrlLike(key);
    const redactedValue = redactUnknown(value, depth + 1);
    const existing = entries.get(redactedKey);
    // Two urls can redact to the same key. Their buckets are concatenated
    // rather than clobbered so no click record is silently dropped.
    entries.set(
      redactedKey,
      Array.isArray(existing) && Array.isArray(redactedValue)
        ? [...existing, ...redactedValue]
        : redactedValue
    );
  }
  // `fromEntries` rather than assignment into a literal: a payload key spelled
  // `__proto__` is a data property here instead of a prototype write.
  return Object.fromEntries(entries);
}

function redactUnknown(value: unknown, depth: number): unknown {
  // Before the ceiling, deliberately: a string cannot recurse, so redacting it
  // is always safe and the bound never becomes a way for a url to pass unread.
  if (typeof value === "string") {
    return redactIfUrlLike(value);
  }
  if (depth > MAX_REDACTION_DEPTH) {
    return ANALYTICS_REDACTION_MARKER;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactUnknown(entry, depth + 1));
  }
  if (isPlainObject(value)) {
    return redactProperties(value, depth);
  }
  return value;
}

/** The cheap reject: a string with no query string cannot carry a param. */
function redactIfUrlLike(value: string): string {
  return value.includes("?") ? redactAnalyticsUrl(value) : value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

/**
 * Rewrite the url values posthog-js keeps in its own store. Both records are
 * written ONCE and re-read forever — `$initial_person_info` through
 * `register_once`, `$client_session_props` only when the session id rolls — so
 * a pre-ISS-8295 visit keeps feeding every capture (ISS-8306).
 *
 * `before_send` already stops those being SENT; this stops them being STORED.
 * Persistence is `localStorage+cookie`, so until rewritten the raw url rides
 * the `ph_*` cookie to our own origin. Rewriting in place rather than deleting
 * keeps host, pathname and referrer.
 *
 * It is also the ONLY guard on a third sink: `_callFlagsEndpoint` posts
 * `person_properties: { ...persistence.get_initial_props(), ... }` directly
 * (1.359.1 `posthog-featureflags.ts:514-516`), never through `before_send`.
 * An explicit `setPersonPropertiesForFlags` carrying a url would bypass both.
 */
function remaskPersistedUrls(client: AnalyticsClient): void {
  const persistence = client.persistence;
  if (!persistence) {
    return;
  }

  const updates: Record<string, unknown> = {};

  const personInfo = persistedPersonInfoSchema.safeParse(
    persistence.props[PERSISTED_PERSON_INFO_KEY]
  );
  if (personInfo.success) {
    const redacted = redactPersonInfo(personInfo.data);
    if (redacted) {
      updates[PERSISTED_PERSON_INFO_KEY] = redacted;
    }
  }

  const sessionProps = persistedSessionPropsSchema.safeParse(
    persistence.props[PERSISTED_SESSION_PROPS_KEY]
  );
  if (sessionProps.success) {
    const redacted = redactPersonInfo(sessionProps.data.props);
    if (redacted) {
      updates[PERSISTED_SESSION_PROPS_KEY] = {
        ...sessionProps.data,
        props: redacted,
      };
    }
  }

  if (Object.keys(updates).length > 0) {
    persistence.register(updates);
  }
}

/**
 * Re-sweep persistence when the session id changes.
 *
 * `posthog.reset()` — which `hooks/use-identify-user` calls on every sign-out —
 * CLEARS persistence in place without replacing the client object, so the
 * guard's effect never re-runs and the sweep at install time is spent. The next
 * capture then re-persists `$client_session_props` from the current href
 * through posthog-js's OWN masker, which compares raw keys, so an encoded
 * spelling would land in the cookie unmasked. Keyed on the session id because
 * that is the value whose roll marks the re-persist, and it rides every event.
 */
function sweepPersistenceOnSessionRoll(event: CapturedEvent): void {
  const sessionId = event.properties.$session_id;
  if (typeof sessionId !== "string" || sessionId === lastSweptSessionId) {
    return;
  }
  lastSweptSessionId = sessionId;
  if (redactionTarget) {
    remaskPersistedUrls(redactionTarget);
  }
}

/**
 * Sweep an event's properties, lifting {@link REPLAY_PAYLOAD_KEY} out of the
 * walk rather than the whole event out of the sweep. A `$snapshot` still carries
 * an envelope posthog-js built — `distinct_id`, the caller's `$session_id`, and
 * a `$set_once` that on the first capture of a page load is `get_initial_props()`
 * verbatim — and only the rrweb subtree is the one replay's own masker owns.
 */
function redactEventProperties(
  properties: Record<string, unknown>
): Record<string, unknown> {
  if (!(REPLAY_PAYLOAD_KEY in properties)) {
    return redactProperties(properties, 0);
  }
  const { [REPLAY_PAYLOAD_KEY]: replayPayload, ...rest } = properties;
  return { ...redactProperties(rest, 0), [REPLAY_PAYLOAD_KEY]: replayPayload };
}

/**
 * Redact BOTH url-bearing fields of a stored `{ r, u }` record, or return
 * `undefined` when neither carried anything sensitive so the store is left
 * byte-identical rather than rewritten with an identical value.
 *
 * posthog-js masks only `u` (`utils/event-utils.ts:212` runs `maskQueryParams`
 * on the href and takes `r` as written). `r` is `document.referrer`, which on
 * this flow IS the authorize url once the browser leaves it, and it becomes
 * `$initial_referrer` inside `get_initial_props()` — the payload
 * `_callFlagsEndpoint` posts directly, never through `before_send`.
 */
function redactPersonInfo(
  info: PersistedPersonInfo
): PersistedPersonInfo | undefined {
  const redacted: PersistedPersonInfo = {
    ...info,
    u: redactAnalyticsUrl(info.u),
  };
  if (typeof info.r === "string") {
    redacted.r = redactAnalyticsUrl(info.r);
  }
  if (redacted.u === info.u && redacted.r === info.r) {
    return;
  }
  return redacted;
}
