export type PlayerProfileStatus = "ACTIVE" | "SUSPENDED" | "DISABLED";

export type PlayerProfile = {
  id: string;
  accountId: string;
  firstName?: string | null;
  lastName?: string | null;
  displayName: string;
  email?: string | null;
  phone?: string | null;
  dateOfBirth?: string | null;
  externalPlayerId?: string | null;
  externalPlatform?: string | null;
  status: PlayerProfileStatus;
  createdAt: string;
  updatedAt?: string | null;
};

export type CreatePlayerProfileInput = {
  accountId: string;
  firstName?: string | null;
  lastName?: string | null;
  displayName: string;
  email?: string | null;
  phone?: string | null;
  dateOfBirth?: string | null;
  externalPlayerId?: string | null;
  externalPlatform?: string | null;
  status?: PlayerProfileStatus;
};

export type UpdatePlayerProfileInput = Partial<CreatePlayerProfileInput>;
