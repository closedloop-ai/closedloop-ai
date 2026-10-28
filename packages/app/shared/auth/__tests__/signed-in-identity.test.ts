import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  observeSignedInIdentity,
  resetObservedSignedInIdentityForTests,
  watchSignedInIdentity,
} from "../signed-in-identity";

const FIRST = { userId: "user-first", organizationId: "org-first" };
const disposers: Array<() => void> = [];

beforeEach(resetObservedSignedInIdentityForTests);
afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
  resetObservedSignedInIdentityForTests();
});

function watch() {
  const watcher = watchSignedInIdentity();
  disposers.push(watcher.dispose);
  return watcher;
}

describe("watchSignedInIdentity", () => {
  it("stays current across the seed and an identical observation", () => {
    const watcher = watch();
    observeSignedInIdentity(FIRST);
    observeSignedInIdentity({ ...FIRST });
    expect(watcher.isCurrent()).toBe(true);
  });

  it.each([
    { ...FIRST, userId: "user-other" },
    { ...FIRST, organizationId: "org-other" },
  ])("goes stale on either identity key and never revives (%j)", (other) => {
    observeSignedInIdentity(FIRST);
    const first = watch();
    observeSignedInIdentity(other);
    const second = watch();
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);
    observeSignedInIdentity(FIRST);
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(false);
    expect(watch().isCurrent()).toBe(true);
  });

  it("stops listening once disposed", () => {
    observeSignedInIdentity(FIRST);
    const watcher = watchSignedInIdentity();
    watcher.dispose();
    observeSignedInIdentity({ ...FIRST, userId: "user-other" });
    expect(watcher.isCurrent()).toBe(true);
  });
});
