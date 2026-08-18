/**
 * Shared `execFile` wrapper for the thin CLI clients (`git`, `gh`). Both the
 * repo git helpers (`passes/repo.ts`) and the GitHub client (`clients/github.ts`)
 * ran identical Promise-wrapped `execFile` calls with the same 32 MiB buffer;
 * this is their single home so the wrapper + buffer cap live in one place.
 *
 * Node-only (`node:child_process`). Do NOT import from the renderer-safe root
 * barrel.
 */
import { execFile } from "node:child_process";

/** Cap child stdout/stderr at 32 MiB — large `git log`/`gh` payloads fit. */
export const MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Run `command args` and resolve its stdout. Rejects with a `<command> … failed`
 * error carrying stderr (or the underlying error message) on a non-zero exit.
 */
export function execCommand(
  command: string,
  args: string[],
  opts: { cwd?: string } = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd: opts.cwd, maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `${command} ${args.join(" ")} failed: ${stderr || err.message}`
            )
          );
          return;
        }
        resolve(stdout);
      }
    );
  });
}
