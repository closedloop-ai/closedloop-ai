import { type ChildProcess, execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { assertPathAllowed } from "./security.js";

const execFileAsync = promisify(execFile);

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  errorCode?: string;
  errorPath?: string;
  errorSyscall?: string;
};

export type DetachedSpawnOptions = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  logFile: string;
};

export type ProcessManagerOptions = {
  getAllowedDirectories: () => string[];
};

export class ProcessManager {
  private readonly options: ProcessManagerOptions;

  constructor(options: ProcessManagerOptions) {
    this.options = options;
  }

  async spawnDetached(options: DetachedSpawnOptions): Promise<{ pid: number }> {
    this.assertOperationPath(options.cwd);
    this.assertOperationPath(options.logFile);

    const logDirectory = path.dirname(options.logFile);
    await fs.promises.mkdir(logDirectory, { recursive: true });
    const logFd = fs.openSync(options.logFile, "a");
    let child: ChildProcess;
    try {
      child = spawn(options.command, options.args ?? [], {
        cwd: options.cwd,
        env: options.env,
        detached: true,
        stdio: ["ignore", logFd, logFd],
      });
    } finally {
      // spawn dups the descriptor into the child synchronously, so closing here
      // is exactly what the success path already did. The finally exists for the
      // path that used to leak: spawn validates its arguments synchronously and
      // throws on a rejected command, which skipped both former closes and left
      // the descriptor open for the lifetime of the process.
      fs.closeSync(logFd);
    }

    if (!child.pid) {
      throw new Error("failed to spawn detached process");
    }

    child.unref();
    return { pid: child.pid };
  }

  async exec(
    command: string,
    args: string[] = [],
    cwd?: string,
    options: { timeoutMs?: number } = {}
  ): Promise<ExecResult> {
    this.assertOperationPath(cwd);

    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        cwd,
        encoding: "utf-8",
        ...(options.timeoutMs === undefined
          ? {}
          : { timeout: options.timeoutMs }),
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (error) {
      const execError = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: string | number;
        path?: string;
        syscall?: string;
      };

      return {
        ...(typeof execError.code === "string"
          ? { errorCode: execError.code }
          : {}),
        ...(typeof execError.path === "string"
          ? { errorPath: execError.path }
          : {}),
        ...(typeof execError.syscall === "string"
          ? { errorSyscall: execError.syscall }
          : {}),
        stdout: execError.stdout ?? "",
        stderr: execError.stderr ?? execError.message,
        exitCode: typeof execError.code === "number" ? execError.code : 1,
      };
    }
  }

  private assertOperationPath(targetPath?: string): void {
    if (!targetPath) {
      return;
    }

    assertPathAllowed(targetPath, this.options.getAllowedDirectories());
  }
}
