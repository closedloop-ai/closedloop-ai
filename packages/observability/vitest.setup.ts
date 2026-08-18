// Set DD_SERVICE before any observability module is imported so that
// the module-level ORIGIN constant resolves to a known value in tests.
process.env.DD_SERVICE = "api";

// CI sets DD_LOGS_DISABLED=1 on the instrumented test lanes so the code under
// test elsewhere does not ship its logs to Datadog (see log.ts). This package
// owns that exporter and its tests assert on the real flush path against a
// stubbed fetch, so clear the flag for this package's suite only.
Reflect.deleteProperty(process.env, "DD_LOGS_DISABLED");
