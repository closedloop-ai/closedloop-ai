/**
 * @file pre-init-log-buffer.ts
 * @description Holds durable-log lines written BEFORE the file transport knows
 * which profile it belongs to (ISS-4916, codex review).
 *
 * electron-log's file transport resolves the DEFAULT (production) path until
 * `initializePersistentLogging` configures the redirect, so any write before
 * that point lands in the operator's real `main.log` even on a redirected
 * launch — the macOS GPU-workaround line, the single-instance-lock line and the
 * userData-migration lines all do exactly that. Those writes are buffered here
 * instead and replayed once the transport points at the right file.
 *
 * Kept free of `electron` and `electron-log` imports so the buffering rules are
 * unit-testable without booting Electron, the same way main-log-location.ts
 * keeps the path decision testable.
 */

export type BufferedLogLine<TLevel> = {
  level: TLevel;
  line: string;
};

export class PreInitLogBuffer<TLevel> {
  private readonly lines: BufferedLogLine<TLevel>[] = [];
  private open = true;
  private droppedCount = 0;
  /**
   * Hard cap on held lines, so a launch path that exits before initializing
   * (the single-instance-lock quit, a fatal config error) can never grow this
   * without bound.
   */
  private readonly maxLines: number;

  constructor(maxLines: number) {
    this.maxLines = maxLines;
  }

  /**
   * Offers one line to the buffer. Returns true when the buffer took
   * responsibility for it — the caller must NOT write it — and false once the
   * buffer has been drained, after which every line goes straight through.
   * A line offered while full is dropped rather than evicting an earlier one:
   * the EARLIEST lines are the boot record this exists to preserve.
   */
  capture(level: TLevel, line: string): boolean {
    if (!this.open) {
      return false;
    }
    if (this.lines.length >= this.maxLines) {
      this.droppedCount += 1;
      return true;
    }
    this.lines.push({ level, line });
    return true;
  }

  /**
   * Closes the buffer and hands back everything held, in write order. Every
   * later `capture` returns false, so this is a one-way transition and the
   * replay below cannot be re-buffered by the sink it is replaying into.
   */
  drain(): BufferedLogLine<TLevel>[] {
    this.open = false;
    const drained = [...this.lines];
    this.lines.length = 0;
    return drained;
  }

  /** Lines refused because the cap was already reached. */
  get dropped(): number {
    return this.droppedCount;
  }
}
