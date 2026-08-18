type PackContentBodyProps = {
  content?: string | null;
  className?: string;
};

/**
 * Renders authored catalog component content exactly as stored on the latest
 * CatalogItemVersion. Keep this dependency-light so shared Pack surfaces,
 * including Desktop, can render bodies without app-only markdown utilities.
 */
export function PackContentBody({ content, className }: PackContentBodyProps) {
  if (typeof content !== "string" || !content.trim()) {
    return null;
  }

  return (
    <pre
      className={`max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-[11px] text-foreground leading-relaxed ${
        className ?? ""
      }`}
    >
      {content}
    </pre>
  );
}
