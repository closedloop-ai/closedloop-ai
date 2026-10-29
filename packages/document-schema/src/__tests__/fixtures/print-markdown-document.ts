import { markdownToDocument } from "@repo/document-schema/markdown";

const markdown = process.argv[2] ?? "";
process.stdout.write(JSON.stringify(markdownToDocument(markdown).toJSON()));
