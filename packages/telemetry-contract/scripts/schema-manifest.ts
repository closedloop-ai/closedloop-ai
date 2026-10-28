export type SchemaIdentity = {
  readonly path: string;
  readonly id: string;
};

export const schemaManifest = [
  {
    path: "dist/schemas/app.schema.json",
    id: "https://closedloop.ai/schemas/telemetry-contract/app/v0.3.schema.json",
  },
  {
    path: "dist/schemas/resource.schema.json",
    id: "https://closedloop.ai/schemas/telemetry-contract/resource/v0.4.schema.json",
  },
  {
    path: "dist/schemas/span.schema.json",
    id: "https://closedloop.ai/schemas/telemetry-contract/span/v0.1.schema.json",
  },
  {
    path: "dist/schemas/gen-ai.schema.json",
    id: "https://closedloop.ai/schemas/telemetry-contract/gen-ai/v0.4.schema.json",
  },
  {
    path: "dist/schemas/sync.schema.json",
    id: "https://closedloop.ai/schemas/telemetry-contract/sync/v0.6.schema.json",
  },
  {
    path: "dist/schemas/permission.schema.json",
    id: "https://closedloop.ai/schemas/telemetry-contract/permission/v0.4.schema.json",
  },
  {
    path: "dist/schemas/ipc.schema.json",
    id: "https://closedloop.ai/schemas/telemetry-contract/ipc/v0.1.schema.json",
  },
] as const satisfies readonly SchemaIdentity[];

export type SchemaPath = (typeof schemaManifest)[number]["path"];
