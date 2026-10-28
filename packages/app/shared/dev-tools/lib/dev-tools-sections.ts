import { createDevToolsRegistry } from "./dev-tools-registry";
import { FEATURE_FLAGS_DEV_TOOLS_SECTION } from "./feature-flags-dev-tools-section";

/** ISS-12048: the sections both shells' Dev Tools overlay renders, in order. */
export const DEV_TOOLS_REGISTRY = createDevToolsRegistry([
  FEATURE_FLAGS_DEV_TOOLS_SECTION,
]);
