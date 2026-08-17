/**
 * Download content as a markdown file
 */
export function downloadAsMarkdown(content: string, filename: string): void {
  const blob = new Blob([content], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  try {
    const a = globalThis.document.createElement("a");
    a.href = url;
    a.download = filename.endsWith(".md") ? filename : `${filename}.md`;
    globalThis.document.body.appendChild(a);
    a.click();
    globalThis.document.body.removeChild(a);
  } finally {
    URL.revokeObjectURL(url);
  }
}
