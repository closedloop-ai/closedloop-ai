/**
 * A character's derived picker presentation, parsed from its prompt file's
 * opening line.
 */
export type AuditCharacterLabelAndDescription = {
  /** Display name shown in the picker. */
  label: string;
  /** One-line, sentence-cased description of what the character reviews. */
  description: string;
};

export declare function stripInlineMarkdown(value: string): string;

export declare function firstNonBlankLine(raw: string): string;

export declare function firstSentence(value: string): string;

export declare function calmShoutyWords(value: string): string;

export declare function capitalizeFirst(value: string): string;

export declare function cleanDescription(clause: string): string;

export declare function parseLabelAndDescription(
  raw: string,
  id: string
): AuditCharacterLabelAndDescription;

export declare function tagForId(id: string): string;

export declare function groupForId(id: string): string;

export declare function groupLabelFor(group: string): string;
