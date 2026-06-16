export type JobRunStatus = "STARTED" | "SUCCEEDED" | "FAILED";

export type JobRunMetadata = Record<string, unknown>;

export type JobRun = {
  id: string;
  jobName: string;
  status: JobRunStatus;
  startedAt: string;
  finishedAt?: string | null;
  attemptCount: number;
  correlationId?: string | null;
  metadata: JobRunMetadata;
  errorMessage?: string | null;
};

export type StartJobRunInput = {
  jobName: string;
  attemptCount?: number;
  correlationId?: string | null;
  metadata?: JobRunMetadata;
};

export type CompleteJobRunInput = {
  jobRunId: string;
  metadata?: JobRunMetadata;
};

export type FailJobRunInput = {
  jobRunId: string;
  errorMessage: string;
  metadata?: JobRunMetadata;
};

export type ListRecentJobRunsInput = {
  limit?: number;
  jobName?: string;
  status?: JobRunStatus;
};
