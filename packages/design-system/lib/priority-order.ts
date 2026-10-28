/**
 * Compatibility path for the priority vocabulary, which lives in
 * `./vocabulary/priority-order.ts` (ISS-11563). That folder is platform layer
 * in `scripts/lint/layer-manifest.ts`, so server apps may load it; this file
 * keeps the existing UI importers on their current specifier.
 */
export * from "./vocabulary/priority-order";
