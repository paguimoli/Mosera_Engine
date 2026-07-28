import { validateAccountParentRule } from "./account-hierarchy.rules";
import type {
  Account,
  CreateAccountInput,
  PlayerAccount,
  UpdateAccountInput,
} from "./account.types";
import {
  createAccount as createAccountRecord,
  type AccountGovernanceContext,
  AccountIdempotencyConflictError,
  AccountRepositoryError,
  disableAccount as disableAccountRecord,
  findAccountByCode,
  findAccountById,
  listAccounts as listAccountRecords,
  listChildren as listChildRecords,
  resolveCanonicalMarketScope,
  updateAccount as updateAccountRecord,
} from "./account.repository";
import {
  normalizeCreateAccountInput,
  normalizeUpdateAccountInput,
  validateCreateAccountInput,
  validateUpdateAccountInput,
} from "./account.validation";

export class DuplicateAccountCodeError extends Error {
  constructor(message = "Duplicate account code.") {
    super(message);
    this.name = "DuplicateAccountCodeError";
  }
}

export class AccountValidationError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(errors.join(" "));
    this.name = "AccountValidationError";
    this.errors = errors;
  }
}

export class AccountBusinessRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountBusinessRuleError";
  }
}

export class AccountRequestConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountRequestConflictError";
  }
}

export function getChildAccounts(accounts: PlayerAccount[], accountId: string) {
  return accounts.filter((account) => account.parentId === accountId);
}

export function getDescendantAccountIds(
  accounts: PlayerAccount[],
  accountId: string
) {
  const descendantIds: string[] = [];
  const collectDescendants = (parentId: string) => {
    getChildAccounts(accounts, parentId).forEach((childAccount) => {
      descendantIds.push(childAccount.id);
      collectDescendants(childAccount.id);
    });
  };

  collectDescendants(accountId);
  return descendantIds;
}

export function wouldCreateHierarchyCycle(
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

  return getDescendantAccountIds(accounts, accountId).includes(newParentId);
}

async function getValidatedParentAccount(
  input: CreateAccountInput | UpdateAccountInput,
  existingAccount?: Account | null
) {
  const parentAccountId =
    input.parentAccountId !== undefined
      ? input.parentAccountId
      : existingAccount?.parentAccountId ?? null;

  if (!parentAccountId) {
    return null;
  }

  const parentAccount = await findAccountById(parentAccountId);

  if (!parentAccount) {
    throw new AccountBusinessRuleError("Parent account not found.");
  }

  if (parentAccount.status !== "ACTIVE") {
    throw new AccountBusinessRuleError("Parent account must be active.");
  }

  return parentAccount;
}

async function enforceHierarchyRules({
  input,
  existingAccount,
}: {
  input: CreateAccountInput | UpdateAccountInput;
  existingAccount?: Account | null;
}) {
  const accountType = input.accountType ?? existingAccount?.accountType;

  if (!accountType) {
    throw new AccountBusinessRuleError("Account type is required.");
  }

  const parentAccount = await getValidatedParentAccount(input, existingAccount);
  const hierarchyErrors = validateAccountParentRule({
    accountType,
    parentAccount,
  });

  if (hierarchyErrors.length > 0) {
    throw new AccountBusinessRuleError(hierarchyErrors[0] ?? "Invalid hierarchy.");
  }
}

function enforceAccountConfigurationRules({
  input,
  existingAccount,
}: {
  input: CreateAccountInput | UpdateAccountInput;
  existingAccount?: Account | null;
}) {
  const accountType = input.accountType ?? existingAccount?.accountType;
  const fundingModel = input.fundingModel ?? existingAccount?.fundingModel ?? null;
  const defaultFundingSource =
    input.defaultFundingSource ?? existingAccount?.defaultFundingSource ?? null;
  const operatingMode = input.operatingMode ?? existingAccount?.operatingMode ?? null;

  if (accountType === "PLAYER" && !fundingModel) {
    throw new AccountBusinessRuleError("Player accounts require a funding model.");
  }

  if (accountType === "PLAYER" && !defaultFundingSource) {
    throw new AccountBusinessRuleError(
      "Player accounts require a default funding source."
    );
  }

  if (accountType === "PLAYER" && operatingMode) {
    throw new AccountBusinessRuleError(
      "Operating mode does not apply to player accounts."
    );
  }
}

