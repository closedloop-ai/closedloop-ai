/**
 * Track PR URLs for tickets.
 * Uses localStorage to persist state across page refreshes.
 */

const STORAGE_KEY = "symphony-ticket-prs";

type PRInfo = {
  url: string;
  number: number;
  createdAt: string;
  repoPath?: string;
};

/**
 * Get all ticket PRs
 */
export function getTicketPRs(): Record<string, PRInfo> {
  if (globalThis.window === undefined) {
    return {};
  }

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return {};
    }
    return JSON.parse(stored);
  } catch {
    return {};
  }
}

/**
 * Get PR info for a specific ticket
 */
export function getTicketPR(ticketId: string): PRInfo | null {
  const prs = getTicketPRs();
  return prs[ticketId] || null;
}

/**
 * Check if a ticket has a PR
 */
export function hasTicketPR(ticketId: string): boolean {
  return getTicketPR(ticketId) !== null;
}

/**
 * Save PR info for a ticket
 */
export function saveTicketPR(
  ticketId: string,
  url: string,
  number: number,
  repoPath?: string
): void {
  if (globalThis.window === undefined) {
    return;
  }

  const prs = getTicketPRs();
  prs[ticketId] = {
    url,
    number,
    createdAt: new Date().toISOString(),
    ...(repoPath ? { repoPath } : {}),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prs));
}

/**
 * Clear PR info for a ticket
 */
export function clearTicketPR(ticketId: string): void {
  if (globalThis.window === undefined) {
    return;
  }

  const prs = getTicketPRs();
  delete prs[ticketId];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prs));
}
