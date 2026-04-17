// Set DD_SERVICE before any observability module is imported so that
// the module-level ORIGIN constant resolves to a known value in tests.
process.env.DD_SERVICE = "api";
