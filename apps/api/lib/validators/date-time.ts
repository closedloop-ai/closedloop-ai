export function transformIsoDateTime(
  dateString: string | null | undefined
): Date | null | undefined {
  if (typeof dateString !== "string") {
    return dateString;
  }
  return new Date(dateString);
}
