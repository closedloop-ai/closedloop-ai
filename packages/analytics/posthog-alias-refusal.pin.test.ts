/**
 * ISS-10503 (PRD-736 D5, resolved decision #13): pins the PostHog behavior the
 * alias handshake leans on — a second alias of the SAME onboarding id onto a
 * DIFFERENT identified person is refused, which is why the design declines a
 * single-use consumption marker: an attacker who races a victim's onboarding id
 * to authentication gains a few enum-only events on their own person, and the
 * victim's own later alias is what PostHog refuses to cross-merge.
 *
 * Aliases are resolved inside PostHog's ingestion pipeline, so no local mock
 * can answer for this — the case talks to a REAL PostHog project and runs only
 * when the pinning credentials are supplied (skipped otherwise, including in
 * CI):
 *
 *   POSTHOG_ALIAS_PIN_PROJECT_KEY  – project API key (phc_…), used to ingest
 *   POSTHOG_ALIAS_PIN_PERSONAL_KEY – personal API key, used to read persons
 *   POSTHOG_ALIAS_PIN_PROJECT_ID   – numeric project id for the persons read
 *   POSTHOG_ALIAS_PIN_HOST         – optional; defaults to https://us.i.posthog.com
 *
 * Run: POSTHOG_ALIAS_PIN_PROJECT_KEY=… POSTHOG_ALIAS_PIN_PERSONAL_KEY=… \
 *      POSTHOG_ALIAS_PIN_PROJECT_ID=… pnpm -C packages/analytics exec vitest run \
 *      posthog-alias-refusal.pin.test.ts
 */
import { randomUUID } from "node:crypto";
import { PostHog } from "posthog-node";
import { describe, expect, it } from "vitest";

const PROJECT_KEY = process.env.POSTHOG_ALIAS_PIN_PROJECT_KEY;
const PERSONAL_KEY = process.env.POSTHOG_ALIAS_PIN_PERSONAL_KEY;
const PROJECT_ID = process.env.POSTHOG_ALIAS_PIN_PROJECT_ID;
const HOST = process.env.POSTHOG_ALIAS_PIN_HOST ?? "https://us.i.posthog.com";

const CREDENTIALS_PRESENT = Boolean(PROJECT_KEY && PERSONAL_KEY && PROJECT_ID);

/** Ingestion is eventually consistent; poll the persons read until it settles. */
const INGESTION_POLL_INTERVAL_MS = 5000;
const INGESTION_POLL_DEADLINE_MS = 120_000;
const TEST_TIMEOUT_MS = 3 * 60_000;

describe.skipIf(!CREDENTIALS_PRESENT)(
  "PostHog alias refusal (PRD-736 decision #13 pin)",
  () => {
    it("refuses a second alias of the same onboarding id onto a different identified person", {
      timeout: TEST_TIMEOUT_MS,
    }, async () => {
      const onboardingId = randomUUID();
      const victim = `pin-victim-${randomUUID()}`;
      const attacker = `pin-attacker-${randomUUID()}`;
      const client = new PostHog(PROJECT_KEY as string, {
        host: HOST,
        flushAt: 1,
        flushInterval: 0,
      });

      try {
        // Both parties are IDENTIFIED persons before the contested alias.
        client.identify({ distinctId: victim, properties: { pin: true } });
        client.identify({ distinctId: attacker, properties: { pin: true } });
        // The victim's legitimate alias lands first.
        client.alias({ distinctId: victim, alias: onboardingId });
        await client.flush();
        await pollUntil(async () => {
          const ids = await personDistinctIds(onboardingId);
          return ids?.includes(victim) === true;
        });

        // The attack: the same onboarding id aliased onto another identified
        // person. PostHog must not cross-merge the two persons.
        client.alias({ distinctId: attacker, alias: onboardingId });
        await client.flush();
        // Refusal is the ABSENCE of a merge, so give ingestion one full
        // window to (wrongly) apply it before asserting it did not.
        await sleep(INGESTION_POLL_DEADLINE_MS / 4);

        const victimIds = await personDistinctIds(victim);
        expect(victimIds).toContain(onboardingId);
        expect(victimIds).not.toContain(attacker);
        const attackerIds = await personDistinctIds(attacker);
        expect(attackerIds).not.toContain(onboardingId);
        expect(attackerIds).not.toContain(victim);
      } finally {
        await client.shutdown();
      }
    });
  }
);

async function personDistinctIds(distinctId: string): Promise<string[] | null> {
  const url = new URL(
    `/api/projects/${PROJECT_ID}/persons/`,
    HOST.replace(".i.posthog.com", ".posthog.com")
  );
  url.searchParams.set("distinct_id", distinctId);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${PERSONAL_KEY}` },
  });
  if (!response.ok) {
    return null;
  }
  const body = (await response.json()) as {
    results?: Array<{ distinct_ids?: string[] }>;
  };
  return body.results?.[0]?.distinct_ids ?? null;
}

async function pollUntil(probe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + INGESTION_POLL_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (await probe()) {
      return;
    }
    await sleep(INGESTION_POLL_INTERVAL_MS);
  }
  throw new Error(
    "PostHog ingestion did not settle within the polling deadline"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
