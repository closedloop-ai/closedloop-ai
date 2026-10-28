import type { TestInfo } from "@playwright/test";
import { z } from "zod";

const countSchema = z.number().int().nonnegative().finite();
const readinessSchema = z
  .object({
    dashboardReady: z.boolean().optional(),
    gatewayHealthy: z.boolean().optional(),
    serverAlive: z.boolean().optional(),
    maintenance: z.object({ active: z.boolean() }).nullable().optional(),
    ingest: z
      .object({
        complete: z.boolean().optional(),
        preparing: z.boolean().optional(),
        drained: z.boolean().optional(),
        importParked: z.boolean().optional(),
        timedOut: z.boolean().optional(),
        retriesExhausted: z.boolean().optional(),
        total: countSchema.optional(),
        processed: countSchema.optional(),
        quarantinedCount: countSchema.optional(),
      })
      .nullable()
      .optional(),
  })
  .nullable();
const pageErrorSchema = z.object({ name: z.string(), message: z.string() });

/** Retain only already-read readiness facts; paths, identities and raw errors never reach this attachment. */
export function createReadinessFailureDiagnostic(
  info: Pick<TestInfo, "attach">,
  label: string
) {
  let observations = 0;
  let readiness: z.infer<typeof readinessSchema> = null;
  let validReport = false;
  return {
    observe(value: unknown): void {
      observations += 1;
      const parsed = readinessSchema.safeParse(value);
      validReport = parsed.success;
      readiness = parsed.success ? parsed.data : null;
    },
    async attach(): Promise<void> {
      await info.attach(label, {
        body: Buffer.from(
          JSON.stringify({ observations, validReport, readiness })
        ),
        contentType: "application/json",
      });
    },
  };
}

/** Classify errors collected after firstWindow without retaining their potentially sensitive messages. */
export function classifyDesktopPageError(error: unknown): string {
  const parsed = pageErrorSchema.safeParse(error);
  if (!parsed.success) {
    return "unclassified";
  }
  if (
    parsed.data.message.includes("Failed to fetch dynamically imported module")
  ) {
    return "module-load";
  }
  switch (parsed.data.name) {
    case "ReferenceError":
      return "reference";
    case "SyntaxError":
      return "syntax";
    case "TypeError":
      return "type";
    default:
      return "unclassified";
  }
}
