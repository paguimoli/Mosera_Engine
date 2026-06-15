import { invalid, valid } from "@/src/lib/validation/validation.types";
import type { ValidationResult } from "@/src/lib/validation/validation.types";
import type {
  CreateAccountInput,
  AccountBalanceAuthority,
  AccountDefaultFundingSource,
  AccountFundingModel,
  AccountOperatingMode,
  AccountSettlementMode,
  AccountWeeklyAccountingMode,
  PersistedAccountStatus,
  PersistedAccountType,
  PlayerAccount,
  UpdateAccountInput,
} from "./account.types";

const ACCOUNT_TYPES: PersistedAccountType[] = [
  "SUPER_MASTER",
  "MASTER_AGENT",
  "AGENT",
  "PLAYER",
];

const ACCOUNT_STATUSES: PersistedAccountStatus[] = ["ACTIVE", "DISABLED"];
const FUNDING_MODELS: AccountFundingModel[] = ["CASH", "CREDIT", "HYBRID"];
const OPERATING_MODES: AccountOperatingMode[] = [
  "CREDIT_EXPOSURE",
  "COMMISSION",
];
const BALANCE_AUTHORITIES: AccountBalanceAuthority[] = ["INTERNAL", "EXTERNAL"];
const DEFAULT_FUNDING_SOURCES: AccountDefaultFundingSource[] = [
  "CASH",
  "CREDIT",
  "FREE_PLAY",
];
const WEEKLY_ACCOUNTING_MODES: AccountWeeklyAccountingMode[] = [
  "ZERO_BALANCE",
  "CARRY_BALANCE",
];
const SETTLEMENT_MODES: AccountSettlementMode[] = [
  "AUTO_SETTLEMENT",
  "MANUAL_SETTLEMENT",
];

function isAccountType(value: string): value is PersistedAccountType {
  return ACCOUNT_TYPES.includes(value as PersistedAccountType);
}

function isAccountStatus(value: string): value is PersistedAccountStatus {
  return ACCOUNT_STATUSES.includes(value as PersistedAccountStatus);
}

function normalizeOptionalUppercase<TValue extends string>(
  value?: TValue | null
): TValue | null {
  return value ? (value.trim().toUpperCase() as TValue) : null;
}

function getChildAccountsForValidation(
  accounts: PlayerAccount[],
  accountId: string
) {
  return accounts.filter((account) => account.parentId === accountId);
}

function getDescendantAccountIdsForValidation(
  accounts: PlayerAccount[],
  accountId: string
) {
  const descendantIds: string[] = [];
  const collectDescendants = (parentId: string) => {
    getChildAccountsForValidation(accounts, parentId).forEach((childAccount) => {
      descendantIds.push(childAccount.id);
      collectDescendants(childAccount.id);
    });
  };

  collectDescendants(accountId);
  return descendantIds;
}

function wouldCreateHierarchyCycle(
  accounts: PlayerAccount[],
  accountId: string,
  newParentId: string | null
) {
  if (!accountId || !newParentId) {
    return false;
  }

  if (accountId === newParentId) {
    return true;
  }

  return getDescendantAccountIdsForValidation(accounts, accountId).includes(
    newParentId
  );
}

