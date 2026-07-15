// Side-effect import: pins the process TZ BEFORE any other module constructs a
// Date. Must be the first import of the test file (FEA-2646 hermeticity).
process.env.TZ = "America/Chicago";
