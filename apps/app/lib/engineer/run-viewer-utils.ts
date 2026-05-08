import JSZip from "jszip";
import type { FileTreeNode, RunData } from "@/types/run-viewer";

const decoder = new TextDecoder();

export function decodeText(data: Uint8Array): string {
  return decoder.decode(data);
}

export function buildFileTree(paths: string[]): FileTreeNode {
  const root: FileTreeNode = {
    name: "",
    path: "",
    isDirectory: true,
    children: [],
  };

  for (const filePath of paths) {
    const parts = filePath.split("/");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const currentPath = parts.slice(0, i + 1).join("/");

      let child = current.children.find((c) => c.name === part);
      if (!child) {
        child = {
          name: part,
          path: currentPath,
          isDirectory: !isLast,
          children: [],
        };
        current.children.push(child);
      }
      current = child;
    }
  }

  // Sort: directories first, then alphabetically
  sortTree(root);
  return root;
}

function sortTree(node: FileTreeNode): void {
  node.children.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  for (const child of node.children) {
    sortTree(child);
  }
}

function stripCommonRoot(paths: string[]): {
  stripped: string[];
  prefix: string;
} {
  if (paths.length === 0) {
    return { stripped: paths, prefix: "" };
  }

  // Find common prefix directory
  const parts0 = paths[0].split("/");
  let commonDepth = 0;

  for (let d = 0; d < parts0.length - 1; d++) {
    const segment = parts0[d];
    if (paths.every((p) => p.split("/")[d] === segment)) {
      commonDepth = d + 1;
    } else {
      break;
    }
  }

  if (commonDepth === 0) {
    return { stripped: paths, prefix: "" };
  }

  const prefix = parts0.slice(0, commonDepth).join("/");
  const stripped = paths
    .map((p) => p.slice(prefix.length + 1))
    .filter((p) => p.length > 0);
  return { stripped, prefix };
}

async function extractZipEntries(zip: JSZip): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();

  const entries = Object.entries(zip.files).filter(
    ([name, f]) =>
      !(
        f.dir ||
        name.startsWith("__MACOSX/") ||
        name.endsWith("/.DS_Store") ||
        name.endsWith(".DS_Store")
      )
  );

  for (const [name, zipEntry] of entries) {
    const data = await zipEntry.async("uint8array");
    files.set(name, data);
  }

  return files;
}

async function tryExtractNestedZip(
  files: Map<string, Uint8Array>
): Promise<Map<string, Uint8Array> | null> {
  // If the zip contains a single .zip file, extract it recursively
  const entries = Array.from(files.entries());
  if (entries.length !== 1) {
    return null;
  }

  const [name, data] = entries[0];
  if (!name.endsWith(".zip")) {
    return null;
  }

  try {
    const innerZip = await JSZip.loadAsync(data);
    return extractZipEntries(innerZip);
  } catch {
    return null;
  }
}

export async function extractZip(file: File): Promise<RunData> {
  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);

  let files = await extractZipEntries(zip);

  // Handle nested zip (e.g. macOS compressing a .zip produces zip-in-zip)
  const nested = await tryExtractNestedZip(files);
  if (nested) {
    files = nested;
  }

  const allPaths = Array.from(files.keys());

  // Strip common root prefix
  const { stripped, prefix } = stripCommonRoot(allPaths);

  if (prefix) {
    const newFiles = new Map<string, Uint8Array>();
    for (const [name, data] of files) {
      const newName = name.slice(prefix.length + 1);
      if (newName.length > 0) {
        newFiles.set(newName, data);
      }
    }
    const tree = buildFileTree(stripped);
    return { files: newFiles, tree };
  }

  const tree = buildFileTree(allPaths);
  return { files, tree };
}

export function getFileType(path: string): string {
  const filename = path.split("/").pop() || "";

  // Exact filename matches
  if (filename === "judges.json") {
    return "judges";
  }
  if (filename === "plan.json") {
    return "plan";
  }
  if (filename === "state.json") {
    return "state";
  }
  if (filename === "plan-evaluation.json") {
    return "evaluation";
  }
  if (filename === "claude-output.jsonl") {
    return "claude-output";
  }

  // Extension matches
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  if (filename.endsWith(".md")) {
    return "markdown";
  }
  if (filename.endsWith(".json")) {
    return "json";
  }
  if (filename.endsWith(".jsonl")) {
    return "jsonl";
  }
  if (ext === "yaml" || ext === "yml") {
    return "yaml";
  }
  if (ext === "log") {
    return "log";
  }
  if (ext === "env") {
    return "env";
  }
  if (ext === "toon") {
    return "toon";
  }

  return "text";
}
