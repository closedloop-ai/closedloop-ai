export function hasTrailingUnrecoveredApiError(
  lastApiErrorTs: string | null,
  lastAssistantTs: string | null
): boolean {
  if (!lastApiErrorTs) {
    return false;
  }
  if (!lastAssistantTs) {
    return true;
  }
  return lastApiErrorTs >= lastAssistantTs;
}
