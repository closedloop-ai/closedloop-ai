import arcjet, {
  type ArcjetBotCategory,
  type ArcjetWellKnownBot,
  detectBot,
  request,
  shield,
  slidingWindow,
} from "@arcjet/next";
import { keys } from "./keys";

const arcjetKey = keys().ARCJET_KEY;

export const secure = async (
  allow: (ArcjetWellKnownBot | ArcjetBotCategory)[],
  sourceRequest?: Request
) => {
  if (!arcjetKey) {
    return;
  }

  const base = arcjet({
    // Get your site key from https://app.arcjet.com
    key: arcjetKey,
    // Identify the user by their IP address
    characteristics: ["ip.src"],
    rules: [
      // Protect against common attacks with Arcjet Shield
      shield({
        // Will block requests. Use "DRY_RUN" to log only
        mode: "LIVE",
      }),
      // Other rules are added in different routes
    ],
  });

  const req = sourceRequest ?? (await request());
  const aj = base.withRule(detectBot({ mode: "LIVE", allow }));
  const decision = await aj.protect(req);

  if (decision.isDenied()) {
    if (decision.reason.isBot()) {
      throw new Error("No bots allowed");
    }

    if (decision.reason.isRateLimit()) {
      throw new Error("Rate limit exceeded");
    }

    throw new Error("Access denied");
  }
};

export const rateLimit = async (
  customKey: string,
  max: number,
  window: string,
  sourceRequest?: Request
) => {
  if (!arcjetKey) {
    return;
  }

  const base = arcjet({
    key: arcjetKey,
    // Define a stable custom characteristic name and pass its dynamic value in protect().
    characteristics: ["rateLimitKey"],
    rules: [
      shield({
        mode: "LIVE",
      }),
      slidingWindow({
        mode: "LIVE",
        max,
        interval: window,
      }),
    ],
  });

  const req = sourceRequest ?? (await request());
  const decision = await base.protect(req, { rateLimitKey: customKey });

  if (decision.isDenied()) {
    if (decision.reason.isRateLimit()) {
      throw new Error("Rate limit exceeded");
    }

    throw new Error("Access denied");
  }
};
