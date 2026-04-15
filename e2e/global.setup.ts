import { clerkSetup } from "@clerk/testing/playwright";

export default async function globalSetup() {
  const baseURL = process.env.BASE_URL ?? "http://localhost:3000";
  const { hostname } = new URL(baseURL);

  if (hostname !== "localhost" && hostname !== "127.0.0.1") {
    throw new Error(
      "E2E tests must not run against non-localhost targets. " +
        `Received BASE_URL with hostname: "${hostname}". ` +
        "Set BASE_URL to a localhost address (e.g. http://localhost:3000)."
    );
  }

  await clerkSetup();
}
