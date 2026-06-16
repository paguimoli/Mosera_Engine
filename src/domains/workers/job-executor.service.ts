import { logger } from "@/src/lib/observability/logger";
import { completeJobRun, failJobRun, startJobRun } from "../jobs/job-run.service";
import type { RunTrackedJobInput, WorkerExecutionResult } from "./worker.types";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown worker error.";
}

export async function runTrackedJob<TResult>(
  input: RunTrackedJobInput<TResult> & { rethrow: false }
): Promise<WorkerExecutionResult<TResult>>;
export async function runTrackedJob<TResult>(
  input: RunTrackedJobInput<TResult> & { rethrow?: true }
): Promise<TResult>;
export async function runTrackedJob<TResult>(
  input: RunTrackedJobInput<TResult>
): Promise<TResult | WorkerExecutionResult<TResult>> {
  const jobRun = await startJobRun({
    jobName: input.jobName,
    correlationId: input.correlationId ?? null,
    metadata: input.metadata ?? {},
  });

  try {
    const result = await input.execute(jobRun);
    const completedJobRun = await completeJobRun({
      jobRunId: jobRun.id,
      metadata: {
        ...(input.metadata ?? {}),
        result,
      },
    });

    if (input.rethrow === false) {
      return {
        success: true,
        jobRun: completedJobRun,
        result,
      };
    }

    return result;
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    const failedJobRun = await failJobRun({
      jobRunId: jobRun.id,
      errorMessage,
      metadata: input.metadata ?? {},
    });

    logger.error({
      message: "Tracked job failed.",
      correlationId: input.correlationId ?? null,
      metadata: {
        jobName: input.jobName,
        jobRunId: jobRun.id,
        error: errorMessage,
      },
    });

    if (input.rethrow === false) {
      return {
        success: false,
        jobRun: failedJobRun,
        errorMessage,
      };
    }

    throw error;
  }
}
