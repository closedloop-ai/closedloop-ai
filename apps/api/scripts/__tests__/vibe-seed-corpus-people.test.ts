/**
 * ISS-12135: the vibe store hands every corpus identity's work to a seeded Acme
 * person by GitHub handle, so each handle must be one the seed creates.
 */
import {
  VIBE_SEED_BRANCH_NAMES,
  VIBE_SEED_CORPUS_HOMES,
  VIBE_SEED_CORPUS_LOGINS,
  VIBE_SEED_MACHINE_NAME,
  VIBE_SEED_SESSION_TITLES,
  VIBE_SEED_SIGNED_IN_LOGIN,
  VIBE_SEED_UNHOMED_LOGIN,
} from "@repo/api/src/vibe-seed-corpus";
import { describe, expect, it } from "vitest";
import { ACME_BASE_SEED } from "../vibe-seed/core/base-seed-github";
import { containsBannedWording } from "../vibe-seed/core/seed-integrity";
import {
  VIBE_SEED_OWNER,
  VIBE_SEED_SIGNED_IN_PERSON,
  VIBE_SEED_TEAMMATES,
} from "../vibe-seed/core/seed-people";

describe("vibe corpus people", () => {
  it("hands corpus work only to people the seed creates", () => {
    const seeded = new Set(
      [VIBE_SEED_SIGNED_IN_PERSON, VIBE_SEED_OWNER, ...VIBE_SEED_TEAMMATES].map(
        (person) => person.githubUsername
      )
    );
    for (const handle of [
      ...Object.values(VIBE_SEED_CORPUS_LOGINS),
      ...Object.values(VIBE_SEED_CORPUS_HOMES),
      VIBE_SEED_UNHOMED_LOGIN,
    ]) {
      expect(seeded, handle).toContain(handle);
    }
  });

  it("signs in as the seeded person whose row the local-trusted stack resolves to", () => {
    expect(VIBE_SEED_SIGNED_IN_LOGIN).toBe(
      VIBE_SEED_SIGNED_IN_PERSON.githubUsername
    );
  });
  it("gives the signed-in person a handle and machines that name no seeded person", () => {
    const names = [
      VIBE_SEED_SIGNED_IN_PERSON,
      VIBE_SEED_OWNER,
      ...VIBE_SEED_TEAMMATES,
    ].flatMap((person) => [
      person.firstName.toLowerCase(),
      person.lastName.toLowerCase(),
    ]);
    for (const value of [
      VIBE_SEED_SIGNED_IN_LOGIN,
      VIBE_SEED_MACHINE_NAME,
      ACME_BASE_SEED.machine,
    ]) {
      for (const name of names) {
        expect(value, value).not.toContain(name);
      }
    }
  });
});

describe("vibe corpus names", () => {
  it("names every rewritten branch and session without test-data wording", () => {
    for (const name of [
      ...VIBE_SEED_BRANCH_NAMES.values(),
      ...VIBE_SEED_SESSION_TITLES.values(),
    ]) {
      expect(containsBannedWording(name), name).toBe(false);
    }
  });
});
