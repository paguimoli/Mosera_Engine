export type RepositoryResult<T> = {
  success: boolean;
  data?: T;
  error?: string;
};

export function repositorySuccess<T>(data: T): RepositoryResult<T> {
  return { success: true, data };
}

export function repositoryFailure(error: string): RepositoryResult<never> {
  return { success: false, error };
}
