import type { JobRun, JobRunMetadata, JobRunStatus } from "../jobs/job-run.types";

export type WorkerName = "outbox_dispatcher" | string;

export type WorkerRunStatus = JobRunStatus;

export type OutboxDispatchResult = {
  processed: number;
  published: number;
  failed: number;
  deadLettered: number;
};

export type WorkerExecutionResult<TResult> = {
  success: boolean;
  jobRun: JobRun;
  result?: TResult;
  errorMessage?: string;
};

export type RetryPolicy = {
  maxAttempts: number;
};

export type RunTrackedJobInput<TResult> = {
  jobName: WorkerName;
  correlationId?: string | null;
  metadata?: JobRunMetadata;
  rethrow?: boolean;
  execute: (jobRun: JobRun) => Promise<TResult>;
};
