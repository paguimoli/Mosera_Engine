import { findAccountById } from "../accounts/account.repository";
import type {
  CreatePlayerProfileInput,
  PlayerProfile,
  UpdatePlayerProfileInput,
} from "./player-profile.types";
import {
  createPlayerProfile as createPlayerProfileRecord,
  disablePlayerProfile as disablePlayerProfileRecord,
  findPlayerProfileByAccountId,
  findPlayerProfileByExternalId,
  findPlayerProfileById,
  listPlayerProfiles as listPlayerProfileRecords,
  suspendPlayerProfile as suspendPlayerProfileRecord,
  updatePlayerProfile as updatePlayerProfileRecord,
} from "./player-profile.repository";
import {
  normalizeCreatePlayerProfileInput,
  normalizeUpdatePlayerProfileInput,
  validateCreatePlayerProfileInput,
  validateUpdatePlayerProfileInput,
} from "./player-profile.validation";

export class DuplicatePlayerProfileError extends Error {
  constructor(message = "Duplicate player profile.") {
    super(message);
    this.name = "DuplicatePlayerProfileError";
  }
}

export class PlayerProfileValidationError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(errors.join(" "));
    this.name = "PlayerProfileValidationError";
    this.errors = errors;
  }
}

export class PlayerProfileBusinessRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlayerProfileBusinessRuleError";
  }
}

function enforceExternalIdPair(input: {
  externalPlayerId?: string | null;
  externalPlatform?: string | null;
}) {
  if (input.externalPlayerId && !input.externalPlatform) {
    throw new PlayerProfileBusinessRuleError(
      "External platform is required when external player id is provided."
    );
  }

  if (input.externalPlatform && !input.externalPlayerId) {
    throw new PlayerProfileBusinessRuleError(
      "External player id is required when external platform is provided."
    );
  }
}

async function assertPlayerAccountIsEligible(accountId: string) {
  const account = await findAccountById(accountId);

  if (!account) {
    throw new PlayerProfileBusinessRuleError("Account not found.");
  }

  if (account.accountType !== "PLAYER") {
    throw new PlayerProfileBusinessRuleError(
      "Player profiles may only be created for PLAYER accounts."
    );
  }

  if (account.status !== "ACTIVE") {
    throw new PlayerProfileBusinessRuleError("Player account must be active.");
  }
}

export async function createPlayerProfile(
  input: CreatePlayerProfileInput
): Promise<PlayerProfile> {
  const validation = validateCreatePlayerProfileInput(input);

  if (!validation.valid) {
    throw new PlayerProfileValidationError(validation.errors);
  }

  const normalized = normalizeCreatePlayerProfileInput(input);

  enforceExternalIdPair(normalized);
  await assertPlayerAccountIsEligible(normalized.accountId);

  const existingProfile = await findPlayerProfileByAccountId(normalized.accountId);

  if (existingProfile) {
    throw new DuplicatePlayerProfileError();
  }

  if (normalized.externalPlatform && normalized.externalPlayerId) {
    const externalProfile = await findPlayerProfileByExternalId(
      normalized.externalPlatform,
      normalized.externalPlayerId
    );

    if (externalProfile) {
      throw new DuplicatePlayerProfileError(
        "External player profile already exists."
      );
    }
  }

  return createPlayerProfileRecord(normalized);
}

export async function updatePlayerProfile(
  id: string,
  input: UpdatePlayerProfileInput
): Promise<PlayerProfile> {
  const validation = validateUpdatePlayerProfileInput(input);

  if (!validation.valid) {
    throw new PlayerProfileValidationError(validation.errors);
  }

  const existingProfile = await findPlayerProfileById(id);

  if (!existingProfile) {
    throw new PlayerProfileBusinessRuleError("Player profile not found.");
  }

  const normalized = normalizeUpdatePlayerProfileInput(input);
  const resultingExternalPlayerId =
    normalized.externalPlayerId !== undefined
      ? normalized.externalPlayerId
      : existingProfile.externalPlayerId ?? null;
  const resultingExternalPlatform =
    normalized.externalPlatform !== undefined
      ? normalized.externalPlatform
      : existingProfile.externalPlatform ?? null;

  enforceExternalIdPair({
    externalPlayerId: resultingExternalPlayerId,
    externalPlatform: resultingExternalPlatform,
  });

  if (normalized.accountId) {
    await assertPlayerAccountIsEligible(normalized.accountId);

    const accountProfile = await findPlayerProfileByAccountId(normalized.accountId);

    if (accountProfile && accountProfile.id !== id) {
      throw new DuplicatePlayerProfileError();
    }
  }

  if (resultingExternalPlatform && resultingExternalPlayerId) {
    const externalProfile = await findPlayerProfileByExternalId(
      resultingExternalPlatform,
      resultingExternalPlayerId
    );

    if (externalProfile && externalProfile.id !== id) {
      throw new DuplicatePlayerProfileError(
        "External player profile already exists."
      );
    }
  }

  return updatePlayerProfileRecord(id, normalized);
}

export async function disablePlayerProfile(id: string): Promise<PlayerProfile> {
  const playerProfile = await findPlayerProfileById(id);

  if (!playerProfile) {
    throw new PlayerProfileBusinessRuleError("Player profile not found.");
  }

  return disablePlayerProfileRecord(id);
}

export async function suspendPlayerProfile(id: string): Promise<PlayerProfile> {
  const playerProfile = await findPlayerProfileById(id);

  if (!playerProfile) {
    throw new PlayerProfileBusinessRuleError("Player profile not found.");
  }

  return suspendPlayerProfileRecord(id);
}

export async function listPlayerProfiles(): Promise<PlayerProfile[]> {
  return listPlayerProfileRecords();
}
