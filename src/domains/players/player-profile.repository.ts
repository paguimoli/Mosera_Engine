import { Pool } from "pg";

import type {
  CreatePlayerProfileInput,
  PlayerProfile,
  PlayerProfileStatus,
  UpdatePlayerProfileInput,
} from "./player-profile.types";
import {
  normalizeCreatePlayerProfileInput,
  normalizeUpdatePlayerProfileInput,
} from "./player-profile.validation";

type PlayerProfileRow = {
  id: string;
  account_id: string;
  first_name?: string | null;
  last_name?: string | null;
  display_name: string;
  email?: string | null;
  phone?: string | null;
  date_of_birth?: string | null;
  external_player_id?: string | null;
  external_platform?: string | null;
  status: PlayerProfileStatus;
  created_at: string;
  updated_at?: string | null;
};

const PLAYER_PROFILE_SELECT = `
  profile.id,
  profile.account_id,
  profile.first_name,
  profile.last_name,
  profile.display_name,
  profile.email,
  profile.phone,
  profile.date_of_birth,
  profile.external_player_id,
  profile.external_platform,
  profile.status,
  profile.created_at,
  profile.updated_at
`;
const GOVERNED_PROFILE_FROM = `
  from public.player_profiles profile
  join public.accounts account
    on account.id = profile.account_id
    and account.governance_managed
    and account.account_type = 'PLAYER'
`;

let pool: Pool | null = null;

export class PlayerProfileRepositoryError extends Error {
  constructor(message = "Player profile persistence operation failed.") {
    super(message);
    this.name = "PlayerProfileRepositoryError";
  }
}

function databasePool() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new PlayerProfileRepositoryError(
      "Player profile database is not configured."
    );
  }

  pool ??= new Pool({
    connectionString: databaseUrl,
    max: 4,
    idleTimeoutMillis: 5_000,
  });
  return pool;
}

function mapPlayerProfileRow(row: PlayerProfileRow | null): PlayerProfile | null {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    firstName: row.first_name ?? null,
    lastName: row.last_name ?? null,
    displayName: row.display_name,
    email: row.email ?? null,
    phone: row.phone ?? null,
    dateOfBirth: row.date_of_birth ?? null,
    externalPlayerId: row.external_player_id ?? null,
    externalPlatform: row.external_platform ?? null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? null,
  };
}

export async function createPlayerProfile(
  input: CreatePlayerProfileInput
): Promise<PlayerProfile> {
  const normalized = normalizeCreatePlayerProfileInput(input);
  try {
    const result = await databasePool().query<PlayerProfileRow>(
      `insert into public.player_profiles (
         account_id, first_name, last_name, display_name, email, phone,
         date_of_birth, external_player_id, external_platform, status
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       returning
         id, account_id, first_name, last_name, display_name, email, phone,
         date_of_birth, external_player_id, external_platform, status,
         created_at, updated_at`,
      [
        normalized.accountId,
        normalized.firstName ?? null,
        normalized.lastName ?? null,
        normalized.displayName,
        normalized.email ?? null,
        normalized.phone ?? null,
        normalized.dateOfBirth ?? null,
        normalized.externalPlayerId ?? null,
        normalized.externalPlatform ?? null,
        normalized.status ?? "ACTIVE",
      ]
    );
    return mapPlayerProfileRow(result.rows[0] ?? null)!;
  } catch (error) {
    throw new PlayerProfileRepositoryError(
      error instanceof Error ? error.message : undefined
    );
  }
}

