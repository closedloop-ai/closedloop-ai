/**
 * The PEOPLE sort key and the PEOPLE rendered label must be the same string.
 *
 * After ISS-7215 they are produced by two different call paths — the write
 * caches `display_value` (still the sort source for `GET /documents`), and the
 * read derives `displayValue` live — so they can silently diverge. The three
 * axes they can diverge on are pinned here TOGETHER, in one case each, driving
 * `computeDisplayValue` and `toValueDetail` — the two production entry points —
 * rather than the shared formatter they happen to agree through.
 *
 * The write cases pass an explicit map, which is what `prepareValueWrite` does;
 * one case at the end covers the self-resolving fallback instead, so both
 * branches of that parameter are exercised.
 *
 *  1. ORDER. `resolvePeopleNames` used to be an unordered `findMany` that did
 *     not even select `id`, so the write could not reorder to match the read.
 *     The users below are supplied REVERSED for exactly that reason; a test
 *     that supplied them in stored order would agree by construction and kill
 *     nothing.
 *  2. A NAMELESS user, which the write arm drops via `.filter(Boolean)`.
 *  3. A REPEATED id, which `normalizeIdListValue` dedupes before either path
 *     sees it — load-bearing since this change, not defensive.
 */
import type { CustomFieldWithOptions } from "@repo/api/src/types/custom-field";
import { CustomFieldType } from "@repo/api/src/types/custom-field";
import type { BasicUser } from "@repo/api/src/types/user";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  ArtifactType: { DOCUMENT: "DOCUMENT", BRANCH: "BRANCH", SESSION: "SESSION" },
  ArtifactSubtype: { FEATURE: "FEATURE", ISSUE: "ISSUE" },
}));

import { withDb } from "@repo/database";
import { formatPeopleSortKey } from "../display-value";
import { computeDisplayValue } from "../utils";
import type { ValueFromDb } from "../value-projections";
import { toValueDetail } from "../value-projections";

const mockWithDb = withDb as unknown as Mock;

const ORG_ID = "org-1";

const user = (
  id: string,
  firstName: string | null,
  lastName: string | null
): BasicUser => ({
  id,
  email: `${id}@example.com`,
  firstName,
  lastName,
  avatarUrl: null,
});

const ADA = user("u1", "Ada", "Lovelace");
const ALAN = user("u2", "Alan", "Turing");
const NAMELESS = user("u3", null, null);

const peopleField = {
  id: "cf-1",
  organizationId: ORG_ID,
  fieldType: CustomFieldType.People,
  name: "Owner",
  enumOptions: [],
} as unknown as CustomFieldWithOptions;

/** Makes the mocked db return `users` from `user.findMany`, in the given order. */
function stubUsers(users: BasicUser[]): void {
  mockWithDb.mockImplementation((fn: (db: unknown) => unknown) =>
    fn({ user: { findMany: () => Promise.resolve(users) } })
  );
}

/** The map `prepareValueWrite` hands the write path, in the order the db returned. */
function peopleMapOf(users: BasicUser[]): Map<string, BasicUser> {
  return new Map(users.map((u) => [u.id, u]));
}

/** A value row carrying `peopleValueIds`, as the read path would load it. */
function valueRow(
  peopleValueIds: string[],
  storedDisplay: string
): ValueFromDb {
  return {
    id: "v-1",
    customFieldId: "cf-1",
    entityId: "e-1",
    textValue: null,
    numberValue: null,
    dateValue: null,
    enumValueId: null,
    enumValue: null,
    multiEnumValueIds: [],
    peopleValueIds,
    displayValue: storedDisplay,
    references: [],
    customField: {
      id: "cf-1",
      name: "Owner",
      fieldType: CustomFieldType.People,
      showInTable: true,
      enumOptions: [],
    },
  } as unknown as ValueFromDb;
}

/** The read path's answer for the same stored ids and the same resolved users. */
function readDisplayValue(ids: string[], users: BasicUser[]): string | null {
  const peopleMap = new Map(users.map((u) => [u.id, u]));
  return toValueDetail(valueRow(ids, "STALE CACHED STRING"), peopleMap)
    .displayValue;
}

describe("PEOPLE display parity — write cache vs read render", () => {
  beforeEach(() => {
    mockWithDb.mockReset();
  });

  it("agrees on ORDER even when the database returns the users reversed", async () => {
    const storedIds = [ADA.id, ALAN.id];
    // The database is free to return `id IN (...)` rows in any order, and the
    // map the write path receives carries that order.
    const written = await computeDisplayValue(
      peopleField,
      storedIds,
      undefined,
      peopleMapOf([ALAN, ADA])
    );
    const read = readDisplayValue(storedIds, [ALAN, ADA]);

    expect(written).toBe("Ada L., Alan T.");
    expect(read).toBe(written);
  });

  it("agrees when a named person follows a NAMELESS one", async () => {
    const storedIds = [NAMELESS.id, ADA.id];
    const written = await computeDisplayValue(
      peopleField,
      storedIds,
      undefined,
      peopleMapOf([ADA, NAMELESS])
    );
    const read = readDisplayValue(storedIds, [ADA, NAMELESS]);

    // Dropped, not rendered as a leading separator.
    expect(written).toBe("Ada L.");
    expect(read).toBe(written);
  });

  it("agrees when the write resolves the users itself, with no map supplied", async () => {
    // The `peopleById` parameter is optional, so this covers the fallback the
    // other cases skip past.
    const storedIds = [ADA.id];
    stubUsers([ADA]);

    const written = await computeDisplayValue(peopleField, storedIds);
    const read = readDisplayValue(storedIds, [ADA]);

    expect(written).toBe("Ada L.");
    expect(read).toBe(written);
  });

  it("renders a REPEATED id once on each path, so the write dedupe stays load-bearing", async () => {
    // `normalizeIdListValue` dedupes before the write reaches here. If that arm
    // were removed as "defensive", the write would walk [u1, u1] through a keyed
    // lookup and cache "Ada L., Ada L." while the read — whose stored column was
    // deduped by the same normalizer — rendered "Ada L.".
    const dedupedIds = [ADA.id];
    const written = await computeDisplayValue(
      peopleField,
      dedupedIds,
      undefined,
      peopleMapOf([ADA])
    );
    const read = readDisplayValue(dedupedIds, [ADA]);

    expect(written).toBe("Ada L.");
    expect(read).toBe(written);
  });

  it("the rename refresh derives the SAME key the write caches and the read renders", async () => {
    // ISS-8970: `refreshPeopleDisplayValuesForUser` rewrites the cached column
    // through `formatPeopleSortKey` after a user rename. If that helper ever
    // ordered or formatted differently from the two production paths, a rename
    // would sort a row under one string and render it as another.
    const storedIds = [ALAN.id, NAMELESS.id, ADA.id];
    const users = [ADA, NAMELESS, ALAN];
    const written = await computeDisplayValue(
      peopleField,
      storedIds,
      undefined,
      peopleMapOf(users)
    );
    const refreshed = formatPeopleSortKey(storedIds, peopleMapOf(users));
    const read = readDisplayValue(storedIds, users);

    expect(refreshed).toBe("Alan T., Ada L.");
    expect(written).toBe(refreshed);
    expect(read).toBe(refreshed);
  });

  it("agrees that a value whose users no longer resolve is empty, not stale", async () => {
    const storedIds = [ADA.id];
    const written = await computeDisplayValue(
      peopleField,
      storedIds,
      undefined,
      peopleMapOf([])
    );
    const read = readDisplayValue(storedIds, []);

    expect(written).toBe("");
    expect(read).toBe("");
  });
});
