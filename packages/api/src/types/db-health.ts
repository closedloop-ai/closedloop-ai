import { z } from "zod";

export const DbHealthCheckStatus = {
  Ok: "ok",
  Error: "error",
} as const;
export type DbHealthCheckStatus =
  (typeof DbHealthCheckStatus)[keyof typeof DbHealthCheckStatus];

export const DbHealthHostType = {
  Rds: "rds",
  Localhost: "localhost",
  Other: "other",
  Unknown: "unknown",
} as const;
export type DbHealthHostType =
  (typeof DbHealthHostType)[keyof typeof DbHealthHostType];

export const DbHealthSslMode = {
  Verified: "verified",
  Disabled: "disabled",
  Insecure: "insecure",
  Unknown: "unknown",
} as const;
export type DbHealthSslMode =
  (typeof DbHealthSslMode)[keyof typeof DbHealthSslMode];

export const DbHealthAuthMode = {
  Password: "password",
  Iam: "iam",
  Unknown: "unknown",
} as const;
export type DbHealthAuthMode =
  (typeof DbHealthAuthMode)[keyof typeof DbHealthAuthMode];

export const DbHealthSource = {
  DatabaseUrl: "database_url",
  PgHostIam: "pg_host_iam",
  Unknown: "unknown",
} as const;
export type DbHealthSource =
  (typeof DbHealthSource)[keyof typeof DbHealthSource];

export const DbHealthTransportError = {
  NotRds: "not_rds",
  TlsDisabled: "tls_disabled",
  TlsInsecure: "tls_insecure",
  UnknownPosture: "unknown_posture",
} as const;
export type DbHealthTransportError =
  (typeof DbHealthTransportError)[keyof typeof DbHealthTransportError];

export const DbHealthCheckResultSchema = z
  .object({
    status: z.string(),
    error: z.string().optional(),
    count: z.number().optional(),
  })
  .passthrough();

export const DbHealthTransportCheckSchema = z
  .object({
    status: z.enum([DbHealthCheckStatus.Ok, DbHealthCheckStatus.Error]),
    hostType: z.enum([
      DbHealthHostType.Rds,
      DbHealthHostType.Localhost,
      DbHealthHostType.Other,
      DbHealthHostType.Unknown,
    ]),
    sslMode: z.enum([
      DbHealthSslMode.Verified,
      DbHealthSslMode.Disabled,
      DbHealthSslMode.Insecure,
      DbHealthSslMode.Unknown,
    ]),
    authMode: z.enum([
      DbHealthAuthMode.Password,
      DbHealthAuthMode.Iam,
      DbHealthAuthMode.Unknown,
    ]),
    source: z.enum([
      DbHealthSource.DatabaseUrl,
      DbHealthSource.PgHostIam,
      DbHealthSource.Unknown,
    ]),
    verifiedRdsTls: z.boolean(),
    error: z
      .enum([
        DbHealthTransportError.NotRds,
        DbHealthTransportError.TlsDisabled,
        DbHealthTransportError.TlsInsecure,
        DbHealthTransportError.UnknownPosture,
      ])
      .optional(),
  })
  .passthrough();
export type DbHealthTransportCheck = z.infer<
  typeof DbHealthTransportCheckSchema
>;

export const DbHealthDeploymentSchema = z
  .object({
    gitSha: z.string().optional(),
    gitCommitRef: z.string().optional(),
    vercelDeploymentId: z.string().optional(),
    vercelUrl: z.string().optional(),
  })
  .passthrough();
export type DbHealthDeployment = z.infer<typeof DbHealthDeploymentSchema>;

export const DbHealthResultSchema = z
  .object({
    ok: z.boolean(),
    timestamp: z.string().optional(),
    error: z.string().optional(),
    checks: z
      .object({
        connectivity: DbHealthCheckResultSchema.optional(),
        migrations: DbHealthCheckResultSchema.optional(),
        tables: DbHealthCheckResultSchema.optional(),
        transport: DbHealthTransportCheckSchema.optional(),
      })
      .passthrough()
      .optional(),
    deployment: DbHealthDeploymentSchema.optional(),
  })
  .passthrough();
export type DbHealthResult = z.infer<typeof DbHealthResultSchema>;
