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

  // clerkSetup() fetches a testing token from Clerk using the publishable key.
  // The token is then injected per-page by setupClerkTestingToken() to bypass 2FA and bot detection.
  await clerkSetup();
}
