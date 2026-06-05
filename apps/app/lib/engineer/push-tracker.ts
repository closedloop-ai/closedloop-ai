/**
 * Track which tickets have had their changes pushed to remote.
 * Uses localStorage to persist state across page refreshes.
 */

const STORAGE_KEY = "symphony-pushed-tickets";

/**
 * Get all tickets that have been pushed
 */
export function getPushedTickets(): Set<string> {
  if (globalThis.window === undefined) {
    return new Set();
  }

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return new Set();
    }
    return new Set(JSON.parse(stored));
  } catch {
    return new Set();
  }
}

/**
 * Check if a specific ticket has been pushed
 */
export function isTicketPushed(ticketId: string): boolean {
  return getPushedTickets().has(ticketId);
}

/**
 * Mark a ticket as pushed
 */
export function markTicketPushed(ticketId: string): void {
  if (globalThis.window === undefined) {
    return;
  }

  const pushed = getPushedTickets();
  pushed.add(ticketId);
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...pushed]));
}

/**
 * Clear pushed state for a ticket (e.g., when starting new work)
 */
export function clearTicketPushed(ticketId: string): void {
  if (globalThis.window === undefined) {
    return;
  }

  const pushed = getPushedTickets();
  pushed.delete(ticketId);
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...pushed]));
}
