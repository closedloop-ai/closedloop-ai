/**
 * electron-builder's `beforeBuild` hook (wired at `electron-builder.yml`).
 *
 * Returning `false` tells electron-builder that the dependency closure is
 * already in place and it must not install or rebuild `node_modules` itself.
 */
export default function useStagedNodeModules(): boolean;
