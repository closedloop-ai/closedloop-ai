import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { SEED_SCHEMA_TIMEOUT_MS } from "./desktop-seed-core";

const execFileAsync = promisify(execFile);
const initializerScript = fileURLToPath(
  new URL("../../support/initialize-profile-schema.ts", import.meta.url)
);
const sha256Pattern = /^[a-f0-9]{64}$/;
const receiptSchema = z.object({
  migrations: z.array(z.object({ name: z.string(), checksum: z.string() })),
  schemaContractSha256: z.string().regex(sha256Pattern),
  outcome: z.object({
    applied: z.array(z.string()),
    baselined: z.array(z.string()),
    rebaselined: z.array(z.string()),
  }),
});

/** Initializes only schema in an existing caller-owned profile; preserves its lifetime. */
export async function initializeDesktopProfileSchema(userDataDir: string) {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), initializerScript, userDataDir],
    {
      timeout: SEED_SCHEMA_TIMEOUT_MS,
      // Only a bounded migration receipt is expected, never database rows or private values.
      maxBuffer: 1024 * 1024,
    }
  );
  return receiptSchema.parse(JSON.parse(stdout));
}
