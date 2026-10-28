import fs from "node:fs";
import path from "node:path";

/**
 * Captures `fileNames` under `dir` and returns a function that puts them back
 * exactly: rewrites a file that existed, removes one that did not (ISS-12043).
 * The vibe walk launches against the environment's real profile, so the flags
 * it switches on must not outlive the walk.
 */
export function snapshotProfileFiles(
  dir: string,
  fileNames: readonly string[]
): () => void {
  const saved = fileNames.map((name) => {
    const filePath = path.join(dir, name);
    return {
      filePath,
      contents: fs.existsSync(filePath) ? fs.readFileSync(filePath) : null,
    };
  });
  return () => {
    for (const { filePath, contents } of saved) {
      if (contents === null) {
        fs.rmSync(filePath, { force: true });
      } else {
        fs.writeFileSync(filePath, contents);
      }
    }
  };
}
