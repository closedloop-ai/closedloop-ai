import assert from "node:assert/strict";
import { FeatureAssignmentDelivery } from "@repo/api/src/types/feature-assignment-delivery";
import { describe, test } from "vitest";
import { createDesktopMainFeatureFlagAssignmentStore } from "../src/main/auth/desktop-feature-flag-assignment.js";

const KEY = "artifact-status-root-order";

const assignmentFor = (userId: string, flags: Record<string, boolean>) => ({
  userId,
  resolved: true,
  flags,
});

describe("Desktop main feature-flag assignment (ISS-9437)", () => {
  test("is CLOSED before anything resolves", () => {
    const store = createDesktopMainFeatureFlagAssignmentStore({
      retryDelaysMs: [],
      fetchAssignment: () => Promise.resolve(null),
    });

    // Unresolved is not "no opinion" — it is the closed answer main's readers
    // get, so a page built before the account's assignment lands keeps today's
    // order rather than a half-applied one.
    assert.equal(store.isEnabled(KEY), false);
    assert.equal(store.read().delivery, FeatureAssignmentDelivery.Pending);
  });

  test("adopts the signed-in account's verdict", async () => {
    const store = createDesktopMainFeatureFlagAssignmentStore({
      retryDelaysMs: [],
      fetchAssignment: () =>
        Promise.resolve(assignmentFor("user-1", { [KEY]: true })),
    });

    await store.resolveFor("user-1");

    assert.equal(store.isEnabled(KEY), true);
    assert.equal(store.read().delivery, FeatureAssignmentDelivery.Assigned);
  });

  test("re-resolves at an account switch instead of serving the previous account's verdict", async () => {
    const flagsByUser: Record<string, Record<string, boolean>> = {
      "user-1": { [KEY]: true },
      "user-2": {},
    };
    let subject = "user-1";
    const store = createDesktopMainFeatureFlagAssignmentStore({
      retryDelaysMs: [],
      fetchAssignment: () =>
        Promise.resolve(assignmentFor(subject, flagsByUser[subject] ?? {})),
    });

    await store.resolveFor("user-1");
    assert.equal(store.isEnabled(KEY), true);

    subject = "user-2";
    await store.resolveFor("user-2");

    // The next account's own answer, not the previous one's. `user-2` has the
    // key closed, so a store that kept `user-1`'s verdict would report it open.
    assert.equal(store.isEnabled(KEY), false);
    assert.equal(store.read().subject, "user-2");
  });

  test("clears synchronously so no window reads the previous account's flags", () => {
    const store = createDesktopMainFeatureFlagAssignmentStore({
      retryDelaysMs: [],
      fetchAssignment: () =>
        Promise.resolve(assignmentFor("user-2", { [KEY]: true })),
    });
    const pending = store.resolveFor("user-2");

    // The read happens BEFORE the lookup settles, which is the window an
    // `await`-only test would never enter.
    assert.equal(store.isEnabled(KEY), false);
    return pending;
  });

  test("refuses an assignment evaluated for a different account", async () => {
    const store = createDesktopMainFeatureFlagAssignmentStore({
      retryDelaysMs: [],
      fetchAssignment: () =>
        Promise.resolve(assignmentFor("someone-else", { [KEY]: true })),
    });

    await store.resolveFor("user-1");

    assert.equal(store.isEnabled(KEY), false);
    assert.equal(
      store.read().delivery,
      FeatureAssignmentDelivery.IdentityMismatch
    );
  });

  test("closes on a signed-out subject, a rejected read, and a malformed payload", async () => {
    const signedOut = createDesktopMainFeatureFlagAssignmentStore({
      retryDelaysMs: [],
      fetchAssignment: () => Promise.reject(new Error("should not be called")),
    });
    await signedOut.resolveFor(null);
    assert.equal(signedOut.isEnabled(KEY), false);
    assert.equal(
      signedOut.read().delivery,
      FeatureAssignmentDelivery.Unavailable
    );

    const rejected = createDesktopMainFeatureFlagAssignmentStore({
      retryDelaysMs: [],
      fetchAssignment: () => Promise.reject(new Error("offline")),
    });
    await rejected.resolveFor("user-1");
    assert.equal(rejected.isEnabled(KEY), false);
    assert.equal(
      rejected.read().delivery,
      FeatureAssignmentDelivery.EvaluationFailed
    );

    const malformed = createDesktopMainFeatureFlagAssignmentStore({
      retryDelaysMs: [],
      fetchAssignment: () =>
        Promise.resolve({ userId: "user-1", resolved: true, flags: "nope" }),
    });
    await malformed.resolveFor("user-1");
    assert.equal(malformed.isEnabled(KEY), false);
    assert.equal(
      malformed.read().delivery,
      FeatureAssignmentDelivery.Malformed
    );
  });

  test("cannot be overwritten by a slower reply from a previous resolve", async () => {
    let release: (value: unknown) => void = () => {
      // replaced on the first call below
    };
    const replies: Promise<unknown>[] = [
      new Promise((resolve) => {
        release = resolve;
      }),
      Promise.resolve(assignmentFor("user-1", {})),
    ];
    let call = 0;
    const store = createDesktopMainFeatureFlagAssignmentStore({
      retryDelaysMs: [],
      fetchAssignment: () => replies[call++] ?? Promise.resolve(null),
    });

    const stale = store.resolveFor("user-1");
    await store.resolveFor("user-1");
    // The FIRST lookup answers last, and with an OPEN flag. Correlating on the
    // subject alone would accept it — signing back into the same account while
    // the first lookup is in flight passes that check — so the store is
    // generation-guarded instead.
    release(assignmentFor("user-1", { [KEY]: true }));
    await stale;

    assert.equal(store.isEnabled(KEY), false);
  });

  test("notifies subscribers when a verdict settles, and stops after unsubscribe", async () => {
    const store = createDesktopMainFeatureFlagAssignmentStore({
      retryDelaysMs: [],
      fetchAssignment: () =>
        Promise.resolve(assignmentFor("user-1", { [KEY]: true })),
    });
    let settles = 0;
    const unsubscribe = store.subscribe(() => {
      settles += 1;
    });

    await store.resolveFor("user-1");

    // ISS-8792: a boot-time consumer (the Routines daemon) is answered CLOSED
    // before the account is known, so the settle notification is the only thing
    // that can release its decision. Read through the store rather than a
    // payload, so there is no second copy of the verdict to drift.
    //
    // TWO notifications per resolve, not one, and both are load-bearing: the
    // synchronous CLEAR at the account boundary (asserted on its own below),
    // then the verdict settling. This count was 1 until the clear began
    // notifying — see that case for why a consumer must hear the clear.
    assert.equal(settles, 2);
    assert.equal(store.isEnabled(KEY), true);

    unsubscribe();
    await store.resolveFor("user-1");

    assert.equal(settles, 2, "no notification after unsubscribe");
  });

  test("notifies on the account clear, before the next assignment lands", async () => {
    // The mirror of the settle notification. `resolveFor` clears synchronously
    // so no window reads the previous account's flags — but a main consumer
    // that ACTS on a verdict only learns of a change when it is told. Without
    // this the Routines daemon kept running for the whole of the new account's
    // lookup (the 10s request timeout plus its retries) while the renderer had
    // already withdrawn the route.
    let release: (value: unknown) => void = () => {
      // replaced on the second call below
    };
    let call = 0;
    const store = createDesktopMainFeatureFlagAssignmentStore({
      retryDelaysMs: [],
      fetchAssignment: () => {
        call += 1;
        if (call === 1) {
          return Promise.resolve(assignmentFor("user-1", { [KEY]: true }));
        }
        // The SECOND account's lookup is held open, so the assertions below
        // land in the window this case exists to measure.
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    await store.resolveFor("user-1");
    // Open first, so the close asserted below is a real transition rather than
    // the store's already-closed initial state.
    assert.equal(store.isEnabled(KEY), true);

    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    const pending = store.resolveFor("user-2");

    // Notified, and the verdict is already closed — WITHOUT the fetch having
    // resolved. An implementation that notified only from `settle` scores 0
    // here and leaves the consumer acting on the previous account's answer.
    assert.equal(notifications, 1);
    assert.equal(store.isEnabled(KEY), false);

    release(assignmentFor("user-2", {}));
    await pending;
  });

  test("one throwing subscriber does not strand the others", async () => {
    const store = createDesktopMainFeatureFlagAssignmentStore({
      retryDelaysMs: [],
      fetchAssignment: () =>
        Promise.resolve(assignmentFor("user-1", { [KEY]: true })),
    });
    let reached = false;
    store.subscribe(() => {
      throw new Error("consumer fault");
    });
    store.subscribe(() => {
      reached = true;
    });

    await store.resolveFor("user-1");

    assert.equal(reached, true);
  });

  test("retries a transport failure and adopts the reply that succeeds", async () => {
    // ISS-8792: `resolveFor` runs only on an account boundary, so without this
    // a single failed request would settle THIS process closed for the whole
    // session while the renderer — which fetches separately — resolved open.
    // That is the two-processes-disagree defect returning by the failure path.
    let calls = 0;
    const store = createDesktopMainFeatureFlagAssignmentStore({
      retryDelaysMs: [0, 0],
      fetchAssignment: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(new Error("transport"));
        }
        return Promise.resolve(assignmentFor("user-1", { [KEY]: true }));
      },
    });

    await store.resolveFor("user-1");

    assert.equal(calls, 2);
    assert.equal(store.isEnabled(KEY), true);
    assert.equal(store.read().delivery, FeatureAssignmentDelivery.Assigned);
  });

  test("retries the PRODUCTION failure sentinel, not just a rejection", async () => {
    // `fetchDesktopFeatureFlags` resolves `null` on every transport, timeout,
    // response, and schema failure — it never rejects. So the rejection-driven
    // case above proved the retry only for an input production cannot produce:
    // a `null` counted as success, broke the loop on the first attempt, and the
    // advertised retry never ran in the shipped app.
    let calls = 0;
    const store = createDesktopMainFeatureFlagAssignmentStore({
      retryDelaysMs: [0, 0],
      fetchAssignment: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve(null);
        }
        return Promise.resolve(assignmentFor("user-1", { [KEY]: true }));
      },
    });

    await store.resolveFor("user-1");

    assert.equal(calls, 2);
    assert.equal(store.isEnabled(KEY), true);
    assert.equal(store.read().delivery, FeatureAssignmentDelivery.Assigned);
  });

  test("gives up CLOSED on a sentinel that never succeeds", async () => {
    // The bound still holds for the sentinel path, and the classification is
    // the same one `readFeatureAssignment(null)` would have produced, so
    // retrying changes WHEN main gives up, never WHAT it reports.
    let calls = 0;
    const store = createDesktopMainFeatureFlagAssignmentStore({
      retryDelaysMs: [0, 0],
      fetchAssignment: () => {
        calls += 1;
        return Promise.resolve(null);
      },
    });

    await store.resolveFor("user-1");

    assert.equal(calls, 3);
    assert.equal(store.isEnabled(KEY), false);
    assert.equal(
      store.read().delivery,
      FeatureAssignmentDelivery.EvaluationFailed
    );
  });

  test("gives up CLOSED once the bounded retries are spent", async () => {
    let calls = 0;
    const store = createDesktopMainFeatureFlagAssignmentStore({
      retryDelaysMs: [0, 0],
      fetchAssignment: () => {
        calls += 1;
        return Promise.reject(new Error("transport"));
      },
    });

    await store.resolveFor("user-1");

    // Bounded: the initial attempt plus one per delay, then it stops rather
    // than talking to the network forever on an offline launch.
    assert.equal(calls, 3);
    assert.equal(store.isEnabled(KEY), false);
    assert.equal(
      store.read().delivery,
      FeatureAssignmentDelivery.EvaluationFailed
    );
  });
});
