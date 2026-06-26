import type { AppTelemetry } from "../app";
import type { PermissionTelemetry } from "../permission";
import type { SyncTelemetry } from "../sync";
import type { GenAiTelemetry } from "./gen-ai";
import type { ResourceTelemetry } from "./resource";
import type {
  TelemetrySchemaName,
  TelemetrySchemaName as TelemetrySchemaNameValue,
} from "./schema-name";
import type { SpanTelemetry } from "./span";

/** Maps each published schema name to its exact attribute object shape. */
export type SchemaShape<K extends TelemetrySchemaName> =
  K extends typeof TelemetrySchemaNameValue.App
    ? AppTelemetry
    : K extends typeof TelemetrySchemaNameValue.Resource
      ? ResourceTelemetry
      : K extends typeof TelemetrySchemaNameValue.Span
        ? SpanTelemetry
        : K extends typeof TelemetrySchemaNameValue.GenAi
          ? GenAiTelemetry
          : K extends typeof TelemetrySchemaNameValue.Sync
            ? SyncTelemetry
            : K extends typeof TelemetrySchemaNameValue.Permission
              ? PermissionTelemetry
              : never;

/** Rejects attribute keys that are not owned by the selected schema. */
export type ExactSchemaAttributes<
  K extends TelemetrySchemaName,
  A extends SchemaShape<K>,
> = A & Record<Exclude<keyof A, keyof SchemaShape<K>>, never>;

type TelemetryEmitPayload<
  K extends TelemetrySchemaName,
  A extends SchemaShape<K>,
> = {
  name: string;
  attributes: ExactSchemaAttributes<K, A>;
};

/** Typed telemetry emit function; it does not runtime-validate attributes. */
export type TelemetryEmitFunction = <
  K extends TelemetrySchemaName,
  const A extends SchemaShape<K>,
>(
  schemaName: K,
  payload: TelemetryEmitPayload<K, A>
) => void;