export async function resolveAccountScope(marketId: string) {
  const scope = await resolveCanonicalMarketScope(marketId);
  if (!scope) {
    throw new AccountBusinessRuleError(
      "Market must belong to an active canonical Platform hierarchy."
    );
  }
  return scope;
}

function translateRepositoryError(error: unknown): never {
  if (error instanceof AccountIdempotencyConflictError) {
    throw new AccountRequestConflictError(error.message);
  }
  if (error instanceof AccountRepositoryError) {
    throw new AccountBusinessRuleError(error.message);
  }
  throw error;
}

export async function createAccount(
  input: CreateAccountInput,
  context: AccountGovernanceContext = {
    operatorId: "system",
    reason: "account created",
  }
): Promise<Account> {
  const validation = validateCreateAccountInput(input);

  if (!validation.valid) {
    throw new AccountValidationError(validation.errors);
  }

  const normalized = normalizeCreateAccountInput(input);
  const existingAccount = await findAccountByCode(normalized.accountCode);

  if (existingAccount) {
    throw new DuplicateAccountCodeError();
  }

  const scope = await resolveAccountScope(normalized.marketId);
  if (normalized.brandId && normalized.brandId !== scope.brandId) {
    throw new AccountBusinessRuleError(
      "Brand scope must match the canonical Market relationship."
    );
  }
  enforceAccountConfigurationRules({ input: normalized });
  await enforceHierarchyRules({ input: normalized });

  try {
    return await createAccountRecord(normalized, scope, context);
  } catch (error) {
    return translateRepositoryError(error);
  }
}

export async function updateAccount(
  id: string,
  input: UpdateAccountInput,
  context: AccountGovernanceContext = {
    operatorId: "system",
    reason: "account updated",
  }
): Promise<Account> {
  const validation = validateUpdateAccountInput(input);

  if (!validation.valid) {
    throw new AccountValidationError(validation.errors);
  }

  const existingAccount = await findAccountById(id);

  if (!existingAccount) {
    throw new AccountBusinessRuleError("Account not found.");
  }

  const normalized = normalizeUpdateAccountInput(input);

  if (normalized.accountCode) {
    const duplicateAccount = await findAccountByCode(normalized.accountCode);

    if (duplicateAccount && duplicateAccount.id !== id) {
      throw new DuplicateAccountCodeError();
    }
  }

  const scope = normalized.marketId
    ? await resolveAccountScope(normalized.marketId)
    : undefined;
  if (
    normalized.brandId &&
    normalized.brandId !== (scope?.brandId ?? existingAccount.brandId)
  ) {
    throw new AccountBusinessRuleError(
      "Brand scope must match the canonical Market relationship."
    );
  }

  enforceAccountConfigurationRules({ input: normalized, existingAccount });
  await enforceHierarchyRules({ input: normalized, existingAccount });

  try {
    return await updateAccountRecord(id, normalized, scope, context);
  } catch (error) {
    return translateRepositoryError(error);
  }
}

export async function disableAccount(
  id: string,
  context: AccountGovernanceContext = {
    operatorId: "system",
    reason: "account disabled",
  }
): Promise<Account> {
  const account = await findAccountById(id);

  if (!account) {
    throw new AccountBusinessRuleError("Account not found.");
  }

  const activeChildren = (await listChildRecords(id)).filter(
    (childAccount) => childAccount.status === "ACTIVE"
  );

  if (activeChildren.length > 0) {
    throw new AccountBusinessRuleError(
      "Cannot disable an account with active children."
    );
  }

  try {
    return await disableAccountRecord(id, context);
  } catch (error) {
    return translateRepositoryError(error);
  }
}

export async function listAccounts(): Promise<Account[]> {
  return listAccountRecords();
}

export async function listChildren(parentAccountId: string): Promise<Account[]> {
  return listChildRecords(parentAccountId);
}
