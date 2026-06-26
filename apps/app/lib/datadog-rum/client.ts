"use client";

import { datadogRum } from "@datadog/browser-rum";
import { nextjsPlugin } from "@datadog/browser-rum-nextjs";
import { getDatadogRumConfig } from "./config";

let initialized = false;

export function initDatadogRum(): boolean {
  try {
    if (initialized || globalThis.window === undefined) {
      return false;
    }

    const config = getDatadogRumConfig();
    if (!config) {
      return false;
    }

    datadogRum.init({
      ...config,
      plugins: [nextjsPlugin()],
    });
    initialized = true;
    return true;
  } catch {
    return false;
  }
}
