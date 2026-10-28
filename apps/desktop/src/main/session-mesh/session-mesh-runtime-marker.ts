import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const SESSION_MESH_RUNTIME_MARKER = "active-runtime";

/** Fast shell-side liveness hint, never an authorization credential. The local
 * token and current org/user/compute identity still authorize every request. */
export class SessionMeshRuntimeMarker {
  private current: string | null = null;
  private readonly file: string;
  private readonly log: (message: string) => void;
  constructor(directory: string, log: (message: string) => void) {
    this.log = log;
    this.file = path.join(directory, SESSION_MESH_RUNTIME_MARKER);
  }

  refresh(sourceKey: string | null): void {
    try {
      if (!sourceKey) {
        this.clear();
        return;
      }
      const next = `${process.pid}\n${createHash("sha256").update(sourceKey).digest("hex")}\n`;
      if (this.current === next) {
        return;
      }
      const temporary = `${this.file}.${process.pid}.tmp`;
      writeFileSync(temporary, next, { mode: 0o600 });
      renameSync(temporary, this.file);
      this.current = next;
    } catch (error) {
      this.log(`Session Mesh runtime marker unavailable: ${String(error)}`);
    }
  }

  private clear(): void {
    this.current = null;
    // A replacement Desktop process owns its own marker; an old shutdown
    // must not remove that process's liveness hint.
    if (
      existsSync(this.file) &&
      readFileSync(this.file, "utf8").startsWith(`${process.pid}\n`)
    ) {
      unlinkSync(this.file);
    }
  }
}
