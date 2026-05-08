import type { Page } from "@playwright/test";

type ClerkWindow = Window & {
  Clerk?: {
    session?: {
      getToken?: () => Promise<string | null>;
    } | null;
  };
};

// Extract a Clerk session JWT from an authenticated page so cross-origin API
// helpers (against the api-* subdomain) can attach Authorization: Bearer <jwt>.
// The page must already have completed authenticateToApp() — Clerk's client
// SDK only resolves a session token after sign-in.
export async function getClerkBearerToken(page: Page): Promise<string> {
  const token = await page.evaluate(async () => {
    const clerk = (window as ClerkWindow).Clerk;
    return (await clerk?.session?.getToken?.()) ?? null;
  });
  if (!token) {
    throw new Error(
      "Could not extract Clerk session token from page. Call authenticateToApp() first."
    );
  }
  return token;
}
