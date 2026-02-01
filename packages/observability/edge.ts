/*
 * This file configures the initialization of Sentry for edge runtime.
 * The config you add here will be used whenever a page or API route is loaded in an edge runtime.
 * https://docs.sentry.io/platforms/javascript/guides/nextjs/
 */

import { consoleLoggingIntegration, init } from "@sentry/nextjs";
import { keys } from "./keys";

export const initializeSentry = (): ReturnType<typeof init> =>
  init({
    dsn: keys().NEXT_PUBLIC_SENTRY_DSN,

    // Enable logging
    enableLogs: true,

    // Adjust this value in production, or use tracesSampler for greater control
    tracesSampleRate: 1,

    // Setting this option to true will print useful information to the console while you're setting up Sentry.
    debug: false,

    // Integrations for console logging
    integrations: [
      // Send console.log, console.error, and console.warn calls as logs to Sentry
      consoleLoggingIntegration({ levels: ["log", "error", "warn"] }),
    ],
  });
