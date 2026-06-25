-- Additive enum values for webhook-synced GitHub PR review-thread resolution events.
ALTER TYPE "WorkstreamEventType" ADD VALUE IF NOT EXISTS 'GITHUB_PR_THREAD_RESOLVED';
ALTER TYPE "WorkstreamEventType" ADD VALUE IF NOT EXISTS 'GITHUB_PR_THREAD_UNRESOLVED';
