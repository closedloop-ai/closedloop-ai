import { type ChildProcess, execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { assertPathAllowed } from "./security.js";

const execFileAsync = promisify(execFile);
const DEFAULT_RESULT_KILL_DELAY_MS = 30_000;
const DEFAULT_RESULT_KILL_GRACE_MS = 5000;

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  errorCode?: string;
  errorPath?: string;
  errorSyscall?: string;
};

export type StreamingSpawnOptions = {
  command: string;
  args?: string[];
  cwd?: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
  resultKillDelayMs?: number;
  resultKillGraceMs?: number;
  isResultEvent?: (line: string) => boolean;
  onLine?: (line: string) => void;
  onError?: (error: Error) => void;
  onExit?: (exitCode: number | null, signal: NodeJS.Signals | null) => void;
};

export type DetachedSpawnOptions = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  logFile: string;
};

export type StreamingProcessHandle = {
  pid: number;
  process: ChildProcess;
};

export type ProcessManagerOptions = {
  getAllowedDirectories: () => string[];
};

export class ProcessManager {
  private readonly options: ProcessManagerOptions;

  constructor(options: ProcessManagerOptions) {
    this.options = options;
  }

  async spawnStreaming(
    options: StreamingSpawnOptions
  ): Promise<StreamingProcessHandle> {
    this.assertOperationPath(options.cwd);

    const child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (!child.pid) {
      throw new Error("failed to spawn streaming process");
    }

    let resultKillTimeout: NodeJS.Timeout | null = null;
    let resultKillGraceTimeout: NodeJS.Timeout | null = null;
    let bufferedOutput = "";

    const cleanupKillTimers = () => {
      if (resultKillTimeout) {
        clearTimeout(resultKillTimeout);
        resultKillTimeout = null;
      }
      if (resultKillGraceTimeout) {
        clearTimeout(resultKillGraceTimeout);
        resultKillGraceTimeout = null;
      }
    };

    const triggerResultKillTimer = () => {
      if (resultKillTimeout || resultKillGraceTimeout) {
        return;
      }

      const killDelay =
        options.resultKillDelayMs ?? DEFAULT_RESULT_KILL_DELAY_MS;
      const killGrace =
        options.resultKillGraceMs ?? DEFAULT_RESULT_KILL_GRACE_MS;
      resultKillTimeout = setTimeout(() => {
        void this.killProcessGroup(child.pid ?? -1, killGrace);
      }, killDelay);
    };

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string | Buffer) => {
      bufferedOutput +=
        typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      const lines = bufferedOutput.split("\n");
      bufferedOutput = lines.pop() ?? "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }

        options.onLine?.(line);

        const isResultEvent = options.isResultEvent
          ? options.isResultEvent(line)
          : this.defaultResultEventDetector(line);
        if (isResultEvent) {
          triggerResultKillTimer();
        }
      }
    });

    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string | Buffer) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      options.onError?.(new Error(text));
    });

    child.on("error", (error) => {
      cleanupKillTimers();
      options.onError?.(error);
    });

    child.on("exit", (exitCode, signal) => {
      cleanupKillTimers();
      options.onExit?.(exitCode, signal);
    });

    if (options.input !== undefined) {
      child.stdin?.write(options.input);
      child.stdin?.end();
    }

    return { pid: child.pid, process: child };
  }

  async spawnDetached(options: DetachedSpawnOptions): Promise<{ pid: number }> {
    this.assertOperationPath(options.cwd);
    this.assertOperationPath(options.logFile);

    const logDirectory = path.dirname(options.logFile);
    await fs.promises.mkdir(logDirectory, { recursive: true });
    const logFd = fs.openSync(options.logFile, "a");
    const child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });

    if (!child.pid) {
      fs.closeSync(logFd);
      throw new Error("failed to spawn detached process");
    }

    fs.closeSync(logFd);
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

  async killProcessGroup(
    pid: number,
    gracePeriodMs = DEFAULT_RESULT_KILL_GRACE_MS
  ): Promise<void> {
    if (!pid || pid < 1) {
      return;
    }

    this.killSafely(-pid, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, gracePeriodMs));

    if (this.isProcessRunning(pid)) {
      this.killSafely(-pid, "SIGKILL");
    }
  }

  private assertOperationPath(targetPath?: string): void {
    if (!targetPath) {
      return;
    }

    assertPathAllowed(targetPath, this.options.getAllowedDirectories());
  }

  private defaultResultEventDetector(line: string): boolean {
    try {
      const parsed = JSON.parse(line) as { type?: string };
      return parsed.type === "result";
    } catch {
      return false;
    }
  }

  private killSafely(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(pid, signal);
    } catch (error) {
      const processError = error as NodeJS.ErrnoException;
      if (processError.code !== "ESRCH") {
        throw processError;
      }
    }
  }

  private isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const processError = error as NodeJS.ErrnoException;
      if (processError.code === "ESRCH") {
        return false;
      }
      throw processError;
    }
  }
}