export async function updatePlayerProfile(
  id: string,
  input: UpdatePlayerProfileInput
): Promise<PlayerProfile> {
  const normalized = normalizeUpdatePlayerProfileInput(input);
  const assignments: string[] = [];
  const values: unknown[] = [];
  const set = (column: string, value: unknown) => {
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  };

  if (normalized.accountId !== undefined) set("account_id", normalized.accountId);
  if (normalized.firstName !== undefined) set("first_name", normalized.firstName ?? null);
  if (normalized.lastName !== undefined) set("last_name", normalized.lastName ?? null);
  if (normalized.displayName !== undefined) set("display_name", normalized.displayName);
  if (normalized.email !== undefined) set("email", normalized.email ?? null);
  if (normalized.phone !== undefined) set("phone", normalized.phone ?? null);
  if (normalized.dateOfBirth !== undefined) set("date_of_birth", normalized.dateOfBirth ?? null);
  if (normalized.externalPlayerId !== undefined) {
    set("external_player_id", normalized.externalPlayerId ?? null);
  }
  if (normalized.externalPlatform !== undefined) {
    set("external_platform", normalized.externalPlatform ?? null);
  }
  if (normalized.status !== undefined) set("status", normalized.status);

  if (assignments.length === 0) {
    const existing = await findPlayerProfileById(id);
    if (!existing) throw new PlayerProfileRepositoryError("Player profile not found.");
    return existing;
  }

  values.push(id);
  try {
    const result = await databasePool().query<PlayerProfileRow>(
      `update public.player_profiles
       set ${assignments.join(", ")}
       where id = $${values.length}
         and exists (
           select 1
           from public.accounts account
           where account.id = public.player_profiles.account_id
             and account.governance_managed
         )
       returning
         id, account_id, first_name, last_name, display_name, email, phone,
         date_of_birth, external_player_id, external_platform, status,
         created_at, updated_at`,
      values
    );
    const profile = mapPlayerProfileRow(result.rows[0] ?? null);
    if (!profile) throw new PlayerProfileRepositoryError("Player profile not found.");
    return profile;
  } catch (error) {
    throw error instanceof PlayerProfileRepositoryError
      ? error
      : new PlayerProfileRepositoryError(
          error instanceof Error ? error.message : undefined
        );
  }
}

export async function findPlayerProfileById(id: string): Promise<PlayerProfile | null> {
  const result = await databasePool().query<PlayerProfileRow>(
    `select ${PLAYER_PROFILE_SELECT} ${GOVERNED_PROFILE_FROM}
     where profile.id = $1`,
    [id]
  );
  return mapPlayerProfileRow(result.rows[0] ?? null);
}

export async function findPlayerProfileByAccountId(
  accountId: string
): Promise<PlayerProfile | null> {
  const result = await databasePool().query<PlayerProfileRow>(
    `select ${PLAYER_PROFILE_SELECT} ${GOVERNED_PROFILE_FROM}
     where profile.account_id = $1`,
    [accountId]
  );
  return mapPlayerProfileRow(result.rows[0] ?? null);
}

export async function findPlayerProfileByExternalId(
  externalPlatform: string,
  externalPlayerId: string
): Promise<PlayerProfile | null> {
  const result = await databasePool().query<PlayerProfileRow>(
    `select ${PLAYER_PROFILE_SELECT} ${GOVERNED_PROFILE_FROM}
     where profile.external_platform = $1 and profile.external_player_id = $2`,
    [externalPlatform.trim(), externalPlayerId.trim()]
  );
  return mapPlayerProfileRow(result.rows[0] ?? null);
}

export async function listPlayerProfiles(): Promise<PlayerProfile[]> {
  const result = await databasePool().query<PlayerProfileRow>(
    `select ${PLAYER_PROFILE_SELECT} ${GOVERNED_PROFILE_FROM}
     order by profile.display_name`
  );
  return result.rows
    .map(mapPlayerProfileRow)
    .filter((profile): profile is PlayerProfile => Boolean(profile));
}

export async function disablePlayerProfile(id: string): Promise<PlayerProfile> {
  return updatePlayerProfile(id, { status: "DISABLED" });
}

export async function suspendPlayerProfile(id: string): Promise<PlayerProfile> {
  return updatePlayerProfile(id, { status: "SUSPENDED" });
}
