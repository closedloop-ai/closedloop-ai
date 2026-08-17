import { readFile } from "node:fs/promises";
import {
  enrichJobSnapshot,
  type JobSnapshot,
} from "../../server/operations/symphony-job-snapshot.js";
import {
  isTerminalJobStatus,
  type JobStore,
  type LocalJob,
} from "../jobs/job-store.js";
import { assertTrustedIpcSender } from "./ipc-trusted-sender.js";

export const JobsIpcChannel = {
  ListRunningJobs: "desktop:list-running-jobs",
  ListCompletedJobs: "desktop:list-completed-jobs",
  GetJob: "desktop:get-job",
  GetJobLogTail: "desktop:get-job-log-tail",
} as const;

export type JobsIpcChannel =
  (typeof JobsIpcChannel)[keyof typeof JobsIpcChannel];

type IpcMainLike = {
  handle: (
    channel: JobsIpcChannel,
    listener: (event: unknown, ...args: unknown[]) => unknown
  ) => void;
};

type JobsIpcDeps = {
  /** Reject IPC events whose sender is not the trusted renderer window. */
  isTrustedSender: (sender: unknown) => boolean;
  jobStore: JobStore;
};

function shouldDeferClaimedJobSnapshot(
  rawJob: LocalJob | undefined,
  snapshot: LocalJob
): rawJob is LocalJob {
  if (!rawJob || rawJob.exitCode == null) {
    return false;
  }
  return !(snapshot.status === "COMPLETED" && rawJob.exitCode === 0);
}

export function registerJobsIpcHandlers(
  ipcMainLike: IpcMainLike,
  deps: JobsIpcDeps
): void {
  ipcMainLike.handle(JobsIpcChannel.ListRunningJobs, async (event) => {
    // Gate before any store work: this handler calls jobStore.upsert to
    // reconcile terminal status (a mutation despite the getter name), so an
    // untrusted/secondary renderer must not reach it. Matches the sibling
    // IPC modules' assert-first shape.
    assertTrustedIpcSender(deps.isTrustedSender, event);
    const jobs = deps.jobStore.listRunning();
    const snapshots = await Promise.all(jobs.map((j) => enrichJobSnapshot(j)));

    // Reconcile: if enrichment detected a terminal status (process dead),
    // persist it so the job moves from active to terminal in the store.
    // Skip claimed jobs only when the snapshot is still an exit-race guess.
    // A clean harness completion with its required artifact present is
    // artifact-backed, so reconciliation can safely move it to terminal.
    const stillRunning: JobSnapshot[] = [];
    for (const snapshot of snapshots) {
      const rawJob = deps.jobStore.getById(snapshot.id);
      if (
        isTerminalJobStatus(snapshot.status) &&
        !isTerminalJobStatus(rawJob?.status ?? "UNKNOWN")
      ) {
        if (shouldDeferClaimedJobSnapshot(rawJob, snapshot)) {
          stillRunning.push({ ...snapshot, status: rawJob.status });
          continue;
        }
        deps.jobStore.upsert({
          ...rawJob!,
          status: snapshot.status,
          updatedAt: new Date().toISOString(),
          completedAt: snapshot.completedAt ?? new Date().toISOString(),
        });
      } else if (!isTerminalJobStatus(snapshot.status)) {
        stillRunning.push(snapshot);
      }
    }

    return stillRunning;
  });
  ipcMainLike.handle(JobsIpcChannel.ListCompletedJobs, (event) => {
    assertTrustedIpcSender(deps.isTrustedSender, event);
    return deps.jobStore.listCompleted();
  });
  ipcMainLike.handle(JobsIpcChannel.GetJob, (event, jobId) => {
    assertTrustedIpcSender(deps.isTrustedSender, event);
    if (typeof jobId !== "string" || !jobId.trim()) {
      throw new Error("jobId is required");
    }
    return deps.jobStore.getById(jobId.trim()) ?? null;
  });
  ipcMainLike.handle(
    JobsIpcChannel.GetJobLogTail,
    async (event, jobId, lines) => {
      assertTrustedIpcSender(deps.isTrustedSender, event);
      if (typeof jobId !== "string" || !jobId.trim()) {
        throw new Error("jobId is required");
      }
      const job = deps.jobStore.getById(jobId.trim());
      if (!job?.logPath) {
        return null;
      }
      try {
        const content = await readFile(job.logPath, "utf-8");
        const allLines = content.split("\n");
        const maxLines = typeof lines === "number" && lines > 0 ? lines : 200;
        return allLines.slice(-maxLines).join("\n");
      } catch {
        return null;
      }
    }
  );
}
