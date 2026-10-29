import { describe, expect, it } from "vitest";
import { PersistedPersonInfoKey } from "./posthog-persistence-repair";
import {
  POSTHOG_SESSION_KEY,
  postHogPersistenceName,
  resumeSharedSession,
  SharedSessionResumeOutcome,
  type SharedSessionStorage,
  type StoredSession,
} from "./posthog-shared-session";

const TOKEN = "phc_iss12559_unit";
const NAME = `ph_${TOKEN}_posthog`;
const CONSENT = `__ph_opt_in_out_${TOKEN}`;
const T0 = 1_760_000_000_000;
const HOUR = 3_600_000;

const STALE: StoredSession = [T0 - 2 * HOUR, "0199-stale-local", T0 - 3 * HOUR];
const SHARED: StoredSession = [T0 - 60_000, "0199-shared-cookie", T0 - HOUR];
const SEED: StoredSession = [
  T0 - 30 * 24 * HOUR,
  "0199-seed",
  T0 - 30 * 24 * HOUR,
];

describe("resumeSharedSession", () => {
  it("replaces a stale local session with the shared cookie's, leaving identity alone", () => {
    const storage = memoryStorage({
      [NAME]: {
        distinct_id: "anon-local",
        $device_id: "anon-local",
        $user_state: "anonymous",
        [POSTHOG_SESSION_KEY]: STALE,
        [PersistedPersonInfoKey.ClientSessionProps]: {
          sessionId: STALE[1],
          props: { r: "$direct", u: "https://www.closedloop.ai/pricing" },
        },
      },
    });

    const outcome = resumeSharedSession({
      token: TOKEN,
      cookieHeader: cookieHeader([
        [
          NAME,
          { distinct_id: "user-1", $user_state: "identified", $sesid: SHARED },
        ],
      ]),
      storage,
    });

    expect(outcome).toBe(SharedSessionResumeOutcome.Resumed);
    // Identity is posthog-js's own load: only the session key moved.
    expect(storage.read(NAME)).toEqual({
      distinct_id: "anon-local",
      $device_id: "anon-local",
      $user_state: "anonymous",
      [POSTHOG_SESSION_KEY]: [...SHARED],
    });
  });

  it("keeps session entry props that already describe the adopted session", () => {
    const entry = { sessionId: SHARED[1], props: { r: "$direct" } };
    const storage = memoryStorage({
      [NAME]: {
        [POSTHOG_SESSION_KEY]: STALE,
        [PersistedPersonInfoKey.ClientSessionProps]: entry,
      },
    });

    resumeSharedSession({
      token: TOKEN,
      cookieHeader: cookieHeader([[NAME, { $sesid: SHARED }]]),
      storage,
    });

    expect(storage.read(NAME)).toEqual({
      [POSTHOG_SESSION_KEY]: [...SHARED],
      [PersistedPersonInfoKey.ClientSessionProps]: entry,
    });
  });

  it("leaves a malformed session entry record to the persistence guard", () => {
    const storage = memoryStorage({
      [NAME]: {
        [POSTHOG_SESSION_KEY]: STALE,
        [PersistedPersonInfoKey.ClientSessionProps]: "not-a-record",
      },
    });

    resumeSharedSession({
      token: TOKEN,
      cookieHeader: cookieHeader([[NAME, { $sesid: SHARED }]]),
      storage,
    });

    expect(storage.read(NAME)).toEqual({
      [POSTHOG_SESSION_KEY]: [...SHARED],
      [PersistedPersonInfoKey.ClientSessionProps]: "not-a-record",
    });
  });

  it("keeps a local session that is more recently active than the cookie", () => {
    const storage = memoryStorage({
      [NAME]: { [POSTHOG_SESSION_KEY]: SHARED },
    });

    const outcome = resumeSharedSession({
      token: TOKEN,
      cookieHeader: cookieHeader([[NAME, { $sesid: STALE }]]),
      storage,
    });

    expect(outcome).toBe(SharedSessionResumeOutcome.AlreadyCurrent);
    expect(storage.writes).toBe(0);
  });

  it("picks the domain cookie over an older host-only seed listed first", () => {
    // `@posthog/next`'s middleware seed is host-only and older, so the browser
    // lists it first and posthog-js's `cookieStore._get` would load it.
    const storage = memoryStorage({});

    const outcome = resumeSharedSession({
      token: TOKEN,
      cookieHeader: cookieHeader([
        [NAME, { distinct_id: "seed", $sesid: SEED }],
        [NAME, { distinct_id: "seed", $sesid: SHARED }],
      ]),
      storage,
    });

    expect(outcome).toBe(SharedSessionResumeOutcome.Resumed);
    expect(storage.read(NAME)).toEqual({ [POSTHOG_SESSION_KEY]: [...SHARED] });
  });

  it("writes nothing when posthog-js would already load the latest cookie session", () => {
    const storage = memoryStorage({});

    const outcome = resumeSharedSession({
      token: TOKEN,
      cookieHeader: cookieHeader([
        [NAME, { $sesid: SHARED }],
        [NAME, { $sesid: SEED }],
      ]),
      storage,
    });

    expect(outcome).toBe(SharedSessionResumeOutcome.AlreadyCurrent);
    expect(storage.writes).toBe(0);
  });

  it.each([
    ["a tuple with no start timestamp", [SHARED[0] + 1, "0199-local", null]],
  ])("leaves %s for posthog-js to interpret", (_label, sesid) => {
    const storage = memoryStorage({
      [NAME]: { [POSTHOG_SESSION_KEY]: sesid },
    });

    const outcome = resumeSharedSession({
      token: TOKEN,
      cookieHeader: cookieHeader([[NAME, { $sesid: SHARED }]]),
      storage,
    });

    expect(outcome).toBe(SharedSessionResumeOutcome.LocalSessionNotComparable);
    expect(storage.writes).toBe(0);
  });

  it("completes a two-element tuple with its activity time, as SessionIdManager does", () => {
    const storage = memoryStorage({ [NAME]: { [POSTHOG_SESSION_KEY]: STALE } });

    resumeSharedSession({
      token: TOKEN,
      cookieHeader: cookieHeader([[NAME, { $sesid: [SHARED[0], SHARED[1]] }]]),
      storage,
    });

    expect(storage.read(NAME)).toEqual({
      [POSTHOG_SESSION_KEY]: [SHARED[0], SHARED[1], SHARED[0]],
    });
  });

  it.each([
    ["a string timestamp", [String(SHARED[0]), SHARED[1], SHARED[2]]],
    ["a negative timestamp", [-1, SHARED[1], SHARED[2]]],
    ["a fractional timestamp", [SHARED[0] + 0.5, SHARED[1], SHARED[2]]],
    [
      "a timestamp past the safe-integer range",
      [2 ** 53, SHARED[1], SHARED[2]],
    ],
    ["an empty session id", [SHARED[0], "", SHARED[2]]],
    ["a numeric session id", [SHARED[0], 7, SHARED[2]]],
    ["a non-numeric start", [SHARED[0], SHARED[1], "start"]],
    ["a one-element tuple", [SHARED[0]]],
    ["an object", { sessionId: SHARED[1] }],
  ])("adopts no cookie session holding %s", (_label, sesid) => {
    const storage = memoryStorage({ [NAME]: { [POSTHOG_SESSION_KEY]: STALE } });

    const outcome = resumeSharedSession({
      token: TOKEN,
      cookieHeader: cookieHeader([[NAME, { $sesid: sesid }]]),
      storage,
    });

    expect(outcome).toBe(SharedSessionResumeOutcome.NoCookieSession);
    expect(storage.writes).toBe(0);
  });

  it("ignores a cookie that is not JSON and one for another project", () => {
    const storage = memoryStorage({ [NAME]: { [POSTHOG_SESSION_KEY]: STALE } });

    const outcome = resumeSharedSession({
      token: TOKEN,
      cookieHeader: `${NAME}=%7Bnot-json; ph_phc_other_posthog=${encodeURIComponent(
        JSON.stringify({ $sesid: SHARED })
      )}`,
      storage,
    });

    expect(outcome).toBe(SharedSessionResumeOutcome.NoCookieSession);
    expect(storage.writes).toBe(0);
  });

  it.each([
    ["not JSON", "{oops"],
    ["an array", "[1,2]"],
    ["a string", '"text"'],
  ])("leaves a local record that is %s to posthog-js", (_label, raw) => {
    const storage = memoryStorage({});
    storage.setItem(NAME, raw);
    storage.writes = 0;

    const outcome = resumeSharedSession({
      token: TOKEN,
      cookieHeader: cookieHeader([
        [NAME, { $sesid: SEED }],
        [NAME, { $sesid: SHARED }],
      ]),
      storage,
    });

    expect(outcome).toBe(SharedSessionResumeOutcome.UnreadableLocalRecord);
    expect(storage.getItem(NAME)).toBe(raw);
    expect(storage.writes).toBe(0);
  });

  it("writes nothing for a visitor opted out through the consent cookie", () => {
    const storage = memoryStorage({ [NAME]: { [POSTHOG_SESSION_KEY]: STALE } });

    const outcome = resumeSharedSession({
      token: TOKEN,
      cookieHeader: `${cookieHeader([[NAME, { $sesid: SHARED }]])}; ${CONSENT}=0`,
      storage,
    });

    expect(outcome).toBe(SharedSessionResumeOutcome.OptedOut);
    expect(storage.writes).toBe(0);
  });

  it("writes nothing for a visitor opted out through a localStorage consent record", () => {
    const storage = memoryStorage({
      [NAME]: { [POSTHOG_SESSION_KEY]: STALE },
      [CONSENT]: 0,
    });

    const outcome = resumeSharedSession({
      token: TOKEN,
      cookieHeader: cookieHeader([[NAME, { $sesid: SHARED }]]),
      storage,
    });

    expect(outcome).toBe(SharedSessionResumeOutcome.OptedOut);
    expect(storage.writes).toBe(0);
  });

  it("still resumes for a visitor who opted in", () => {
    const storage = memoryStorage({ [NAME]: { [POSTHOG_SESSION_KEY]: STALE } });

    const outcome = resumeSharedSession({
      token: TOKEN,
      cookieHeader: `${cookieHeader([[NAME, { $sesid: SHARED }]])}; ${CONSENT}=1`,
      storage,
    });

    expect(outcome).toBe(SharedSessionResumeOutcome.Resumed);
  });

  it("lets the consent cookie win over a stale localStorage opt-out, as posthog-js does", () => {
    const storage = memoryStorage({
      [NAME]: { [POSTHOG_SESSION_KEY]: STALE },
      [CONSENT]: 0,
    });

    const outcome = resumeSharedSession({
      token: TOKEN,
      cookieHeader: `${cookieHeader([[NAME, { $sesid: SHARED }]])}; ${CONSENT}=1`,
      storage,
    });

    expect(outcome).toBe(SharedSessionResumeOutcome.Resumed);
  });

  it("falls back to localStorage consent when the consent cookie does not decode", () => {
    const storage = memoryStorage({
      [NAME]: { [POSTHOG_SESSION_KEY]: STALE },
      [CONSENT]: 0,
    });

    const outcome = resumeSharedSession({
      token: TOKEN,
      cookieHeader: `${cookieHeader([[NAME, { $sesid: SHARED }]])}; ${CONSENT}=%E0%A4%A`,
      storage,
    });

    expect(outcome).toBe(SharedSessionResumeOutcome.OptedOut);
  });

  it("adopts nothing from a cookie value that does not URI-decode, as posthog-js reads none", () => {
    const storage = memoryStorage({ [NAME]: { [POSTHOG_SESSION_KEY]: STALE } });

    // Valid JSON when read raw, but posthog-js's lookup returns null for it.
    const outcome = resumeSharedSession({
      token: TOKEN,
      cookieHeader: `${NAME}=${JSON.stringify({ $sesid: SHARED, note: "100%" })}`,
      storage,
    });

    expect(outcome).toBe(SharedSessionResumeOutcome.NoCookieSession);
    expect(storage.writes).toBe(0);
  });

  it("counterfactual: the same cookie session is adopted when the local record is an object", () => {
    // The `UnreadableLocalRecord` cases above differ only in the local record.
    const storage = memoryStorage({ [NAME]: {} });

    const outcome = resumeSharedSession({
      token: TOKEN,
      cookieHeader: cookieHeader([
        [NAME, { $sesid: SEED }],
        [NAME, { $sesid: SHARED }],
      ]),
      storage,
    });

    expect(outcome).toBe(SharedSessionResumeOutcome.Resumed);
  });

  it("counterfactual: a comparable older local tuple is replaced where an uncomparable one is not", () => {
    const storage = memoryStorage({ [NAME]: { [POSTHOG_SESSION_KEY]: STALE } });

    const outcome = resumeSharedSession({
      token: TOKEN,
      cookieHeader: cookieHeader([[NAME, { $sesid: SHARED }]]),
      storage,
    });

    expect(outcome).toBe(SharedSessionResumeOutcome.Resumed);
  });
});

