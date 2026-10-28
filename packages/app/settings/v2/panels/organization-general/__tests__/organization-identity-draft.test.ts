import { describe, expect, it } from "vitest";
import {
  normalizeOrgSlug,
  organizationIdentityDraftState,
} from "../organization-identity-draft";

const ORGANIZATION = { name: "Acme", slug: "acme" };
const TOO_SHORT_COPY = /at least 2 characters/;
const RESERVED_COPY = /reserved/;

function draft(
  overrides: Partial<Parameters<typeof organizationIdentityDraftState>[0]> = {}
) {
  return organizationIdentityDraftState({
    canEditName: true,
    canEditSlug: true,
    conflictError: null,
    isSaving: false,
    name: ORGANIZATION.name,
    organization: ORGANIZATION,
    slug: ORGANIZATION.slug,
    ...overrides,
  });
}

describe("normalizeOrgSlug", () => {
  it("lowercases, hyphenates whitespace, strips invalid characters and collapses hyphen runs", () => {
    expect(normalizeOrgSlug("  Acme   Corp!!__ing  ")).toBe("-acme-corping-");
    expect(normalizeOrgSlug("A--B")).toBe("a-b");
  });
});

describe("organizationIdentityDraftState", () => {
  it("reports nothing changed and refuses to save when the draft matches what is stored", () => {
    const state = draft();

    expect(state.changedName).toBeNull();
    expect(state.changedSlug).toBeNull();
    expect(state.canSave).toBe(false);
  });

  it("treats a whitespace-only edit as unchanged rather than as a rename", () => {
    const state = draft({ name: "  Acme  " });

    expect(state.changedName).toBeNull();
    expect(state.canSave).toBe(false);
  });

  it("does not open dirty against a STORED name that carries whitespace", () => {
    // Only the draft used to be trimmed, so a stored "  Acme  " differed from
    // the trimmed draft the moment the form mounted: Save came up enabled and
    // submitted a rename nobody typed.
    const stored = { name: "  Acme  ", slug: "acme" };
    const state = draft({ name: stored.name, organization: stored });

    expect(state.changedName).toBeNull();
    expect(state.canSave).toBe(false);
  });

  it("still detects a real rename away from a stored name that carries whitespace", () => {
    const stored = { name: "  Acme  ", slug: "acme" };
    const state = draft({ name: "Acme Rocketry", organization: stored });

    expect(state.changedName).toBe("Acme Rocketry");
    expect(state.canSave).toBe(true);
  });

  it("sends ONLY the name when only the name moved, so the admin-gated slug branch is never entered", () => {
    const state = draft({ name: "Acme Rocketry" });

    expect(state.changedName).toBe("Acme Rocketry");
    expect(state.changedSlug).toBeNull();
    expect(state.canSave).toBe(true);
  });

  it("sends ONLY the slug when only the slug moved", () => {
    const state = draft({ slug: "acme-rocketry" });

    expect(state.changedName).toBeNull();
    expect(state.changedSlug).toBe("acme-rocketry");
    expect(state.canSave).toBe(true);
  });

  it("refuses to save an emptied name over a real one", () => {
    const state = draft({ name: "   " });

    expect(state.changedName).toBeNull();
    expect(state.canSave).toBe(false);
  });

  it("blocks the save and reports why when the new slug fails the shared schema", () => {
    const state = draft({ slug: "a" });

    expect(state.slugMessage).toMatch(TOO_SHORT_COPY);
    expect(state.canSave).toBe(false);
  });

  it("blocks a reserved slug using the canonical reserved list", () => {
    const state = draft({ slug: "sign-in" });

    expect(state.slugMessage).toMatch(RESERVED_COPY);
    expect(state.canSave).toBe(false);
  });

  it("does not validate an UNTOUCHED slug, so a legacy stored slug cannot block a rename", () => {
    const legacyOrganization = { name: "Acme", slug: "org_2abcDEF" };
    const state = organizationIdentityDraftState({
      canEditName: true,
      canEditSlug: true,
      conflictError: null,
      isSaving: false,
      name: "Acme Rocketry",
      organization: legacyOrganization,
      slug: legacyOrganization.slug,
    });

    expect(state.slugMessage).toBeNull();
    expect(state.changedSlug).toBeNull();
    expect(state.canSave).toBe(true);
  });

  it("never reports a slug change for a non-admin, even when the field value differs", () => {
    const state = draft({ canEditSlug: false, slug: "acme-rocketry" });

    expect(state.changedSlug).toBeNull();
    expect(state.canSave).toBe(false);
  });

  it("surfaces a server conflict and blocks the save until the slug is edited again", () => {
    const conflicted = draft({
      conflictError: "This organization URL is already taken",
      slug: "taken-slug",
    });

    expect(conflicted.slugMessage).toBe(
      "This organization URL is already taken"
    );
    expect(conflicted.canSave).toBe(false);

    const cleared = draft({ conflictError: null, slug: "free-slug" });
    expect(cleared.canSave).toBe(true);
  });

  it("blocks a second submit while the first is still in flight", () => {
    const state = draft({ isSaving: true, name: "Acme Rocketry" });

    expect(state.changedName).toBe("Acme Rocketry");
    expect(state.canSave).toBe(false);
  });
});
