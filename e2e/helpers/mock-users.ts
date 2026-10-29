import { ApproverRole, type User } from "@repo/api/src/types/user";

// Shared mock-response helpers for specs that intercept the app shell's API reads
// (`/me`, branch-view, …). Previously copy-pasted across the branch-view family of
// specs; consolidated here so a new spec reuses them instead of adding a copy.

// Wrap data in the `{ success, data }` envelope the API client unwraps.
export function success<T>(data: T) {
  return { data, success: true };
}

// Deterministic synthetic current user for `**/me` mocks. Pass `overrides` for the
// few fields specs vary (e.g. `githubUsername`).
export function currentUser(overrides: Partial<User> = {}): User {
  const now = new Date();
  return {
    active: true,
    avatarUrl: null,
    clerkId: "clerk-e2e-user",
    createdAt: now,
    email: "e2e@example.com",
    firstName: "E2E",
    githubUsername: null,
    id: "user-e2e",
    lastName: "User",
    linearId: null,
    organizationId: "org-e2e",
    phoneNumber: null,
    role: ApproverRole.Engineer,
    slackId: null,
    updatedAt: now,
    ...overrides,
  };
}
