import { log } from "@repo/observability/log";
import { CONTENT_KEYS } from "./keys";
import type { ZipContentExtractor } from "./types";
import { ExtractorOutputType } from "./types";

/** Extract investigation/open questions markdown. */
export const questionsExtractor: ZipContentExtractor<
  string,
  typeof ExtractorOutputType.String
> = {
  key: CONTENT_KEYS.questionsContent,
  outputType: ExtractorOutputType.String,
  priority: 0,

  matches(entryName: string): boolean {
    return (
      entryName.endsWith("open-questions.md") ||
      entryName.endsWith("investigation-questions.md")
    );
  },

  parse(data: Buffer, entryName: string): string | null {
    const content = data.toString("utf-8");
    log.info(`Found questions file: ${entryName} (${content.length} chars)`);
    return content;
  },
};
