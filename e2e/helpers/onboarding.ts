import type { APIRequestContext } from "@playwright/test";
import { getApiBaseUrl } from "./api-url";

// Persist `wizardCompletedAt` server-side. The route's `wizardCompleted` flag
// otherwise falls back to `teamCount > 0 && projectCount > 0`, so a test that
// deletes its last team or project flips the flag to false and redirects every
// subsequent route to /onboarding. Calling complete-wizard unconditionally —
// even when GET /onboarding currently reports wizardCompleted=true via the
// legacy fallback — is what guarantees the timestamp gets written on first
// run for orgs that have never been through the wizard. The endpoint is
// idempotent for this caller (we don't pass createdTeamId/createdProjectId,
// so the merge just overwrites the timestamp).
export async function ensureWizardCompleted(
  request: APIRequestContext,
  token: string
): Promise<void> {
  const api = getApiBaseUrl();
  const response = await request.put(`${api}/onboarding/complete-wizard`, {
    data: {},
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok()) {
    throw new Error(
      `Failed to mark onboarding wizard complete: ${response.status()} ${response.statusText()}`
    );
  }
}
