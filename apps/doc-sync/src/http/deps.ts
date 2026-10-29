import type { InternalOidcVerifier } from "@repo/http-service/internal-oidc";
import type { DocSyncConnectionControl } from "../commands/connection-control";
import type { DocSyncCommands } from "../commands/document-commands";
import type { HealthProbe } from "./health-probe";

export type DocSyncHttpDeps = {
  verifyOidc: InternalOidcVerifier;
  commands: DocSyncCommands;
  health: HealthProbe;
  connections: DocSyncConnectionControl;
};