describe("resumeSharedSession over a cleared local session", () => {
  const MINUTE = 60_000;
  /** `SessionIdManager.resetSessionId`: sign-out, or a background tab's idle timer. */
  const CLEARED = [null, null, null];
  /** The app tab, still active a minute ago. */
  const APP_ACTIVE: StoredSession = [T0 - MINUTE, "0199-app-active", T0 - HOUR];

  it("resumes the active app session after a background tab's idle timer cleared marketing's", () => {
    // Marketing sat in a background tab; ~33 minutes after its last activity
    // `_resetIdleTimer` cleared its `$sesid`, while the app stayed active.
    const storage = memoryStorage({
      [NAME]: { distinct_id: "anon-marketing", [POSTHOG_SESSION_KEY]: CLEARED },
    });

    const outcome = resumeSharedSession({
      token: TOKEN,
      cookieHeader: cookieHeader([[NAME, { $sesid: APP_ACTIVE }]]),
      storage,
      now: T0,
    });

    expect(outcome).toBe(SharedSessionResumeOutcome.Resumed);
    expect(storage.read(NAME)).toEqual({
      distinct_id: "anon-marketing",
      [POSTHOG_SESSION_KEY]: [...APP_ACTIVE],
    });
  });

  it("counterfactual: the same cookie session is not adopted once it is idle", () => {
    const storage = memoryStorage({
      [NAME]: { [POSTHOG_SESSION_KEY]: CLEARED },
    });

    const outcome = resumeSharedSession({
      token: TOKEN,
      cookieHeader: cookieHeader([[NAME, { $sesid: APP_ACTIVE }]]),
      storage,
      now: T0 + 31 * MINUTE,
    });

    expect(outcome).toBe(SharedSessionResumeOutcome.LocalSessionNotComparable);
    expect(storage.writes).toBe(0);
  });

  it("starts fresh after sign-out, when reset() left the domain cookie cleared too", () => {
    const storage = memoryStorage({
      [NAME]: {
        distinct_id: "anon-after-reset",
        [POSTHOG_SESSION_KEY]: CLEARED,
      },
    });

    const outcome = resumeSharedSession({
      token: TOKEN,
      cookieHeader: cookieHeader([[NAME, { $sesid: CLEARED }]]),
      storage,
      now: T0,
    });

    expect(outcome).toBe(SharedSessionResumeOutcome.NoCookieSession);
    expect(storage.writes).toBe(0);
  });

  it("never resumes from a stale host-only seed alone", () => {
    const storage = memoryStorage({
      [NAME]: { [POSTHOG_SESSION_KEY]: CLEARED },
    });

    const outcome = resumeSharedSession({
      token: TOKEN,
      cookieHeader: cookieHeader([
        [NAME, { $sesid: SEED }],
        [NAME, { $sesid: CLEARED }],
      ]),
      storage,
      now: T0,
    });

    expect(outcome).toBe(SharedSessionResumeOutcome.LocalSessionNotComparable);
    expect(storage.writes).toBe(0);
  });

  it("prefers an active domain session over a host-only seed listed first", () => {
    const storage = memoryStorage({
      [NAME]: { [POSTHOG_SESSION_KEY]: CLEARED },
    });

    const outcome = resumeSharedSession({
      token: TOKEN,
      cookieHeader: cookieHeader([
        [NAME, { $sesid: SEED }],
        [NAME, { $sesid: APP_ACTIVE }],
      ]),
      storage,
      now: T0,
    });

    expect(outcome).toBe(SharedSessionResumeOutcome.Resumed);
    expect(storage.read(NAME)).toEqual({
      [POSTHOG_SESSION_KEY]: [...APP_ACTIVE],
    });
  });
});

describe("postHogPersistenceName", () => {
  it("sanitizes the token the way posthog-js names its record", () => {
    expect(postHogPersistenceName("phc_a+b/c=")).toBe(
      "ph_phc_aPLbSLcEQ_posthog"
    );
    expect(postHogPersistenceName(TOKEN)).toBe(NAME);
  });
});

type MemoryStorage = SharedSessionStorage & {
  writes: number;
  read: (key: string) => unknown;
};

function memoryStorage(records: Record<string, unknown>): MemoryStorage {
  const store = new Map<string, string>(
    Object.entries(records).map(([key, value]) => [key, JSON.stringify(value)])
  );
  const storage: MemoryStorage = {
    writes: 0,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      storage.writes += 1;
      store.set(key, value);
    },
    read: (key) => JSON.parse(store.get(key) ?? "null"),
  };
  return storage;
}

function cookieHeader(
  cookies: readonly (readonly [string, unknown])[]
): string {
  return cookies
    .map(
      ([name, value]) => `${name}=${encodeURIComponent(JSON.stringify(value))}`
    )
    .join("; ");
}
