/**
 * The three url sinks `custom_personal_data_properties` cannot reach — ISS-8307
 * (raw key comparison, resolved 1.359.1 `utils/request-utils.ts:104`), ISS-8306
 * (values restored from persistence), ISS-8305 (replay's own masker,
 * `replay/external/lazy-loaded-session-recorder.ts:1000` → `:537`).
 *
 * The harness mirrors production ORDERING rather than approximating it: the
 * mocked `PostHogProvider` calls `posthog.init` during render, as
 * `ClientPostHogProvider` does, and hands that same instance to `usePostHog`.
 * That is what lets these cases observe "installed before the first capture"
 * instead of assuming it.
 *
 * Secrets never reach a matcher — a failing `not.toContain(secret)` prints it
 * into the reporter output — so every leak assertion compares a boolean.
 */
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
import {
  type CapturedEvent,
  captureAutocaptureClick,
  captureEvent,
  IN_PROCESS_POSTHOG_OPTIONS,
  navigateTo,
  readCurrentUrl,
  shippedPostHogVersion,
} from "./posthog-test-harness";

const MARKER = "[redacted]";
const AUTHORIZE_PATH = "/settings/integrations/desktop/authorize";
const ORDINARY_PATH = "/acme/sessions";

const ENCODED_STATE_SECRET = "encoded-csrf-9f3c";
const PLAIN_STATE_SECRET = "plain-csrf-7a2b";
/** The value a browser persisted BEFORE any masking existed. */
const PERSISTED_SECRET = "persisted-csrf-1d4e";
const PERSISTED_AUTHORIZE_URL = `https://app.example.com${AUTHORIZE_PATH}?state=${PERSISTED_SECRET}&platform=darwin`;
const REDACTED_AUTHORIZE_URL = `https://app.example.com${AUTHORIZE_PATH}?state=${MARKER}&platform=darwin`;
/** The same url arriving as `document.referrer`, which posthog-js never masks. */
const PERSISTED_REFERRER_SECRET = "persisted-referrer-csrf-6b8f";
const PERSISTED_REFERRER_URL = `https://app.example.com${AUTHORIZE_PATH}?state=${PERSISTED_REFERRER_SECRET}&platform=darwin`;
/** `reloadFeatureFlags`'s debounce before `_callFlagsEndpoint` builds a payload. */
const FLAGS_DEBOUNCE_MS = 5;

const { providerConfig, mockPostHogProvider, harness } = vi.hoisted(() => ({
  harness: {
    client: null as unknown,
    container: null as HTMLElement | null,
  },
  providerConfig: {
    NEXT_PUBLIC_GA_MEASUREMENT_ID: undefined as string | undefined,
    NEXT_PUBLIC_POSTHOG_KEY: "phc_test" as string | undefined,
    NEXT_PUBLIC_VERCEL_ANALYTICS_ENABLED: undefined as string | undefined,
  },
  mockPostHogProvider: vi.fn(
    (_props: {
      children: React.ReactNode;
      clientOptions?: Record<string, unknown>;
    }): React.ReactNode => null
  ),
}));

