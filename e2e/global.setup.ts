import { clerkSetup } from "@clerk/testing/playwright";

export default async function globalSetup() {
  const baseURL = process.env.BASE_URL ?? "http://localhost:3000";
  const { hostname } = new URL(baseURL);

  // In CI, allow non-localhost targets (e.g. Vercel preview URLs).
  // Locally, restrict to localhost to prevent accidental runs against production.
  if (!process.env.CI && hostname !== "localhost" && hostname !== "127.0.0.1") {
    throw new Error(
      "E2E tests must not run against non-localhost targets outside CI. " +
        `Received BASE_URL with hostname: "${hostname}". ` +
        "Set BASE_URL to a localhost address (e.g. http://localhost:3000) " +
        "or set CI=true for remote targets."
    );
  }

  // clerkSetup() fetches a testing token from Clerk's Backend API using the secret key,
  // then sets CLERK_FAPI and CLERK_TESTING_TOKEN in process.env. These propagate to
  // worker processes where setupClerkTestingToken() intercepts Clerk API requests to
  // bypass 2FA and bot detection.
  await clerkSetup({ debug: true });

  // Verify the token was actually fetched — fail fast instead of hanging on factor-two.
  if (!process.env.CLERK_TESTING_TOKEN) {
    throw new Error(
      "clerkSetup() did not produce a CLERK_TESTING_TOKEN. " +
        "Verify CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY are set correctly."
    );
  }
}
