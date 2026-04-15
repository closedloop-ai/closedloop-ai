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

  // clerkSetup() configures the Clerk testing SDK for local dev (requires
  // CLERK_PUBLISHABLE_KEY from .env.local). In CI against remote environments,
  // the app already has Clerk configured — skip the SDK and sign in with real credentials.
  if (!process.env.CI) {
    await clerkSetup();
  }
}
