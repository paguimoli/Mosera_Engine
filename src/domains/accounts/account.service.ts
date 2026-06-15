import { findBrandById } from "../brands/brand.repository";
import { findMarketById } from "../markets/market.repository";
import { validateAccountParentRule } from "./account-hierarchy.rules";
import type {
  Account,
  CreateAccountInput,
  PlayerAccount,
  UpdateAccountInput,
} from "./account.types";
import {
  createAccount as createAccountRecord,
  disableAccount as disableAccountRecord,
  findAccountByCode,
  findAccountById,
  listAccounts as listAccountRecords,
  listChildren as listChildRecords,
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

async function assertMarketIsActive(marketId: string) {
  const market = await findMarketById(marketId);

  if (!market) {
    throw new AccountBusinessRuleError("Market not found.");
  }

  if (market.status !== "ACTIVE") {
    throw new AccountBusinessRuleError("Market must be active.");
  }
}

async function assertBrandIsActive(brandId: string) {
  const brand = await findBrandById(brandId);

  if (!brand) {
    throw new AccountBusinessRuleError("Brand not found.");
  }

  if (brand.status !== "ACTIVE") {
    throw new AccountBusinessRuleError("Brand must be active.");
  }
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

export async function createAccount(input: CreateAccountInput): Promise<Account> {
  const validation = validateCreateAccountInput(input);

  if (!validation.valid) {
    throw new AccountValidationError(validation.errors);
  }

  const normalized = normalizeCreateAccountInput(input);
  const existingAccount = await findAccountByCode(normalized.accountCode);

  if (existingAccount) {
    throw new DuplicateAccountCodeError();
  }

  await assertMarketIsActive(normalized.marketId);
  await assertBrandIsActive(normalized.brandId);
  enforceAccountConfigurationRules({ input: normalized });
  await enforceHierarchyRules({ input: normalized });

  return createAccountRecord(normalized);
}

export async function updateAccount(
  id: string,
  input: UpdateAccountInput
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

  if (normalized.marketId) {
    await assertMarketIsActive(normalized.marketId);
  }

  if (normalized.brandId) {
    await assertBrandIsActive(normalized.brandId);
  }

  enforceAccountConfigurationRules({ input: normalized, existingAccount });
  await enforceHierarchyRules({ input: normalized, existingAccount });

  return updateAccountRecord(id, normalized);
}

export async function disableAccount(id: string): Promise<Account> {
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

  return disableAccountRecord(id);
}

export async function listAccounts(): Promise<Account[]> {
  return listAccountRecords();
}

export async function listChildren(parentAccountId: string): Promise<Account[]> {
  return listChildRecords(parentAccountId);
}
