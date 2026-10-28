/**
 * Non-blocking drop-ins for `execFileSync` and `execSync` (ISS-11414).
 *
 * The gateway runs inside the Electron main process, so a synchronous child
 * process there freezes every window, IPC reply and timer until the child
 * exits (ISS-6132). `promisify(execFile)` removes the freeze but is not a
 * drop-in: it reports a timeout as `Command failed: …` with `killed: true`
 * where the sync form throws `spawnSync <file> ETIMEDOUT`, a spawn failure as
 * `spawn <file> ENOENT`, the exit code on `code` instead of `status`, and it
 * never echoes the child's stderr to the parent. Call sites surface
 * `err.message` and `err.stderr` to users, so those differences are visible.
 *
 * These helpers run the child with `spawn`, collect its output the way
 * `spawnSync` does (a piped stdin closed at once, the same 1 MiB default
 * `maxBuffer`, a SIGTERM on timeout or overflow, the encoding applied to
 * stdout, stderr and `output`), and then apply the rules Node's own
 * `execFileSync`/`execSync` apply to that result.
 * A caller that swaps `execFileSync(f, a, o)` for
 * `await execFileNonBlocking(f, a, o)` with the same options gets the same
 * return value and, on failure, an error with the same message, `code`,
 * `errno`, `syscall`, `path`, `spawnargs`, `status`, `signal`, `stdout`,
 * `stderr` and `output`. `test/non-blocking-exec.test.ts` checks that against
 * the real sync functions.
 *
 * On a `maxBuffer` overflow or a timeout both forms kill the child and close
 * its stdout and stderr pipes, keeping the output read up to and including
 * the pipe read that crossed the limit; a child that keeps writing cannot grow
 * the parent's memory, and a grandchild holding the pipes cannot hold the call
 * open past its timeout. How the output splits into reads
 * varies between runs of either form, so the kept length does too: more than
 * the limit and at most one 64 KiB read past it.
 */
import {
  type SpawnOptions,
  type StdioOptions,
  spawn,
} from "node:child_process";
import { constants as osConstants } from "node:os";

/** Node's default `maxBuffer` for the synchronous child-process functions. */
const SYNC_DEFAULT_MAX_BUFFER = 1024 * 1024;

/** The signal `spawnSync` sends on timeout or overflow (its `killSignal` default). */
const SYNC_KILL_SIGNAL: NodeJS.Signals = "SIGTERM";

/** The `execFileSync` option subset the Desktop call sites use. */
export type NonBlockingExecFileOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  encoding?: BufferEncoding | "buffer";
  stdio?: StdioOptions;
  timeout?: number;
  maxBuffer?: number;
};

/** The `execSync` option subset the Desktop call sites use. */
export type NonBlockingExecOptions = NonBlockingExecFileOptions & {
  shell?: string;
};

type StringEncodingOptions = { encoding: BufferEncoding };

type SyncShapedResult = {
  error?: NodeJS.ErrnoException;
  status: number | null;
  signal: NodeJS.Signals | null;
  output: Array<string | Buffer | null> | null;
  pid: number;
  stdout: string | Buffer | null | undefined;
  stderr: string | Buffer | null | undefined;
};

type ErrnoSpawnError = NodeJS.ErrnoException & { spawnargs?: string[] };

/**
 * Run `file` like `execFileSync(file, args, options)`, without blocking.
 * Resolves with what `execFileSync` would return; rejects with what it would
 * throw.
 */
export function execFileNonBlocking(
  file: string,
  args: readonly string[],
  options: NonBlockingExecFileOptions & StringEncodingOptions
): Promise<string>;
export function execFileNonBlocking(
  file: string,
  args: readonly string[],
  options?: NonBlockingExecFileOptions
): Promise<Buffer>;
export async function execFileNonBlocking(
  file: string,
  args: readonly string[],
  options: NonBlockingExecFileOptions = {}
): Promise<string | Buffer> {
  const result = await runLikeSpawnSync(
    file,
    args,
    { cwd: options.cwd, env: options.env, stdio: options.stdio ?? "pipe" },
    options
  );
  return finishLikeSync(result, options, [file, ...args].join(" "));
}

/**
 * Run `command` through a shell like `execSync(command, options)`, without
 * blocking. The command string reaches the shell unchanged.
 */
export function execNonBlocking(
  command: string,
  options: NonBlockingExecOptions & StringEncodingOptions
): Promise<string>;
export function execNonBlocking(
  command: string,
  options?: NonBlockingExecOptions
): Promise<Buffer>;
export async function execNonBlocking(
  command: string,
  options: NonBlockingExecOptions = {}
): Promise<string | Buffer> {
  const result = await runLikeSpawnSync(
    command,
    [],
    {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio ?? "pipe",
      shell: options.shell ?? true,
    },
    options
  );
  return finishLikeSync(result, options, command);
}

/**
 * `execFileSync`/`execSync` after `spawnSync` returns: echo the child's stderr
 * when the caller gave no `stdio` (Node pipes it and then writes it to the
 * parent), then throw on a spawn error or a non-zero exit, else return stdout.
 * The return type is `string | Buffer` for the same reason Node's is: with an
 * `ignore` or fd stdout the sync functions return `null`, which the overloads
 * above leave to the few callers that discard the result.
 */