export function validatePlayerAccountForm({
  form,
  accounts,
  editingPlayerAccountId,
}: {
  form: {
    accountType: PlayerAccount["accountType"];
    parentId: string;
    username: string;
    displayName: string;
    status: string;
    cashBalance: string;
    creditLimit: string;
    currentExposure: string;
    maxBet: string;
    maxPayout: string;
  };
  accounts: PlayerAccount[];
  editingPlayerAccountId?: string | null;
}) {
  const username = form.username.trim();
  const displayName = form.displayName.trim();
  const cashBalance = Number(form.cashBalance || 0);
  const creditLimit = Number(form.creditLimit || 0);
  const currentExposure = Number(form.currentExposure || 0);
  const maxBet = form.maxBet === "" ? undefined : Number(form.maxBet);
  const maxPayout = form.maxPayout === "" ? undefined : Number(form.maxPayout);

  if (!form.accountType || !username || !displayName || !form.status) {
    return invalid("Please enter account type, username, display name, and status.");
  }

  if (
    accounts.some(
      (account) =>
        account.id !== editingPlayerAccountId &&
        account.username.trim().toLowerCase() === username.toLowerCase()
    )
  ) {
    return invalid("An account with this username already exists.");
  }

  if (
    Number.isNaN(cashBalance) ||
    Number.isNaN(creditLimit) ||
    Number.isNaN(currentExposure) ||
    Number.isNaN(maxBet ?? 0) ||
    Number.isNaN(maxPayout ?? 0)
  ) {
    return invalid(
      "Cash, credit, exposure, max bet, and max payout values must be numeric."
    );
  }

  if (form.accountType === "super_master" && form.parentId) {
    return invalid("Super master accounts cannot have a parent account.");
  }

  if (editingPlayerAccountId && form.parentId === editingPlayerAccountId) {
    return invalid("An account cannot be assigned as its own parent.");
  }

  if (
    editingPlayerAccountId &&
    wouldCreateHierarchyCycle(accounts, editingPlayerAccountId, form.parentId || null)
  ) {
    return invalid("This parent assignment would create a hierarchy cycle.");
  }

  const existingAccount = accounts.find(
    (account) => account.id === editingPlayerAccountId
  );
  const hasChildAccounts =
    !!existingAccount &&
    accounts.some((account) => account.parentId === existingAccount.id);

  if (
    hasChildAccounts &&
    existingAccount?.accountType === "super_master" &&
    form.accountType !== "super_master"
  ) {
    return invalid("Cannot change a super master type while it has downline accounts.");
  }

  if (
    hasChildAccounts &&
    existingAccount?.accountType === "master_agent" &&
    form.accountType !== "master_agent"
  ) {
    return invalid("Cannot change a master agent type while it has downline accounts.");
  }

  if (
    hasChildAccounts &&
    existingAccount?.accountType === "agent" &&
    form.accountType !== "agent"
  ) {
    return invalid("Cannot change an agent type while it has players.");
  }

  if (form.accountType === "master_agent") {
    const parentAccount = accounts.find((account) => account.id === form.parentId);

    if (
      !parentAccount ||
      (parentAccount.accountType !== "super_master" &&
        parentAccount.accountType !== "master_agent")
    ) {
      return invalid("Master agents must be assigned to a super master or master agent.");
    }
  }

  if (form.accountType === "agent") {
    const parentAccount = accounts.find((account) => account.id === form.parentId);

    if (!parentAccount || parentAccount.accountType !== "master_agent") {
      return invalid("Agents must be assigned to a master agent.");
    }
  }

  if (form.accountType === "player") {
    const parentAccount = accounts.find((account) => account.id === form.parentId);

    if (!parentAccount || parentAccount.accountType !== "agent") {
      return invalid("Players must be assigned to an agent.");
    }
  }

  return valid();
}

export function validateAccountDelete(account: PlayerAccount | undefined, childCount: number) {
  if (!account) {
    return invalid("Account not found.");
  }

  if (childCount > 0) {
    return invalid("Cannot delete an account that has child accounts.");
  }

  return valid();
}

export function normalizeAccountCode(accountCode: string): string {
  return accountCode.trim().toUpperCase();
}

function normalizeAccountType(accountType: PersistedAccountType): PersistedAccountType {
  return accountType.trim().toUpperCase() as PersistedAccountType;
}

function normalizeAccountStatus(
  status: PersistedAccountStatus
): PersistedAccountStatus {
  return status.trim().toUpperCase() as PersistedAccountStatus;
}