vi.mock("@next/third-parties/google", () => ({ GoogleAnalytics: () => null }));
vi.mock("@vercel/analytics/react", () => ({ Analytics: () => null }));
vi.mock("@posthog/next", () => ({
  usePostHog: () => harness.client,
  PostHogProvider: mockPostHogProvider,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("./keys", () => ({
  isValidGaMeasurementId: () => false,
  keys: () => providerConfig,
}));

let instanceCounter = 0;

/**
 * Every event captured from the moment `posthog.init` returns, which is BEFORE
 * any provider child has rendered.
 *
 * posthog-js attaches `get_initial_props()` as `$set_once` to the FIRST capture
 * of a page load only — `_calculate_set_once_properties` returns its argument
 * untouched once it has marked them sent (resolved 1.359.1) — so which event
 * carries them is decided by whatever captures first. `<PostHogPersistenceGuard />`
 * (ISS-8660) captures `analytics_persistence_repaired` during its own render on
 * exactly the browsers these cases seed, so a case that asserted the initial
 * props on a LATER hand-rolled capture would be asserting mount order, not
 * redaction. This collector lets it assert them where they actually ride.
 */
const capturedFromMount: CapturedEvent[] = [];

// Warm the dynamic import once. Otherwise whichever case runs first pays the
// posthog-js module load inside its own timeout budget, which on a loaded
// machine is the difference between a pass and a spurious 5s timeout.
beforeAll(async () => {
  await import("./provider");
});

beforeEach(() => {
  harness.client = null;
  harness.container = null;
  capturedFromMount.length = 0;
  vi.clearAllMocks();
  window.localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.history.replaceState({}, "", "/");
});

describe("percent-encoded query keys on a non-pageview payload", () => {
  it("masks an encoded key spelling posthog-js compares raw and misses", async () => {
    navigateTo(
      `${AUTHORIZE_PATH}?%73tate=${ENCODED_STATE_SECRET}&state=${PLAIN_STATE_SECRET}&platform=darwin`
    );
    const client = await mountAnalytics();

    const payload = captureAutocaptureClick(client);

    const currentUrl = readCurrentUrl(payload);
    const leaksEncoded = currentUrl.includes(ENCODED_STATE_SECRET);
    const leaksPlain = currentUrl.includes(PLAIN_STATE_SECRET);
    expect(leaksEncoded).toBe(false);
    expect(leaksPlain).toBe(false);
    // The positive half: an absent `$current_url`, a dropped event, or a capture
    // that never fired would satisfy the two lines above on their own.
    expect(payload.event).toBe("$autocapture");
    const parsed = new URL(currentUrl);
    expect(parsed.pathname).toBe(AUTHORIZE_PATH);
    expect(parsed.searchParams.get("platform")).toBe("darwin");
    expect(parsed.searchParams.get("state")).toBe(MARKER);
  });

  it("leaks no encoded secret anywhere else in the event either", async () => {
    navigateTo(`${AUTHORIZE_PATH}?%73tate=${ENCODED_STATE_SECRET}`);
    const client = await mountAnalytics();

    const payload = captureAutocaptureClick(client);

    const leaks = JSON.stringify(payload).includes(ENCODED_STATE_SECRET);
    expect(leaks).toBe(false);
    expect(payload.properties.$lib_version).toBe(shippedPostHogVersion());
  });

  it("leaves an ordinary route's url untouched", async () => {
    const href = `${ORDINARY_PATH}?status=active&page=2`;
    navigateTo(href);
    const client = await mountAnalytics();

    const payload = captureAutocaptureClick(client);

    expect(readCurrentUrl(payload)).toBe(`${window.location.origin}${href}`);
  });
});

describe("url values posthog-js restored from persistence", () => {
  it("stops emitting an authorize url persisted before the mask shipped", async () => {
    navigateTo(ORDINARY_PATH);
    seedPreMaskPersistence();
    const client = await mountAnalytics(persistedStoreOptions());

    const payload = captureAutocaptureClick(client);

    // Every event of the load, not only the hand-rolled one: the persistence
    // guard's own report is emitted from this same seeded store, so it is a
    // sink for the stale value too.
    const leaks = JSON.stringify([...capturedFromMount, payload]).includes(
      PERSISTED_SECRET
    );
    expect(leaks).toBe(false);
    // Positive siblings: the properties the stale record feeds still ARRIVE, so
    // "no secret" cannot be satisfied by person processing having been off.
    // Asserted on the FIRST capture of the load rather than on the autocapture:
    // posthog-js hands `get_initial_props()` to that one capture and to no
    // other, and since ISS-8660 the first capture on a browser whose record
    // needed repairing is the guard's `analytics_persistence_repaired`.
    const initialProps = firstCaptureOfLoad(payload).setOnce ?? {};
    expect(initialProps.$initial_current_url).toBe(
      `https://app.example.com${AUTHORIZE_PATH}?state=${MARKER}&platform=darwin`
    );
    expect(initialProps.$initial_pathname).toBe(AUTHORIZE_PATH);
    expect(payload.properties.$session_entry_url).toBe(
      `https://app.example.com${AUTHORIZE_PATH}?state=${MARKER}&platform=darwin`
    );
    expect(payload.properties.$session_entry_host).toBe("app.example.com");
  });

  it("rewrites the stale record in the browser's own store", async () => {
    // `persistence` is `localStorage+cookie`, so until the stored value is
    // rewritten the raw authorize url rides the `ph_*` cookie on every request
    // to our own origin — a sink `before_send` cannot reach.
    navigateTo(ORDINARY_PATH);
    seedPreMaskPersistence();
    const client = await mountAnalytics(persistedStoreOptions());

    expect(client.persistence?.props.$initial_person_info).toEqual({
      r: "$direct",
      u: `https://app.example.com${AUTHORIZE_PATH}?state=${MARKER}&platform=darwin`,
    });
    expect(client.persistence?.props.$client_session_props).toEqual({
      sessionId: "seeded-session",
      props: {
        r: "$direct",
        u: `https://app.example.com${AUTHORIZE_PATH}?state=${MARKER}&platform=darwin`,
      },
    });
  });

  it("rewrites the stored initial REFERRER, not only the stored url", async () => {
    // `getPersonInfo` runs `maskQueryParams` on `u` and takes `r` verbatim
    // (resolved 1.359.1 `utils/event-utils.ts:204-214`). `r` is
    // `document.referrer`, which on this flow IS the authorize url once the
    // browser leaves it, and `get_initial_props()` turns it into
    // `$initial_referrer` — the payload `_callFlagsEndpoint` posts directly.
    navigateTo(ORDINARY_PATH);
    seedPersistence(PERSISTED_AUTHORIZE_URL, PERSISTED_REFERRER_URL);
    const client = await mountAnalytics(persistedStoreOptions());

    const stored = JSON.stringify(client.persistence?.props ?? {});
    const leaks = stored.includes(PERSISTED_REFERRER_SECRET);
    expect(leaks).toBe(false);
    // Positive siblings: both records survive with the referrer still readable
    // as a url, so "no secret" cannot be satisfied by a dropped field.
    expect(client.persistence?.props.$initial_person_info).toEqual({
      r: REDACTED_AUTHORIZE_URL,
      u: REDACTED_AUTHORIZE_URL,
    });
    expect(client.persistence?.props.$client_session_props).toEqual({
      sessionId: "seeded-session",
      props: { r: REDACTED_AUTHORIZE_URL, u: REDACTED_AUTHORIZE_URL },
    });
    expect(client.persistence?.get_initial_props().$initial_referrer).toBe(
      REDACTED_AUTHORIZE_URL
    );
  });

  it("leaves a referrer that carries no secret exactly as stored", async () => {
    navigateTo(ORDINARY_PATH);
    const innocuousUrl = `https://app.example.com${ORDINARY_PATH}`;
    const innocuousReferrer = `https://app.example.com${ORDINARY_PATH}?page=2`;
    seedPersistence(innocuousUrl, innocuousReferrer);
    const client = await mountAnalytics(persistedStoreOptions());

    expect(client.persistence?.props.$initial_person_info).toEqual({
      r: innocuousReferrer,
      u: innocuousUrl,
    });
  });

  it("sweeps the store before the flags endpoint can build its payload", async () => {
    // `_callFlagsEndpoint` posts `persistence.get_initial_props()` directly
    // (1.359.1 `posthog-featureflags.ts:482`), never through `before_send`, and
    // is reached ONLY through `reloadFeatureFlags`'s `setTimeout(…, 5)` debounce
    // — a macrotask. The guard installs from a LAYOUT effect, which commits in
    // the same task as the `posthog.init` this provider runs during render, so
    // the store is already swept when the earliest flags task can fire.
    navigateTo(ORDINARY_PATH);
    seedPreMaskPersistence();
    const client = await mountAnalytics({
      ...persistedStoreOptions(),
      // Flags must be ON at INIT: `_shouldDisableFlags` reads the original user
      // config first, so a post-init `set_config` cannot reach this branch. The
      // refused-by-design host keeps init's remote-config GET off the network.
      advanced_disable_flags: false,
      advanced_disable_decide: false,
      api_host: "http://localhost:1",
    });

    const sent: Parameters<PostHog["_send_request"]>[0][] = [];
    vi.spyOn(client, "_send_request").mockImplementation((options) => {
      sent.push(options);
    });
    vi.useFakeTimers();
    try {
      client.reloadFeatureFlags();
      vi.advanceTimersByTime(FLAGS_DEBOUNCE_MS);
    } finally {
      vi.useRealTimers();
    }

    const flags = sent.find((request) => request.url.includes("/flags/"));
    const personProperties = readPersonProperties(flags);
    const leaks = JSON.stringify(personProperties).includes(PERSISTED_SECRET);
    expect(leaks).toBe(false);
    // Positive siblings: the request was really built and still carries the
    // property, so "no secret" cannot be satisfied by no flags request at all.
    expect(flags?.method).toBe("POST");
    expect(personProperties.$initial_current_url).toBe(REDACTED_AUTHORIZE_URL);
  });

  it("leaves a persisted record that carries no secret exactly as stored", async () => {
    navigateTo(ORDINARY_PATH);
    const innocuous = `https://app.example.com${ORDINARY_PATH}?page=2`;
    seedPersistence(innocuous);
    const client = await mountAnalytics(persistedStoreOptions());

    expect(client.persistence?.props.$initial_person_info).toEqual({
      r: "$direct",
      u: innocuous,
    });
  });

  it("tolerates a persisted record whose shape it does not recognize", async () => {
    // Persisted state is version-skewed input: the types do not constrain what a
    // browser wrote months ago, or what a different posthog-js release wrote.
    navigateTo(ORDINARY_PATH);
    window.localStorage.setItem(
      "ph_phc_test_posthog",
      JSON.stringify({
        $initial_person_info: "not-an-object",
        $client_session_props: { sessionId: "seeded-session" },
        distinct_id: "seeded-distinct-id",
      })
    );
    const client = await mountAnalytics(persistedStoreOptions());

    const payload = captureAutocaptureClick(client);

    expect(payload.event).toBe("$autocapture");
    expect(client.persistence?.props.$initial_person_info).toBe(
      "not-an-object"
    );
  });

  it("skips a persisted record that carries no url field", async () => {
    // The shape `persistedPersonInfoSchema` exists to reject — a referrer-only
    // record, or one a posthog-js release renamed `u` out of. It must no-op
    // rather than throw or write a half-parsed record back.
    navigateTo(ORDINARY_PATH);
    window.localStorage.setItem(
      "ph_phc_test_posthog",
      JSON.stringify({
        $initial_person_info: { r: "$direct" },
        $client_session_props: {
          sessionId: "seeded-session",
          props: { r: "$direct" },
        },
        distinct_id: "seeded-distinct-id",
        $sesid: [Date.now(), "seeded-session", Date.now()],
      })
    );
    const client = await mountAnalytics(persistedStoreOptions());

    const payload = captureAutocaptureClick(client);

    expect(payload.event).toBe("$autocapture");
    expect(client.persistence?.props.$initial_person_info).toEqual({
      r: "$direct",
    });
    expect(client.persistence?.props.$client_session_props).toEqual({
      sessionId: "seeded-session",
      props: { r: "$direct" },
    });
  });

  it("re-sweeps the store when the session id rolls after a reset", async () => {
    // `posthog.reset()` on sign-out CLEARS persistence without replacing the
    // client, so the guard's effect never re-runs. The next capture re-persists
    // from the current href through posthog-js's OWN masker, which compares raw
    // keys — so without a re-sweep an encoded spelling lands in the cookie.
    navigateTo(`${AUTHORIZE_PATH}?%73tate=${ENCODED_STATE_SECRET}`);
    const client = await mountAnalytics(persistedStoreOptions());
    client.reset();

    captureAutocaptureClick(client);

    const stored = JSON.stringify(client.persistence?.props ?? {});
    const leaks = stored.includes(ENCODED_STATE_SECRET);
    expect(leaks).toBe(false);
    // Positive sibling: the record was actually re-created, so "no secret"
    // cannot be satisfied by an empty store.
    expect(stored).toContain("$client_session_props");
  });

  it("still records a fresh session's own entry url", async () => {
    navigateTo(`${ORDINARY_PATH}?page=2`);
    const client = await mountAnalytics(persistedStoreOptions());

    const payload = captureAutocaptureClick(client);

    expect(payload.properties.$session_entry_url).toBe(
      `${window.location.origin}${ORDINARY_PATH}?page=2`
    );
  });
});

describe("the session replay url masker", () => {
  it("installs the masker replay actually consults", async () => {
    navigateTo(ORDINARY_PATH);
    const client = await mountAnalytics();

    // This is the exact expression `_maskUrl` evaluates for an rrweb Meta href:
    // `this._instance.config.session_recording.maskCapturedNetworkRequestFn`.
    const masker = client.config.session_recording.maskCapturedNetworkRequestFn;
    if (!masker) {
      throw new Error("no replay url masker installed");
    }
    const href = `https://app.example.com${AUTHORIZE_PATH}?%73tate=${ENCODED_STATE_SECRET}&state=${PLAIN_STATE_SECRET}&platform=darwin`;

    const masked = masker({ name: href } as never);

    const maskedName = masked?.name ?? "";
    const leaksEncoded = maskedName.includes(ENCODED_STATE_SECRET);
    const leaksPlain = maskedName.includes(PLAIN_STATE_SECRET);
    expect(leaksEncoded).toBe(false);
    expect(leaksPlain).toBe(false);
    // A masker returning nothing would drop the Meta event entirely; the href
    // has to survive as a usable url or the replay loses its page context.
    expect(new URL(maskedName).searchParams.get("platform")).toBe("darwin");
  });

  it("drops request and response bodies the SDK no longer scrubs", async () => {
    // Setting `maskCapturedNetworkRequestFn` REPLACES posthog-js's own
    // `scrubPayloads` step rather than running alongside it (resolved 1.359.1,
    // `extensions/replay/external/config.ts:253-260`), so the bodies it would
    // have redacted for passwords and tokens would otherwise arrive raw.
    navigateTo(ORDINARY_PATH);
    const client = await mountAnalytics();
    const masker = client.config.session_recording.maskCapturedNetworkRequestFn;
    if (!masker) {
      throw new Error("no replay url masker installed");
    }

    const masked = masker({
      name: "https://app.example.com/api/session",
      requestBody: '{"password":"hunter2"}',
      responseBody: '{"token":"sk_live_abc"}',
    } as never);

    expect(masked?.requestBody).toBeNull();
    expect(masked?.responseBody).toBeNull();
  });

  it("keeps the input masking the provider set alongside it", async () => {
    // `set_config` merges shallowly, so installing the masker would silently
    // drop `maskAllInputs` if the existing options were not carried across.
    navigateTo(ORDINARY_PATH);
    const client = await mountAnalytics();

    expect(client.config.session_recording.maskAllInputs).toBe(true);
  });
});

describe("urls that arrive as an object KEY", () => {
  it("redacts the url a heatmap buckets its clicks under", async () => {
    // `$heatmap_data` is `{ [url]: clicks[] }`, and posthog-js keys it with its
    // OWN masker — the raw-key comparison — so an encoded spelling buckets
    // under an unmasked key. Nothing else in this repo would redact it.
    navigateTo(ORDINARY_PATH);
    const client = await mountAnalytics();
    const bucket = `https://app.example.com${AUTHORIZE_PATH}?%73tate=${ENCODED_STATE_SECRET}`;

    const payload = captureEvent(client, "$$heatmap", {
      $heatmap_data: { [bucket]: [{ x: 1, y: 2 }] },
    });

    const heatmap = payload.properties.$heatmap_data as Record<string, unknown>;
    const keys = Object.keys(heatmap);
    const leaks = keys.some((key) => key.includes(ENCODED_STATE_SECRET));
    expect(leaks).toBe(false);
    expect(keys).toEqual([
      `https://app.example.com${AUTHORIZE_PATH}?%73tate=${MARKER}`,
    ]);
    expect(heatmap[keys[0] as string]).toEqual([{ x: 1, y: 2 }]);
  });

  it("concatenates the buckets of two urls that redact to the same key", async () => {
    navigateTo(ORDINARY_PATH);
    const client = await mountAnalytics();
    const base = `https://app.example.com${AUTHORIZE_PATH}?state=`;

    const payload = captureEvent(client, "$$heatmap", {
      $heatmap_data: {
        [`${base}${ENCODED_STATE_SECRET}`]: [{ x: 1 }],
        [`${base}${PLAIN_STATE_SECRET}`]: [{ x: 2 }],
      },
    });

    const heatmap = payload.properties.$heatmap_data as Record<string, unknown>;
    // Clobbering instead of merging would silently drop a whole page's clicks.
    expect(heatmap[`${base}${MARKER}`]).toEqual([{ x: 1 }, { x: 2 }]);
  });
});

describe("payload shapes the walk has to bound", () => {
  it("still sweeps the envelope posthog-js wraps a snapshot in", async () => {
    // `calculateEventProperties` returns early for `$snapshot` before it adds
    // `$current_url` or the session-entry props — but `_calculate_set_once_properties`
    // is NOT gated on the event name, so the FIRST capture of a page load
    // attaches `get_initial_props()` even when that capture is a snapshot.
    //
    // `get_initial_props` also reads the PRE-MIGRATION `$initial_referrer_info`
    // key, which `remaskPersistedUrls` deliberately does not own — so on a
    // browser carrying that shape `before_send` is the only guard there is, and
    // skipping the whole `$snapshot` event skips it.
    navigateTo(ORDINARY_PATH);
    seedLegacyReferrerPersistence();
    const client = await mountAnalytics(persistedStoreOptions());
    const snapshotData = [
      { href: `${AUTHORIZE_PATH}?state=${PLAIN_STATE_SECRET}` },
    ];

    const snapshot = captureEvent(client, "$snapshot", {
      $snapshot_data: snapshotData,
      $session_id: "seeded-session",
    });

    const leaks = JSON.stringify(snapshot.setOnce ?? {}).includes(
      PERSISTED_REFERRER_SECRET
    );
    expect(leaks).toBe(false);
    // Positive siblings: the person property still ARRIVES on the snapshot as a
    // readable url, and the rrweb subtree is still handed straight through.
    expect(snapshot.setOnce?.$initial_referrer).toBe(REDACTED_AUTHORIZE_URL);
    expect(snapshot.properties.$snapshot_data).toEqual(snapshotData);
  });

  it("hands a replay snapshot's rrweb payload through untouched", async () => {
    // Replay has its own masker; walking rrweb here would cost the recorder for
    // nothing. The bypass must not extend to any other event.
    navigateTo(ORDINARY_PATH);
    const client = await mountAnalytics();
    const snapshotData = [
      { href: `${AUTHORIZE_PATH}?state=${PLAIN_STATE_SECRET}` },
    ];

    const snapshot = captureEvent(client, "$snapshot", {
      $snapshot_data: snapshotData,
    });
    const ordinary = captureEvent(client, "custom_event", {
      href: `${AUTHORIZE_PATH}?state=${PLAIN_STATE_SECRET}`,
    });

    // Unredacted, deliberately: the recorder's own masker owns this payload.
    expect(snapshot.properties.$snapshot_data).toEqual(snapshotData);
    // The positive sibling: the same string on a non-snapshot event IS redacted,
    // so the pass-through above is a bypass and not a broken redactor.
    expect(ordinary.properties.href).toBe(`${AUTHORIZE_PATH}?state=${MARKER}`);
  });

  it("redacts a url however deeply it is nested", async () => {
    navigateTo(ORDINARY_PATH);
    const client = await mountAnalytics();
    const deep = {
      a: {
        b: {
          c: {
            d: {
              e: {
                f: {
                  g: {
                    h: {
                      i: {
                        j: {
                          k: {
                            l: {
                              m: {
                                n: `${AUTHORIZE_PATH}?state=${PLAIN_STATE_SECRET}`,
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const payload = captureEvent(client, "custom_event", { deep });

    // Past the descent ceiling the subtree is replaced by the marker rather
    // than passed through, so "too deep to walk" never reads as "clean".
    const leaks = JSON.stringify(payload).includes(PLAIN_STATE_SECRET);
    expect(leaks).toBe(false);
    expect(payload.event).toBe("custom_event");
  });
});

describe("the redaction guard itself", () => {
  it("renders nothing of its own", async () => {
    navigateTo(ORDINARY_PATH);
    await mountAnalytics();

    expect(harness.container?.innerHTML).toBe("<div>Application</div>");
  });

  it("installs one redaction pass across a re-mount", async () => {
    navigateTo(`${AUTHORIZE_PATH}?state=${PLAIN_STATE_SECRET}`);
    const client = await mountAnalytics();

    // A second mount against the SAME already-initialized client — what a
    // navigation that remounts the tree, or React StrictMode, actually does.
    await mountAnalytics();

    const beforeSend = client.config.before_send;
    // Asserted as an array first: `Array.isArray(undefined) ? … : 1` would read
    // as "exactly one install" on a client where nothing was installed at all.
    expect(Array.isArray(beforeSend)).toBe(true);
    expect(Array.isArray(beforeSend) && beforeSend.length).toBe(1);
    const payload = captureAutocaptureClick(client);
    expect(new URL(readCurrentUrl(payload)).searchParams.get("state")).toBe(
      MARKER
    );
  });
});

/**
 * `_send_request` types `data` as a single payload OR a batch of them; only the
 * single-payload shape carries the person properties the flags endpoint posts.
 */
function readPersonProperties(
  request: Parameters<PostHog["_send_request"]>[0] | undefined
): Record<string, unknown> {
  const data = request?.data;
  if (!data || Array.isArray(data)) {
    return {};
  }
  return (data.person_properties ?? {}) as Record<string, unknown>;
}

/** Options that put the seeded store in front of the client under test. */
function persistedStoreOptions(): Record<string, unknown> {
  return { persistence: "localStorage", person_profiles: "always" };
}

function seedPreMaskPersistence(): void {
  seedPersistence(PERSISTED_AUTHORIZE_URL);
}

/**
 * The store shape a browser carried from BEFORE `$initial_person_info` existed.
 * `get_initial_props` still reads it (`posthog-persistence.ts`, "this section
 * isn't written to anymore"), and `set_initial_person_info` refuses to write the
 * modern key while it is present, so this record feeds `$set_once` and the flags
 * payload indefinitely. It is not a shape `remaskPersistedUrls` owns.
 */
function seedLegacyReferrerPersistence(): void {
  window.localStorage.setItem(
    "ph_phc_test_posthog",
    JSON.stringify({
      $initial_referrer_info: { $referrer: PERSISTED_REFERRER_URL },
      distinct_id: "seeded-distinct-id",
      $sesid: [Date.now(), "seeded-session", Date.now()],
    })
  );
}

/**
 * Write the store shape a browser carried across the ISS-8295 upgrade: the
 * person record `register_once` will refuse to overwrite, and the session record
 * that only refreshes when the session id rolls.
 */
function seedPersistence(url: string, referrer = "$direct"): void {
  window.localStorage.setItem(
    "ph_phc_test_posthog",
    JSON.stringify({
      $initial_person_info: { r: referrer, u: url },
      $client_session_props: {
        sessionId: "seeded-session",
        props: { r: referrer, u: url },
      },
      distinct_id: "seeded-distinct-id",
      $sesid: [Date.now(), "seeded-session", Date.now()],
    })
  );
}

/**
 * Render the real `AnalyticsProvider` with a `PostHogProvider` that initializes
 * posthog-js during render, the way `@posthog/next`'s own client provider does.
 * The extra options are transport plumbing only.
 */
async function mountAnalytics(
  extra: Record<string, unknown> = {}
): Promise<PostHog> {
  const { AnalyticsProvider } = await import("./provider");
  mockPostHogProvider.mockImplementation(({ children, clientOptions }) => {
    if (!(harness.client || clientOptions)) {
      throw new Error("AnalyticsProvider rendered no clientOptions");
    }
    if (!harness.client) {
      instanceCounter += 1;
      harness.client = posthog.init(
        "phc_test",
        {
          ...clientOptions,
          ...IN_PROCESS_POSTHOG_OPTIONS,
          ...extra,
        },
        `iss8305-${instanceCounter}`
      );
      (harness.client as PostHog)._addCaptureHook((event, payload) => {
        if (payload) {
          capturedFromMount.push({
            event,
            properties: payload.properties,
            set: payload.$set,
            setOnce: payload.$set_once,
          });
        }
      });
    }
    return children;
  });

  const { container } = render(
    <AnalyticsProvider>
      <div>Application</div>
    </AnalyticsProvider>
  );
  harness.container = container;

  if (!harness.client) {
    throw new Error("posthog-js did not initialize");
  }
  return harness.client as PostHog;
}

/**
 * The event posthog-js gave this load's `get_initial_props()` to — the first it
 * captured after `init`, falling back to `fallback` when nothing captured during
 * mount. Named rather than indexed blindly so a case that finds the initial
 * props missing reports WHICH event was first.
 */
function firstCaptureOfLoad(fallback: CapturedEvent): CapturedEvent {
  return capturedFromMount[0] ?? fallback;
}
