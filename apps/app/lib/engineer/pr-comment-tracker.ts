/**
 * PR Comment Status Tracker
 *
 * Tracks the status of PR comments in localStorage.
 * Each comment can be: pending, addressed, responded, or dismissed.
 */

const STORAGE_KEY = "closedloop-pr-comment-status";

export type CommentStatusType =
  | "pending"
  | "addressed"
  | "responded"
  | "dismissed";

/** Extended status that includes derived UI-only states (not persisted). */
export type CommentDisplayStatus = CommentStatusType | "analyzing";

export type CommentStatus = {
  commentId: string;
  status: CommentStatusType;
  commitSha?: string; // If addressed (code change committed)
  responseText?: string; // If responded (pushback reply sent)
  chatSessionId?: string; // Link to chat history
  resolvedAt?: string; // ISO timestamp when resolved
  chatStarted?: boolean; // True once a chat session has been initiated
};

type StorageData = {
  [prKey: string]: {
    [commentId: string]: CommentStatus;
  };
};

/**
 * Get the storage key for a PR
 */
function getPrKey(prNumber: number): string {
  return `pr-${prNumber}`;
}

/**
 * Get all stored data
 */
function getStorageData(): StorageData {
  if (globalThis.window === undefined) {
    return {};
  }

  try {
    const data = localStorage.getItem(STORAGE_KEY);
    return data ? JSON.parse(data) : {};
  } catch {
    console.error("Failed to parse PR comment status from localStorage");
    return {};
  }
}

/**
 * Save data to storage
 */
function saveStorageData(data: StorageData): void {
  if (globalThis.window === undefined) {
    return;
  }

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (error) {
    console.error("Failed to save PR comment status to localStorage:", error);
  }
}

/**
 * Get all comment statuses for a PR
 */
export function getCommentStatuses(
  prNumber: number
): Record<string, CommentStatus> {
  const data = getStorageData();
  const prKey = getPrKey(prNumber);
  return data[prKey] || {};
}

/**
 * Get the status of a specific comment
 */
export function getCommentStatus(
  prNumber: number,
  commentId: string
): CommentStatus | null {
  const statuses = getCommentStatuses(prNumber);
  return statuses[commentId] || null;
}

/**
 * Set the status of a comment
 */
export function setCommentStatus(
  prNumber: number,
  commentId: string,
  status: Partial<CommentStatus> & { status: CommentStatusType }
): void {
  const data = getStorageData();
  const prKey = getPrKey(prNumber);

  if (!data[prKey]) {
    data[prKey] = {};
  }

  data[prKey][commentId] = {
    commentId,
    ...status,
    resolvedAt:
      status.status === "pending" ? undefined : new Date().toISOString(),
  };

  saveStorageData(data);
}

/**
 * Mark a comment as addressed (code fix committed)
 */
export function markCommentAddressed(
  prNumber: number,
  commentId: string,
  commitSha: string,
  chatSessionId?: string
): void {
  setCommentStatus(prNumber, commentId, {
    status: "addressed",
    commitSha,
    chatSessionId,
  });
}

/**
 * Mark a comment as responded (pushback reply sent)
 */
export function markCommentResponded(
  prNumber: number,
  commentId: string,
  responseText: string,
  chatSessionId?: string
): void {
  setCommentStatus(prNumber, commentId, {
    status: "responded",
    responseText,
    chatSessionId,
  });
}

/**
 * Mark a comment as dismissed (no action needed)
 */
export function markCommentDismissed(
  prNumber: number,
  commentId: string
): void {
  setCommentStatus(prNumber, commentId, {
    status: "dismissed",
  });
}

/**
 * Reset a comment status back to pending
 */
export function resetCommentStatus(prNumber: number, commentId: string): void {
  const data = getStorageData();
  const prKey = getPrKey(prNumber);

  if (data[prKey]?.[commentId]) {
    delete data[prKey][commentId];
    saveStorageData(data);
  }
}

/**
 * Clear all comment statuses for a PR
 */
export function clearPRCommentStatuses(prNumber: number): void {
  const data = getStorageData();
  const prKey = getPrKey(prNumber);

  if (data[prKey]) {
    delete data[prKey];
    saveStorageData(data);
  }
}

/**
 * Check if a comment has been resolved (addressed, responded, or dismissed)
 */
export function isCommentResolved(
  prNumber: number,
  commentId: string
): boolean {
  const status = getCommentStatus(prNumber, commentId);
  return status !== null && status.status !== "pending";
}

/**
 * Get counts of comments by status for a PR
 */
export function getCommentStatusCounts(
  prNumber: number,
  commentIds: string[]
): {
  pending: number;
  addressed: number;
  responded: number;
  dismissed: number;
} {
  const statuses = getCommentStatuses(prNumber);

  const counts = {
    pending: 0,
    addressed: 0,
    responded: 0,
    dismissed: 0,
  };

  for (const commentId of commentIds) {
    const status = statuses[commentId];
    if (!status || status.status === "pending") {
      counts.pending++;
    } else {
      counts[status.status]++;
    }
  }

  return counts;
}

/**
 * Mark that a chat session has been started for a comment (without changing resolution status)
 */
export function markChatStarted(prNumber: number, commentId: string): void {
  const data = getStorageData();
  const prKey = getPrKey(prNumber);

  if (!data[prKey]) {
    data[prKey] = {};
  }

  const existing = data[prKey][commentId];
  if (existing) {
    existing.chatStarted = true;
  } else {
    data[prKey][commentId] = {
      commentId,
      status: "pending",
      chatStarted: true,
    };
  }

  saveStorageData(data);
}
