import argon2 from "argon2";
import {
  ARGON2ID_ALGORITHM,
  ARGON2ID_PASSWORD_SETTINGS,
} from "./auth.constants";
import type { Argon2idPasswordHash } from "./password.types";

export class PasswordInfrastructureError extends Error {
  constructor(message = "Password operation failed.") {
    super(message);
    this.name = "PasswordInfrastructureError";
  }
}

export type PasswordHashMetadata = Argon2idPasswordHash;

export function isArgon2idPasswordHash(
  metadata?: Partial<PasswordHashMetadata> | null
) {
  return metadata?.algorithm === ARGON2ID_ALGORITHM && Boolean(metadata.hash);
}

export function maskPasswordHash(hash: string) {
  if (hash.length <= 8) {
    return "********";
  }

  return `${hash.slice(0, 4)}...${hash.slice(-4)}`;
}

export function buildPasswordHashMetadata(input: {
  hash: string;
  createdAt?: string;
  version?: string | null;
}): PasswordHashMetadata {
  return {
    algorithm: ARGON2ID_ALGORITHM,
    hash: input.hash,
    createdAt: input.createdAt || new Date().toISOString(),
    version: input.version || null,
  };
}

export async function hashPassword(password: string): Promise<string> {
  if (!password) {
    throw new PasswordInfrastructureError();
  }

  try {
    return await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: ARGON2ID_PASSWORD_SETTINGS.memoryCost,
      timeCost: ARGON2ID_PASSWORD_SETTINGS.timeCost,
      parallelism: ARGON2ID_PASSWORD_SETTINGS.parallelism,
      hashLength: ARGON2ID_PASSWORD_SETTINGS.hashLength,
    });
  } catch {
    throw new PasswordInfrastructureError();
  }
}

export async function verifyPassword(
  password: string,
  passwordHash: string
): Promise<boolean> {
  if (!password || !passwordHash) {
    return false;
  }

  try {
    return await argon2.verify(passwordHash, password);
  } catch {
    return false;
  }
}
