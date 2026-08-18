import { getPrismaErrorCode } from "@/lib/db-utils";

/** Retry one client-identified trace-comment write after a concurrent dedupe race. */
export async function runIdempotentTraceWrite<T>(
  clientId: string | null,
  run: () => Promise<T>
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!clientId || getPrismaErrorCode(error) !== "P2002") {
      throw error;
    }
    return run();
  }
}
