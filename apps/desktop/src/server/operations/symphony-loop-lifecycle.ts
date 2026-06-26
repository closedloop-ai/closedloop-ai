const pendingLoopExits = new Set<string>();

export function registerPendingLoopExit(loopId: string): void {
  pendingLoopExits.add(loopId);
}

export function clearPendingLoopExit(loopId: string): void {
  pendingLoopExits.delete(loopId);
}

export function hasPendingLoopExit(loopId: string): boolean {
  return pendingLoopExits.has(loopId);
}
