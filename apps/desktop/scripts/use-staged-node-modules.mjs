export default function useStagedNodeModules() {
  // The packaging stage already contains the production dependency closure.
  // Returning false tells electron-builder not to rebuild or re-collect node_modules.
  return false;
}