export function validateCreateAccountInput(
  input: CreateAccountInput
): ValidationResult {
  const errors: string[] = [];
  const accountType = normalizeAccountType(input.accountType);
  const accountCode = normalizeAccountCode(input.accountCode);
  const displayName = input.displayName.trim();
  const marketId = input.marketId.trim();
  const brandId = input.brandId.trim();
  const status = input.status ? normalizeAccountStatus(input.status) : "ACTIVE";
  const fundingModel = normalizeOptionalUppercase(input.fundingModel);
  const operatingMode = normalizeOptionalUppercase(input.operatingMode);
  const balanceAuthority = normalizeOptionalUppercase(input.balanceAuthority);
  const defaultFundingSource = normalizeOptionalUppercase(input.defaultFundingSource);
  const weeklyAccountingMode = normalizeOptionalUppercase(
    input.weeklyAccountingMode
  );
  const settlementMode = normalizeOptionalUppercase(input.settlementMode);

  if (!accountCode) {
    errors.push("Account code is required.");
  }

  if (/\s/.test(accountCode)) {
    errors.push("Account code cannot contain spaces.");
  }

  if (!displayName) {
    errors.push("Display name is required.");
  }

  if (!isAccountType(accountType)) {
    errors.push("Account type is invalid.");
  }

  if (!isAccountStatus(status)) {
    errors.push("Account status is invalid.");
  }

  if (fundingModel && !FUNDING_MODELS.includes(fundingModel)) {
    errors.push("Funding model is invalid.");
  }

  if (operatingMode && !OPERATING_MODES.includes(operatingMode)) {
    errors.push("Operating mode is invalid.");
  }

  if (balanceAuthority && !BALANCE_AUTHORITIES.includes(balanceAuthority)) {
    errors.push("Balance authority is invalid.");
  }

  if (
    defaultFundingSource &&
    !DEFAULT_FUNDING_SOURCES.includes(defaultFundingSource)
  ) {
    errors.push("Default funding source is invalid.");
  }

  if (
    weeklyAccountingMode &&
    !WEEKLY_ACCOUNTING_MODES.includes(weeklyAccountingMode)
  ) {
    errors.push("Weekly accounting mode is invalid.");
  }

  if (settlementMode && !SETTLEMENT_MODES.includes(settlementMode)) {
    errors.push("Settlement mode is invalid.");
  }

  if (accountType === "PLAYER" && !fundingModel) {
    errors.push("Player accounts require a funding model.");
  }

  if (accountType === "PLAYER" && !defaultFundingSource) {
    errors.push("Player accounts require a default funding source.");
  }

  if (accountType === "PLAYER" && operatingMode) {
    errors.push("Operating mode does not apply to player accounts.");
  }

  if (
    (accountType === "MASTER_AGENT" || accountType === "AGENT") &&
    input.operatingMode !== undefined &&
    !operatingMode
  ) {
    errors.push("Operating mode must be valid when provided.");
  }

  if (!marketId) {
    errors.push("Market id is required.");
  }

  if (!brandId) {
    errors.push("Brand id is required.");
  }

  return errors.length > 0 ? invalid(errors) : valid();
}

export function validateUpdateAccountInput(
  input: UpdateAccountInput
): ValidationResult {
  const errors: string[] = [];

  if (input.accountType !== undefined) {
    const accountType = normalizeAccountType(input.accountType);

    if (!isAccountType(accountType)) {
      errors.push("Account type is invalid.");
    }
  }

  if (input.accountCode !== undefined) {
    const accountCode = normalizeAccountCode(input.accountCode);

    if (!accountCode) {
      errors.push("Account code is required.");
    }

    if (/\s/.test(accountCode)) {
      errors.push("Account code cannot contain spaces.");
    }
  }

  if (input.displayName !== undefined && !input.displayName.trim()) {
    errors.push("Display name is required.");
  }

  if (input.marketId !== undefined && !input.marketId.trim()) {
    errors.push("Market id is required.");
  }

  if (input.brandId !== undefined && !input.brandId.trim()) {
    errors.push("Brand id is required.");
  }

  if (input.status !== undefined && !isAccountStatus(normalizeAccountStatus(input.status))) {
    errors.push("Account status is invalid.");
  }

  const fundingModel = normalizeOptionalUppercase(input.fundingModel);
  const operatingMode = normalizeOptionalUppercase(input.operatingMode);
  const balanceAuthority = normalizeOptionalUppercase(input.balanceAuthority);
  const defaultFundingSource = normalizeOptionalUppercase(input.defaultFundingSource);
  const weeklyAccountingMode = normalizeOptionalUppercase(input.weeklyAccountingMode);
  const settlementMode = normalizeOptionalUppercase(input.settlementMode);

  if (fundingModel && !FUNDING_MODELS.includes(fundingModel)) {
    errors.push("Funding model is invalid.");
  }

  if (operatingMode && !OPERATING_MODES.includes(operatingMode)) {
    errors.push("Operating mode is invalid.");
  }

  if (balanceAuthority && !BALANCE_AUTHORITIES.includes(balanceAuthority)) {
    errors.push("Balance authority is invalid.");
  }

  if (
    defaultFundingSource &&
    !DEFAULT_FUNDING_SOURCES.includes(defaultFundingSource)
  ) {
    errors.push("Default funding source is invalid.");
  }

  if (
    weeklyAccountingMode &&
    !WEEKLY_ACCOUNTING_MODES.includes(weeklyAccountingMode)
  ) {
    errors.push("Weekly accounting mode is invalid.");
  }

  if (settlementMode && !SETTLEMENT_MODES.includes(settlementMode)) {
    errors.push("Settlement mode is invalid.");
  }

  return errors.length > 0 ? invalid(errors) : valid();
}

