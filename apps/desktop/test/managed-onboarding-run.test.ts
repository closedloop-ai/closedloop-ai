import assert from "node:assert/strict";
import { test } from "node:test";
import { ManagedOnboardingRunTracker } from "../src/main/managed-onboarding-run.js";

test("managed onboarding run token remains current until cancelled", () => {
  const tracker = new ManagedOnboardingRunTracker();
  const run = tracker.begin();

  assert.equal(tracker.isCurrent(run), true);
  assert.equal(tracker.isCancelled(run), false);

  tracker.cancel();

  assert.equal(tracker.isCurrent(run), false);
  assert.equal(tracker.isCancelled(run), true);
});

test("starting a new managed onboarding run invalidates older async work", () => {
  const tracker = new ManagedOnboardingRunTracker();
  const first = tracker.begin();
  const second = tracker.begin();

  assert.equal(tracker.isCancelled(first), true);
  assert.equal(tracker.isCurrent(second), true);
});

test("external cancellation participates in managed onboarding run checks", () => {
  const tracker = new ManagedOnboardingRunTracker();
  const run = tracker.begin();

  assert.equal(tracker.isCancelled(run, false), false);
  assert.equal(tracker.isCancelled(run, true), true);
});
