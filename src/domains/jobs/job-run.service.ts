import {
  completeJobRun as completeJobRunRecord,
  failJobRun as failJobRunRecord,
  listRecentJobRuns as listRecentJobRunRecords,
  startJobRun as startJobRunRecord,
} from "./job-run.repository";
import type {
  CompleteJobRunInput,
  FailJobRunInput,
  JobRun,
  ListRecentJobRunsInput,
  StartJobRunInput,
} from "./job-run.types";

export async function startJobRun(input: StartJobRunInput): Promise<JobRun> {
  return startJobRunRecord(input);
}

export async function completeJobRun(
  input: CompleteJobRunInput
): Promise<JobRun> {
  return completeJobRunRecord(input);
}

export async function failJobRun(input: FailJobRunInput): Promise<JobRun> {
  return failJobRunRecord(input);
}

export async function listRecentJobRuns(
  input: ListRecentJobRunsInput = {}
): Promise<JobRun[]> {
  return listRecentJobRunRecords(input);
}