export function normalizeCreateAccountInput(
  input: CreateAccountInput
): CreateAccountInput {
  return {
    accountType: normalizeAccountType(input.accountType),
    accountCode: normalizeAccountCode(input.accountCode),
    displayName: input.displayName.trim(),
    parentAccountId: input.parentAccountId?.trim() || null,
    marketId: input.marketId.trim(),
    brandId: input.brandId.trim(),
    status: input.status ? normalizeAccountStatus(input.status) : "ACTIVE",
    fundingModel: normalizeOptionalUppercase(input.fundingModel),
    operatingMode: normalizeOptionalUppercase(input.operatingMode),
    balanceAuthority: normalizeOptionalUppercase(input.balanceAuthority),
    defaultFundingSource: normalizeOptionalUppercase(input.defaultFundingSource),
    weeklyAccountingMode: normalizeOptionalUppercase(input.weeklyAccountingMode),
    settlementMode: normalizeOptionalUppercase(input.settlementMode),
  };
}

export function normalizeUpdateAccountInput(
  input: UpdateAccountInput
): UpdateAccountInput {
  return {
    ...(input.accountType !== undefined
      ? { accountType: normalizeAccountType(input.accountType) }
      : {}),
    ...(input.accountCode !== undefined
      ? { accountCode: normalizeAccountCode(input.accountCode) }
      : {}),
    ...(input.displayName !== undefined
      ? { displayName: input.displayName.trim() }
      : {}),
    ...(input.parentAccountId !== undefined
      ? { parentAccountId: input.parentAccountId?.trim() || null }
      : {}),
    ...(input.marketId !== undefined ? { marketId: input.marketId.trim() } : {}),
    ...(input.brandId !== undefined ? { brandId: input.brandId.trim() } : {}),
    ...(input.status !== undefined
      ? { status: normalizeAccountStatus(input.status) }
      : {}),
    ...(input.fundingModel !== undefined
      ? { fundingModel: normalizeOptionalUppercase(input.fundingModel) }
      : {}),
    ...(input.operatingMode !== undefined
      ? { operatingMode: normalizeOptionalUppercase(input.operatingMode) }
      : {}),
    ...(input.balanceAuthority !== undefined
      ? { balanceAuthority: normalizeOptionalUppercase(input.balanceAuthority) }
      : {}),
    ...(input.defaultFundingSource !== undefined
      ? {
          defaultFundingSource: normalizeOptionalUppercase(
            input.defaultFundingSource
          ),
        }
      : {}),
    ...(input.weeklyAccountingMode !== undefined
      ? {
          weeklyAccountingMode: normalizeOptionalUppercase(
            input.weeklyAccountingMode
          ),
        }
      : {}),
    ...(input.settlementMode !== undefined
      ? { settlementMode: normalizeOptionalUppercase(input.settlementMode) }
      : {}),
  };
}
