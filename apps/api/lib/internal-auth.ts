import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/env";

/**
 * Validate the x-internal-secret header using constant-time comparison.
 * Returns true if the header matches the configured INTERNAL_API_SECRET.
 */
export function validateInternalSecret(request: Request): boolean {
  const internalSecret = env.INTERNAL_API_SECRET;
  const headerSecret = request.headers.get("x-internal-secret");
  if (!(internalSecret && headerSecret)) {
    return false;
  }
  const digestKey = "api-constant-time-compare";
  const expectedDigest = createHmac("sha256", digestKey)
    .update(internalSecret, "utf8")
    .digest();
  const actualDigest = createHmac("sha256", digestKey)
    .update(headerSecret, "utf8")
    .digest();
  return timingSafeEqual(expectedDigest, actualDigest);
}
