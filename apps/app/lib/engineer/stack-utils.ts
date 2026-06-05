import type { ActiveSession } from "@/hooks/engineer/useSymphonyLaunch";

/**
 * Node in the stack tree, representing a ticket and its relationship to others.
 */
export type StackNode = {
  ticketId: string;
  parentTicketId?: string;
  children: string[];
  depth: number;
};

/**
 * Build a map of stack relationships from active sessions.
 * Returns a Map from ticketId to StackNode.
 *
 * @param sessions - Array of active sessions
 * @returns Map of ticketId to StackNode
 */
export function buildStackTree(
  sessions: ActiveSession[]
): Map<string, StackNode> {
  const nodes = new Map<string, StackNode>();

  // First pass: create nodes for all sessions
  for (const session of sessions) {
    nodes.set(session.ticketId, {
      ticketId: session.ticketId,
      parentTicketId: session.parentTicketId,
      children: [],
      depth: 0,
    });
  }

  // Second pass: build parent-child relationships
  for (const session of sessions) {
    if (session.parentTicketId) {
      const parentNode = nodes.get(session.parentTicketId);
      if (parentNode) {
        parentNode.children.push(session.ticketId);
      }
    }
  }

  // Third pass: calculate depths
  const calculateDepth = (
    ticketId: string,
    visited = new Set<string>()
  ): number => {
    // Prevent infinite loops from circular dependencies
    if (visited.has(ticketId)) {
      return 0;
    }
    visited.add(ticketId);

    const node = nodes.get(ticketId);
    if (!node) {
      return 0;
    }

    if (node.parentTicketId) {
      const parentNode = nodes.get(node.parentTicketId);
      if (parentNode) {
        return 1 + calculateDepth(node.parentTicketId, visited);
      }
    }
    return 0;
  };

  for (const [ticketId, node] of nodes) {
    node.depth = calculateDepth(ticketId);
  }

  return nodes;
}

/**
 * Get all tickets that are stacked on top of the given ticket.
 * These are direct children (tickets that were based on this ticket's branch).
 *
 * @param ticketId - The ticket to find children for
 * @param sessions - Array of active sessions
 * @returns Array of child ticket IDs
 */
export function getChildTickets(
  ticketId: string,
  sessions: ActiveSession[]
): string[] {
  return sessions
    .filter((s) => s.parentTicketId === ticketId)
    .map((s) => s.ticketId);
}

/**
 * Get all tickets in the dependency chain below this ticket.
 * Returns all descendants, not just direct children.
 *
 * @param ticketId - The ticket to find descendants for
 * @param sessions - Array of active sessions
 * @returns Array of descendant ticket IDs
 */
export function getAllDescendants(
  ticketId: string,
  sessions: ActiveSession[]
): string[] {
  const descendants: string[] = [];
  const visited = new Set<string>();

  const traverse = (id: string) => {
    if (visited.has(id)) {
      return;
    }
    visited.add(id);

    const children = getChildTickets(id, sessions);
    for (const childId of children) {
      descendants.push(childId);
      traverse(childId);
    }
  };

  traverse(ticketId);
  return descendants;
}

/**
 * Get the full ancestry chain for a ticket (from the ticket up to the root).
 * Returns the chain in order from closest ancestor to furthest.
 *
 * @param ticketId - The ticket to find ancestors for
 * @param sessions - Array of active sessions
 * @returns Array of ancestor ticket IDs, closest first
 */
export function getAncestorChain(
  ticketId: string,
  sessions: ActiveSession[]
): string[] {
  const ancestors: string[] = [];
  const visited = new Set<string>();

  let currentSession = sessions.find((s) => s.ticketId === ticketId);

  while (currentSession?.parentTicketId) {
    // Prevent infinite loops
    if (visited.has(currentSession.parentTicketId)) {
      break;
    }
    visited.add(currentSession.parentTicketId);

    ancestors.push(currentSession.parentTicketId);
    currentSession = sessions.find(
      (s) => s.ticketId === currentSession!.parentTicketId
    );
  }

  return ancestors;
}

/**
 * Check if creating a stack from childTicketId based on parentTicketId
 * would create a circular dependency.
 *
 * @param childTicketId - The ticket that would become the child
 * @param parentTicketId - The ticket that would become the parent
 * @param sessions - Array of active sessions
 * @returns true if this would create a cycle
 */
export function wouldCreateCycle(
  childTicketId: string,
  parentTicketId: string,
  sessions: ActiveSession[]
): boolean {
  // If the proposed parent is already a descendant of the child, this would create a cycle
  const descendants = getAllDescendants(childTicketId, sessions);
  return descendants.includes(parentTicketId);
}

/**
 * Get the root ticket in a stack (the one with no parent).
 *
 * @param ticketId - Any ticket in the stack
 * @param sessions - Array of active sessions
 * @returns The root ticket ID, or the input if no parent chain exists
 */
export function getStackRoot(
  ticketId: string,
  sessions: ActiveSession[]
): string {
  const ancestors = getAncestorChain(ticketId, sessions);
  return ancestors.length > 0 ? (ancestors.at(-1) as string) : ticketId;
}
