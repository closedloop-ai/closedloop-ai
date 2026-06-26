import { initDatadogRum } from "@/lib/datadog-rum/client";

initDatadogRum();

// biome-ignore lint/performance/noBarrelFile: Next.js instrumentation-client requires this named router transition export.
export { onRouterTransitionStart } from "@datadog/browser-rum-nextjs";
