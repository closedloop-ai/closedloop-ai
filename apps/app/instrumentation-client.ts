// FEA-4149: must stay the first import — zod snapshots `jitless` per schema
// at construction time, so it has to be set before any module builds one.
// Pinned by the import-order guard in
// `__tests__/instrumentation-client-zod-jitless.test.ts`.
import "@/lib/zod-jitless";
import { initDatadogRum } from "@/lib/datadog-rum/client";

initDatadogRum();

// biome-ignore lint/performance/noBarrelFile: Next.js instrumentation-client requires this named router transition export.
export { onRouterTransitionStart } from "@datadog/browser-rum-nextjs";
