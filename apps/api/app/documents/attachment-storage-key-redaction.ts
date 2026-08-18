const ATTACHMENT_STORAGE_KEY_REDACTION = "[attachment-storage-key]";

export const ATTACHMENT_STORAGE_KEY_PATTERN = /attachments\/[A-Za-z0-9._~/-]+/g;

/** Redacts persisted attachment object keys before they reach logs or summaries. */
export function redactAttachmentStorageKeys(message: string): string {
  return message.replaceAll(
    ATTACHMENT_STORAGE_KEY_PATTERN,
    ATTACHMENT_STORAGE_KEY_REDACTION
  );
}

/** Converts an unknown error to a message and redacts attachment storage keys. */
export function getSafeAttachmentStorageErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactAttachmentStorageKeys(message);
}
