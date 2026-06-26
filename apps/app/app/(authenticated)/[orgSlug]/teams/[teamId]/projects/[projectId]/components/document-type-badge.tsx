import {
  type DocumentTypeBadgeProps,
  DocumentTypeBadge as SharedDocumentTypeBadge,
} from "@repo/app/documents/components/document-type-badge";

export function DocumentTypeBadge({
  type,
  className,
}: Readonly<DocumentTypeBadgeProps>) {
  return (
    <SharedDocumentTypeBadge
      appearance="pill"
      className={className}
      type={type}
    />
  );
}
