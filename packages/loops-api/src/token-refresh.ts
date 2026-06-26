import { z } from "zod";

export const RefreshTokenErrorCode = {
  LoopNotFound: "LOOP_NOT_FOUND",
  NotRunning: "NOT_RUNNING",
  JtiMismatch: "JTI_MISMATCH",
  JtiAlreadyUsed: "JTI_ALREADY_USED",
  GenerationFailed: "GENERATION_FAILED",
  TokenExpired: "TOKEN_EXPIRED",
  RaceLost: "RACE_LOST",
  RateLimited: "RATE_LIMITED",
} as const;
export type RefreshTokenErrorCode =
  (typeof RefreshTokenErrorCode)[keyof typeof RefreshTokenErrorCode];

export const RefreshTokenErrorCodeSchema = z.enum(RefreshTokenErrorCode);

export const HeartbeatErrorCode = {
  LoopNotFound: "LOOP_NOT_FOUND",
  NotRunning: "NOT_RUNNING",
  TerminalLoop: "TERMINAL_LOOP",
} as const;
export type HeartbeatErrorCode =
  (typeof HeartbeatErrorCode)[keyof typeof HeartbeatErrorCode];

export const HeartbeatErrorCodeSchema = z.enum(HeartbeatErrorCode);

/**
 * The fields minted when a fresh runner JWT is issued: the token itself, its
 * expiry, and its JTI. Shared by every success path that hands a new runner
 * token back to the client (token refresh and timed-out-loop revival) so the
 * shape has a single source of truth.
 */
export const RunnerTokenIssueSchema = z.object({
  token: z.string(),
  expiresAt: z.coerce.date(),
  jti: z.string(),
});
export type RunnerTokenIssue = z.infer<typeof RunnerTokenIssueSchema>;

export const RefreshSuccessSchema = z.object({
  ok: z.literal(true),
  ...RunnerTokenIssueSchema.shape,
});
export type RefreshSuccess = z.infer<typeof RefreshSuccessSchema>;

export const RefreshErrorSchema = z.object({
  ok: z.literal(false),
  code: RefreshTokenErrorCodeSchema,
  message: z.string(),
});
export type RefreshError = z.infer<typeof RefreshErrorSchema>;

export const RefreshResultSchema = z.discriminatedUnion("ok", [
  RefreshSuccessSchema,
  RefreshErrorSchema,
]);
export type RefreshResult = z.infer<typeof RefreshResultSchema>;

/**
 * Success-shape fields shared by the service-layer `HeartbeatResultSchema` and
 * the wire-body `HeartbeatResponseDataSchema`. A revival carries the freshly
 * minted runner token (reusing `RunnerTokenIssueSchema`'s field schemas for the
 * SSOT); a normal heartbeat carries none. The token fields are optional at the
 * shape level — the revived-implies-token invariant is enforced by
 * `heartbeatTokenInvariantErrors` in the `superRefine` below.
 */
const heartbeatSuccessFields = {
  bumped: z.boolean(),
  revived: z.boolean().optional(),
  token: RunnerTokenIssueSchema.shape.token.optional(),
  expiresAt: RunnerTokenIssueSchema.shape.expiresAt.optional(),
  jti: RunnerTokenIssueSchema.shape.jti.optional(),
};

export const HeartbeatResultSchema = z
  .discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), ...heartbeatSuccessFields }),
    z.object({ ok: z.literal(false), code: HeartbeatErrorCodeSchema }),
  ])
  .superRefine((data, ctx) => {
    if (!data.ok) {
      return;
    }
    for (const message of heartbeatTokenInvariantErrors(data)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    }
  });
export type HeartbeatResult = z.infer<typeof HeartbeatResultSchema>;

/**
 * Wire-body schema for the heartbeat endpoint's `data` payload. The HTTP
 * envelope (`{ success, data }` produced by `successResponse`) already carries
 * the success/error discriminant, so the wire body omits `ok`:
 * `HeartbeatResultSchema` is the service-layer type whose `ok` flag is collapsed
 * into the envelope's `success`. Derived from the same fields and the same
 * revived-implies-token invariant as the success arm above.
 */
export const HeartbeatResponseDataSchema = z
  .object(heartbeatSuccessFields)
  .strict()
  .superRefine((data, ctx) => {
    for (const message of heartbeatTokenInvariantErrors(data)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    }
  });
export type HeartbeatResponseData = z.infer<typeof HeartbeatResponseDataSchema>;

/**
 * Validates the heartbeat success invariant: a revived heartbeat must carry the
 * full minted token (`token` + `expiresAt` + `jti`), and a non-revived heartbeat
 * must carry none of those fields. Returns the violation messages (empty when
 * the payload is consistent). Pure so both the service-layer and wire schemas
 * share one definition of the rule.
 */
const heartbeatTokenInvariantErrors = (data: {
  revived?: boolean;
  token?: string;
  expiresAt?: Date;
  jti?: string;
}): string[] => {
  const hasAllTokenFields =
    data.token !== undefined &&
    data.expiresAt !== undefined &&
    data.jti !== undefined;
  const hasAnyTokenField =
    data.token !== undefined ||
    data.expiresAt !== undefined ||
    data.jti !== undefined;

  if (data.revived === true && !hasAllTokenFields) {
    return ["revived:true requires token, expiresAt, and jti"];
  }
  if (data.revived !== true && hasAnyTokenField) {
    return ["token, expiresAt, and jti are only valid when revived:true"];
  }
  return [];
};
