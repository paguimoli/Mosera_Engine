import { supabaseServerAdmin } from "@/src/lib/supabase/server-admin-client";
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

const PLAYER_PROFILE_SELECT =
  "id, account_id, first_name, last_name, display_name, email, phone, date_of_birth, external_player_id, external_platform, status, created_at, updated_at";

export class PlayerProfileRepositoryError extends Error {
  constructor(message = "Player profile persistence operation failed.") {
    super(message);
    this.name = "PlayerProfileRepositoryError";
  }
}

function mapPlayerProfileRow(row: PlayerProfileRow | null): PlayerProfile | null {
  if (!row) {
    return null;
  }

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
  const { data, error } = await supabaseServerAdmin
    .from("player_profiles")
    .insert({
      account_id: normalized.accountId,
      first_name: normalized.firstName ?? null,
      last_name: normalized.lastName ?? null,
      display_name: normalized.displayName,
      email: normalized.email ?? null,
      phone: normalized.phone ?? null,
      date_of_birth: normalized.dateOfBirth ?? null,
      external_player_id: normalized.externalPlayerId ?? null,
      external_platform: normalized.externalPlatform ?? null,
      status: normalized.status ?? "ACTIVE",
    })
    .select(PLAYER_PROFILE_SELECT)
    .single();

  if (error) {
    throw new PlayerProfileRepositoryError();
  }

  const playerProfile = mapPlayerProfileRow(data as PlayerProfileRow | null);

  if (!playerProfile) {
    throw new PlayerProfileRepositoryError();
  }

  return playerProfile;
}

export async function updatePlayerProfile(
  id: string,
  input: UpdatePlayerProfileInput
): Promise<PlayerProfile> {
  const normalized = normalizeUpdatePlayerProfileInput(input);
  const updatePayload: Record<string, string | null> = {};

  if (normalized.accountId !== undefined) {
    updatePayload.account_id = normalized.accountId;
  }
  if (normalized.firstName !== undefined) {
    updatePayload.first_name = normalized.firstName ?? null;
  }
  if (normalized.lastName !== undefined) {
    updatePayload.last_name = normalized.lastName ?? null;
  }
  if (normalized.displayName !== undefined) {
    updatePayload.display_name = normalized.displayName;
  }
  if (normalized.email !== undefined) updatePayload.email = normalized.email ?? null;
  if (normalized.phone !== undefined) updatePayload.phone = normalized.phone ?? null;
  if (normalized.dateOfBirth !== undefined) {
    updatePayload.date_of_birth = normalized.dateOfBirth ?? null;
  }
  if (normalized.externalPlayerId !== undefined) {
    updatePayload.external_player_id = normalized.externalPlayerId ?? null;
  }
  if (normalized.externalPlatform !== undefined) {
    updatePayload.external_platform = normalized.externalPlatform ?? null;
  }
  if (normalized.status !== undefined) updatePayload.status = normalized.status;

  const { data, error } = await supabaseServerAdmin
    .from("player_profiles")
    .update(updatePayload)
    .eq("id", id)
    .select(PLAYER_PROFILE_SELECT)
    .single();

  if (error) {
    throw new PlayerProfileRepositoryError();
  }

  const playerProfile = mapPlayerProfileRow(data as PlayerProfileRow | null);

  if (!playerProfile) {
    throw new PlayerProfileRepositoryError();
  }

  return playerProfile;
}

export async function findPlayerProfileById(
  id: string
): Promise<PlayerProfile | null> {
  const { data, error } = await supabaseServerAdmin
    .from("player_profiles")
    .select(PLAYER_PROFILE_SELECT)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw new PlayerProfileRepositoryError();
  }

  return mapPlayerProfileRow(data as PlayerProfileRow | null);
}

export async function findPlayerProfileByAccountId(
  accountId: string
): Promise<PlayerProfile | null> {
  const { data, error } = await supabaseServerAdmin
    .from("player_profiles")
    .select(PLAYER_PROFILE_SELECT)
    .eq("account_id", accountId)
    .maybeSingle();

  if (error) {
    throw new PlayerProfileRepositoryError();
  }

  return mapPlayerProfileRow(data as PlayerProfileRow | null);
}

export async function findPlayerProfileByExternalId(
  externalPlatform: string,
  externalPlayerId: string
): Promise<PlayerProfile | null> {
  const { data, error } = await supabaseServerAdmin
    .from("player_profiles")
    .select(PLAYER_PROFILE_SELECT)
    .eq("external_platform", externalPlatform.trim())
    .eq("external_player_id", externalPlayerId.trim())
    .maybeSingle();

  if (error) {
    throw new PlayerProfileRepositoryError();
  }

  return mapPlayerProfileRow(data as PlayerProfileRow | null);
}

export async function listPlayerProfiles(): Promise<PlayerProfile[]> {
  const { data, error } = await supabaseServerAdmin
    .from("player_profiles")
    .select(PLAYER_PROFILE_SELECT)
    .order("display_name", { ascending: true });

  if (error) {
    throw new PlayerProfileRepositoryError();
  }

  return ((data ?? []) as PlayerProfileRow[])
    .map(mapPlayerProfileRow)
    .filter(
      (playerProfile): playerProfile is PlayerProfile => Boolean(playerProfile)
    );
}

export async function disablePlayerProfile(
  id: string
): Promise<PlayerProfile> {
  return updatePlayerProfile(id, { status: "DISABLED" });
}

export async function suspendPlayerProfile(
  id: string
): Promise<PlayerProfile> {
  return updatePlayerProfile(id, { status: "SUSPENDED" });
}
