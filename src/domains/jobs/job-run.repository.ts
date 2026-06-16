import { supabaseServerAdmin } from "@/src/lib/supabase/server-admin-client";
import type {
  CompleteJobRunInput,
  FailJobRunInput,
  JobRun,
  JobRunMetadata,
  JobRunStatus,
  ListRecentJobRunsInput,
  StartJobRunInput,
} from "./job-run.types";

type JobRunRow = {
  id: string;
  job_name: string;
  status: JobRunStatus;
  started_at: string;
  finished_at?: string | null;
  attempt_count: number;
  correlation_id?: string | null;
  metadata: JobRunMetadata | null;
  error_message?: string | null;
};

const JOB_RUN_SELECT =
  "id, job_name, status, started_at, finished_at, attempt_count, correlation_id, metadata, error_message";

export class JobRunRepositoryError extends Error {
  constructor(message = "Job run persistence operation failed.") {
    super(message);
    this.name = "JobRunRepositoryError";
  }
}

function mapJobRunRow(row: JobRunRow | null): JobRun | null {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    jobName: row.job_name,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? null,
    attemptCount: row.attempt_count,
    correlationId: row.correlation_id ?? null,
    metadata: row.metadata ?? {},
    errorMessage: row.error_message ?? null,
  };
}

export async function startJobRun(input: StartJobRunInput): Promise<JobRun> {
  const { data, error } = await supabaseServerAdmin
    .from("job_runs")
    .insert({
      job_name: input.jobName,
      status: "STARTED",
      attempt_count: input.attemptCount ?? 1,
      correlation_id: input.correlationId ?? null,
      metadata: input.metadata ?? {},
    })
    .select(JOB_RUN_SELECT)
    .single();

  if (error) {
    throw new JobRunRepositoryError();
  }

  const jobRun = mapJobRunRow(data as JobRunRow | null);

  if (!jobRun) {
    throw new JobRunRepositoryError();
  }

  return jobRun;
}

export async function completeJobRun(
  input: CompleteJobRunInput
): Promise<JobRun> {
  const { data, error } = await supabaseServerAdmin
    .from("job_runs")
    .update({
      status: "SUCCEEDED",
      finished_at: new Date().toISOString(),
      metadata: input.metadata ?? {},
      error_message: null,
    })
    .eq("id", input.jobRunId)
    .select(JOB_RUN_SELECT)
    .single();

  if (error) {
    throw new JobRunRepositoryError();
  }

  const jobRun = mapJobRunRow(data as JobRunRow | null);

  if (!jobRun) {
    throw new JobRunRepositoryError();
  }

  return jobRun;
}

export async function failJobRun(input: FailJobRunInput): Promise<JobRun> {
  const { data, error } = await supabaseServerAdmin
    .from("job_runs")
    .update({
      status: "FAILED",
      finished_at: new Date().toISOString(),
      metadata: input.metadata ?? {},
      error_message: input.errorMessage,
    })
    .eq("id", input.jobRunId)
    .select(JOB_RUN_SELECT)
    .single();

  if (error) {
    throw new JobRunRepositoryError();
  }

  const jobRun = mapJobRunRow(data as JobRunRow | null);

  if (!jobRun) {
    throw new JobRunRepositoryError();
  }

  return jobRun;
}

export async function listRecentJobRuns(
  input: ListRecentJobRunsInput = {}
): Promise<JobRun[]> {
  const limit = input.limit ?? 50;
  let query = supabaseServerAdmin
    .from("job_runs")
    .select(JOB_RUN_SELECT)
    .order("started_at", { ascending: false })
    .limit(limit);

  if (input.jobName) {
    query = query.eq("job_name", input.jobName);
  }

  if (input.status) {
    query = query.eq("status", input.status);
  }

  const { data, error } = await query;

  if (error) {
    throw new JobRunRepositoryError();
  }

  return ((data ?? []) as JobRunRow[])
    .map(mapJobRunRow)
    .filter((jobRun): jobRun is JobRun => Boolean(jobRun));
}
