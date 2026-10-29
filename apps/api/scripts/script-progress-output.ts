import { format } from "node:util";

export type ScriptWritable = {
  write(chunk: string, callback: (error?: Error | null) => void): boolean;
};

export type ScriptOutput = {
  log: (...parts: unknown[]) => Promise<void>;
  warn: (...parts: unknown[]) => Promise<void>;
  error: (...parts: unknown[]) => Promise<void>;
};

/** Write one newline-terminated script output record and wait for the stream. */
export function writeScriptLine(
  stream: ScriptWritable,
  line: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      stream.write(`${line}\n`, (error?: Error | null) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

export function createScriptOutput(
  streams: { stdout?: ScriptWritable; stderr?: ScriptWritable } = {}
): ScriptOutput {
  const stdout = streams.stdout ?? process.stdout;
  const stderr = streams.stderr ?? process.stderr;

  return {
    log: (...parts) => writeScriptLine(stdout, formatScriptMessage(parts)),
    warn: (...parts) => writeScriptLine(stderr, formatScriptMessage(parts)),
    error: (...parts) => writeScriptLine(stderr, formatScriptMessage(parts)),
  };
}

export const scriptOutput = createScriptOutput();

function formatScriptMessage(parts: unknown[]): string {
  return format(...parts);
}
