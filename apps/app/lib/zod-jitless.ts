import { z } from "zod";

// FEA-4149: zod v4's JIT object-parser codegen — a `Function("")` capability
// probe plus `Doc.compile()`'s `new Function(...)` — is this bundle's only
// source of `unsafe-eval` CSP violations (confirmed via the csp-report
// Datadog attribution: every `blockedURL: eval` report resolves to those two
// zod call sites). `jitless` keeps zod on its interpreter path so the strict
// CSP can be enforced without `unsafe-eval`. This module is imported FIRST by
// `instrumentation-client.ts` because zod reads the flag when a schema is
// CONSTRUCTED, not when it parses.
z.config({ jitless: true });
