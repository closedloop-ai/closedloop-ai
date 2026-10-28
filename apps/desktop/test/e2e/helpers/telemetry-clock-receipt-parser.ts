import { z } from "zod";

const marker = "CLOSEDLOOP_TELEMETRY_TEST_CLOCK ";
const maximumLineBytes = 65_536;
const receiptSchema = z.object({
  qualification: z.object({
    sourceQualified: z.literal(true),
    canonicalCadence: z.literal(15_000),
    moduleRelative: z.string().min(1),
    ownerClass: z.literal("ClaudeCodeTelemetrySyncService"),
    ownerMethod: z.literal("start"),
    noPrecomputedLocationOrHash: z.literal(true),
  }),
  ownerRegistered: z.literal(true),
  originalNativeHandleRetained: z.literal(true),
  hasRef: z.literal(false),
  cleared: z.literal(true),
  advances: z.literal(2),
  actualCallbacks: z.literal(2),
  completionPending: z.literal(false),
  errors: z.array(z.unknown()).length(0),
  virtualTimersRemaining: z.literal(0),
  dateIdentityUnchanged: z.literal(true),
  dropped: z.literal(0),
});

/** Parse only bounded telemetry receipts, retaining missing or malformed evidence. */
export function createTelemetryReceiptParser() {
  let partial = "",
    discardLine = false,
    value: unknown,
    receiptCount = 0;
  const faults: string[] = [];
  const fault = (kind: string): void => {
    if (faults.length < 8) {
      faults.push(kind);
    }
  };
  function append(part: string): void {
    if (discardLine) {
      return;
    }
    const next = partial + part;
    if (Buffer.byteLength(next) > maximumLineBytes) {
      if (next.startsWith(marker)) {
        fault("oversized-clock-receipt");
      }
      partial = "";
      discardLine = true;
      return;
    }
    partial = next;
  }
  function endLine(): void {
    if (!discardLine && partial.startsWith(marker)) {
      receiptCount += 1;
      if (receiptCount !== 1) {
        fault("duplicate-clock-receipt");
      }
      try {
        value = JSON.parse(partial.slice(marker.length));
      } catch {
        fault("invalid-clock-receipt-json");
      }
    }
    partial = "";
    discardLine = false;
  }
  return {
    write(chunk: Buffer | string): void {
      const pieces = chunk.toString().split("\n");
      for (let index = 0; index < pieces.length; index += 1) {
        append(pieces[index]);
        if (index < pieces.length - 1) {
          endLine();
        }
      }
    },
    finish(): void {
      if (receiptCount !== 1) {
        fault("missing-clock-exit-receipt");
      }
    },
    fault,
    result() {
      const parsed = receiptSchema.safeParse(value);
      return {
        valid: parsed.success,
        faults: faults.slice(),
        receipt: parsed.success ? parsed.data : null,
      };
    },
  };
}