function finishLikeSync(
  result: SyncShapedResult,
  options: NonBlockingExecFileOptions,
  commandText: string
): string | Buffer {
  if (!options.stdio && result.stderr) {
    process.stderr.write(result.stderr);
  }
  const error = syncShapedError(result, commandText);
  if (error) {
    throw error;
  }
  return result.stdout as string | Buffer;
}

/** Node's `checkExecSyncError`, applied to a `spawn`-collected result. */
function syncShapedError(
  result: SyncShapedResult,
  commandText: string
): Error | undefined {
  if (result.error) {
    return Object.assign(result.error, result);
  }
  if (result.status !== 0) {
    let message = `Command failed: ${commandText}`;
    if (result.stderr && result.stderr.length > 0) {
      message += `\n${result.stderr.toString()}`;
    }
    return Object.assign(new Error(message), result);
  }
  return;
}

/** The error `spawnSync` attaches for a child that failed, timed out or overflowed. */
function spawnSyncError(
  code: string,
  file: string,
  args: readonly string[]
): ErrnoSpawnError {
  const syscall = `spawnSync ${file}`;
  const error: ErrnoSpawnError = new Error(`${syscall} ${code}`);
  const errno = (osConstants.errno as Record<string, number | undefined>)[code];
  error.errno = errno === undefined ? undefined : -errno;
  error.code = code;
  error.syscall = syscall;
  error.path = file;
  error.spawnargs = [...args];
  return error;
}

function runLikeSpawnSync(
  file: string,
  args: readonly string[],
  spawnOptions: SpawnOptions,
  options: NonBlockingExecFileOptions
): Promise<SyncShapedResult> {
  return new Promise((resolve) => {
    const maxBuffer = options.maxBuffer ?? SYNC_DEFAULT_MAX_BUFFER;
    const child = spawn(file, [...args], spawnOptions);
    // `spawnfile`/`spawnargs` are what `spawnSync` names in its errors: with a
    // shell they are the shell and `["-c", command]`, not the command.
    const reportedFile = child.spawnfile;
    const reportedArgs = child.spawnargs.slice(1);
    // `spawnSync` with no `input` hands a piped stdin EOF at once. Leaving the
    // pipe open would hang any child that reads stdin (`cat`, a user teardown
    // script) until its timeout. A child that exits first can make the end
    // write fail with EPIPE, which `spawnSync` would never surface either.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end();
    const streams = [child.stdout, child.stderr] as const;
    const chunks: [Buffer[], Buffer[]] = [[], []];
    const sizes = [0, 0];
    let failure: ErrnoSpawnError | undefined;
    let settled = false;

    const failAndKill = (code: string): void => {
      if (failure) {
        return;
      }
      failure = spawnSyncError(code, reportedFile, reportedArgs);
      child.kill(SYNC_KILL_SIGNAL);
      // `spawnSync` closes its stdio pipes when it kills, so it returns even
      // while a grandchild (`sleep 60 &` in a teardown script) still holds
      // them. "close" waits for every holder to reach EOF, so close them here.
      for (const stream of streams) {
        stream?.destroy();
      }
    };

    const timer =
      options.timeout !== undefined && options.timeout > 0
        ? setTimeout(() => failAndKill("ETIMEDOUT"), options.timeout)
        : undefined;

    streams.forEach((stream, index) => {
      stream?.on("data", (chunk: Buffer) => {
        // The chunk that crossed `maxBuffer` is the last one kept; the kill
        // below closes the pipes, so nothing more arrives.
        if (sizes[index] > maxBuffer) {
          return;
        }
        chunks[index].push(chunk);
        sizes[index] += chunk.length;
        if (sizes[index] > maxBuffer) {
          failAndKill("ENOBUFS");
        }
      });
    });

    const settle = (result: SyncShapedResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve(result);
    };

    const collected = (index: 0 | 1): string | Buffer | null => {
      if (!streams[index]) {
        return null;
      }
      const buffer = Buffer.concat(chunks[index]);
      return options.encoding && options.encoding !== "buffer"
        ? buffer.toString(options.encoding)
        : buffer;
    };

    child.on("error", (error: NodeJS.ErrnoException) => {
      // Only a child that never started ends here; `spawnSync` reports that
      // with no output at all. A later error (a failed kill) waits for close.
      if (child.pid !== undefined) {
        return;
      }
      settle({
        error: spawnSyncError(
          error.code ?? "UNKNOWN",
          reportedFile,
          reportedArgs
        ),
        status: null,
        signal: null,
        output: null,
        pid: 0,
        stdout: undefined,
        stderr: undefined,
      });
    });

    child.on("close", (code, signal) => {
      const stdout = collected(0);
      const stderr = collected(1);
      settle({
        ...(failure ? { error: failure } : {}),
        status: code,
        signal,
        output: [null, stdout, stderr],
        pid: child.pid ?? 0,
        stdout,
        stderr,
      });
    });
  });
}
