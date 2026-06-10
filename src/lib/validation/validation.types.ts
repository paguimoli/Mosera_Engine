export type ValidationResult = {
  valid: boolean;
  errors: string[];
};

export function valid(): ValidationResult {
  return { valid: true, errors: [] };
}

export function invalid(errors: string | string[]): ValidationResult {
  return {
    valid: false,
    errors: Array.isArray(errors) ? errors : [errors],
  };
}
