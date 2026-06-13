export type PasswordValidationResult = {
  valid: boolean;
  errors: string[];
};

export type PasswordPolicyInput = {
  password: string;
  username?: string | null;
  email?: string | null;
};

export type Argon2idPasswordHash = {
  algorithm: "argon2id";
  hash: string;
  createdAt: string;
  version?: string | null;
};

export type PasswordVerificationResult = {
  valid: boolean;
};
