/** Explain when an empty tab may be a bounded-read result rather than truth. */
export function ArtifactTruncationEmptyNote({
  note,
}: Readonly<{ note: string | null }>) {
  if (!note) {
    return null;
  }
  return (
    <p className="px-4 pb-3 text-muted-foreground text-xs" role="status">
      {note}
    </p>
  );
}
