/**
 * Lightweight gateway wire constants.
 *
 * Zero imports on purpose: this module is the single source of truth for the
 * gateway path prefix and is safe to import from bundle-sensitive surfaces
 * (server routes, `"use client"` components) without pulling in the dispatch
 * router, routing store, or any framework code. See AGENTS.md: split contract
 * constants from heavy parser/validation modules.
 */

/** Path prefix shared by every gateway route. SSOT wire constant. */
export const GATEWAY_PATH_PREFIX = "/api/gateway/";
