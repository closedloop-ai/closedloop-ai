import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildAuthHandoffAssets,
  renderAuthHandoffAssetsModule,
} from "./generate-auth-handoff-assets-lib.mjs";

// The loopback page runs offline, outside the renderer. Bundle the canonical
// brand assets and theme tokens rather than fetching them during sign-in.
const designSystem = new URL(
  "../../../packages/design-system/",
  import.meta.url
);
const assets = buildAuthHandoffAssets((path) =>
  readFileSync(new URL(path, designSystem))
);
const directory = new URL("../src/shared/", import.meta.url);
mkdirSync(directory, { recursive: true });
writeFileSync(
  fileURLToPath(new URL("auth-handoff-assets.generated.ts", directory)),
  renderAuthHandoffAssetsModule(assets)
);
