/**
 * Schema-safety guard for the seed.
 *
 * When a non-public target schema is requested, asserts the connection actually
 * resolves to that schema before any write — preventing accidental writes into
 * `public` on a shared RDS if the search_path was not applied (the FEA-1332
 * HIGH-bug failure mode). No-op when no specific schema is targeted.
 *
 * The probe runs through the same pg pool the seed writes use, so
 * `current_schema()` reflects the session `search_path` set by the pool's
 * `options: -c search_path=<schema>`. The PrismaPg `{schema}` qualification and
 * that search_path are both derived from the same target schema, so a passing
 * probe means both unqualified and schema-qualified writes target it.
 *
 * Extracted from seed.ts (whose top-level `main()` auto-runs) so it can be unit
 * tested in isolation.
 */
import type { PrismaClient } from "../../generated/client";
import { SeedSetupFailureMarker } from "./setup-failure";

export async function assertEffectiveSchema(
  prisma: PrismaClient,
  expectedSchema: string | null
): Promise<void> {
  if (!expectedSchema || expectedSchema === "public") {
    return;
  }
  const rows = await prisma.$queryRaw<
    { current_schema: string | null }[]
  >`SELECT current_schema() AS current_schema`;
  const effective = rows[0]?.current_schema ?? null;
  if (effective !== expectedSchema) {
    throw new Error(
      `${SeedSetupFailureMarker.SchemaGuard}: expected to seed into schema "${expectedSchema}" but the connection resolves to "${effective ?? "<none>"}". Refusing to seed to avoid writing into the wrong schema.`
    );
  }
}
