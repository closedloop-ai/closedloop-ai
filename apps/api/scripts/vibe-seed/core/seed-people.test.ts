import { isStaffEmail } from "@repo/api/src/types/staff-email";
import { LOCAL_TRUSTED_USER_ID } from "@repo/auth/auth-mode";
import { describe, expect, it } from "vitest";
import {
  VIBE_GOLDEN_USERS,
  VIBE_SEED_OWNER,
  VIBE_SEED_SIGNED_IN_PERSON,
  VIBE_SEED_TEAMMATES,
} from "./seed-people";

// ISS-12135: `just vibe-up` signs in as the signed-in person, and Dev Mode (in
// the browser and in the api's override check) is offered only to a staff
// email. The org's owner is a separate, fake-named teammate.
describe("vibe seed people", () => {
  it("signs the session in as the person, on the staff domain", () => {
    expect(VIBE_SEED_SIGNED_IN_PERSON.clerkId).toBe(LOCAL_TRUSTED_USER_ID);
    expect(isStaffEmail(VIBE_SEED_SIGNED_IN_PERSON.email)).toBe(true);
  });

  it("keeps the owner a separate row from the signed-in person", () => {
    expect(VIBE_SEED_OWNER.clerkId).not.toBe(LOCAL_TRUSTED_USER_ID);
    expect(VIBE_SEED_OWNER.email).not.toBe(VIBE_SEED_SIGNED_IN_PERSON.email);
  });

  it("keeps every other seeded person on the reserved example domain", () => {
    for (const person of [
      VIBE_SEED_OWNER,
      ...VIBE_SEED_TEAMMATES,
      ...VIBE_GOLDEN_USERS,
    ]) {
      expect(person.email.endsWith(".example")).toBe(true);
    }
  });
});
