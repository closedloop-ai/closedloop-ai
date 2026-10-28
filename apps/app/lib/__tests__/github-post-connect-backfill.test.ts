import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimPostConnectBackfill,
  getPostConnectBackfillClaims,
  MAX_CLAIMED_ORGS,
  resetPostConnectBackfillClaims,
  subscribePostConnectBackfillClaims,
} from "../github-post-connect-backfill";

describe("claimPostConnectBackfill", () => {
  afterEach(() => {
    resetPostConnectBackfillClaims();
  });

  it("returns true for the first claim on an org", () => {
    expect(claimPostConnectBackfill("acme")).toBe(true);
  });

  it("returns false for a second claim on the same org", () => {
    claimPostConnectBackfill("acme");

    expect(claimPostConnectBackfill("acme")).toBe(false);
  });

  it("claims independently per org", () => {
    expect(claimPostConnectBackfill("acme")).toBe(true);
    expect(claimPostConnectBackfill("globex")).toBe(true);
  });

  it("notifies subscribed listeners on a successful claim", () => {
    const listener = vi.fn();
    const unsubscribe = subscribePostConnectBackfillClaims(listener);

    claimPostConnectBackfill("acme");

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("stops notifying a listener after it unsubscribes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribePostConnectBackfillClaims(listener);
    unsubscribe();

    claimPostConnectBackfill("acme");

    expect(listener).not.toHaveBeenCalled();
  });

  it("evicts the oldest claim once MAX_CLAIMED_ORGS is exceeded", () => {
    for (let i = 0; i < MAX_CLAIMED_ORGS; i++) {
      claimPostConnectBackfill(`org-${i}`);
    }
    expect(getPostConnectBackfillClaims().has("org-0")).toBe(true);

    claimPostConnectBackfill("org-overflow");

    expect(getPostConnectBackfillClaims().has("org-0")).toBe(false);
    expect(getPostConnectBackfillClaims().has("org-overflow")).toBe(true);
    expect(getPostConnectBackfillClaims().size).toBe(MAX_CLAIMED_ORGS);
  });
});

describe("resetPostConnectBackfillClaims", () => {
  it("clears every claim so a previously-claimed org can claim again", () => {
    claimPostConnectBackfill("acme");

    resetPostConnectBackfillClaims();

    expect(claimPostConnectBackfill("acme")).toBe(true);
    resetPostConnectBackfillClaims();
  });

  it("notifies subscribed listeners", () => {
    const listener = vi.fn();
    const unsubscribe = subscribePostConnectBackfillClaims(listener);

    resetPostConnectBackfillClaims();

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
