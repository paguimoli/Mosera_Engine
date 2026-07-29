import type {
  Account,
  CreateAccountInput,
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
  updateAccount as updateAccountRecord,
} from "./account.repository";
import {
  CanonicalHierarchyError,
  resolveCanonicalMarketScope,
  resolveAccountDescendants,
  validateAccountPlacement,
  type CanonicalAccountScope,
} from "@/src/domains/hierarchy/canonical-hierarchy-authority";
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

async function enforceHierarchyRules({
  input,
  scope,
  existingAccount,
}: {
  input: CreateAccountInput | UpdateAccountInput;
  scope: CanonicalAccountScope;
  existingAccount?: Account | null;
}) {
  const accountType = input.accountType ?? existingAccount?.accountType;

  if (!accountType) {
    throw new AccountBusinessRuleError("Account type is required.");
  }

  try {
    await validateAccountPlacement({
      accountId: existingAccount?.id ?? null,
      accountType,
      parentAccountId:
        input.parentAccountId !== undefined
          ? input.parentAccountId
          : existingAccount?.parentAccountId ?? null,
      scope,
      status: input.status ?? existingAccount?.status,
    });
  } catch (error) {
    if (error instanceof CanonicalHierarchyError) {
      throw new AccountBusinessRuleError(error.message);
    }
    throw error;
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
  await enforceHierarchyRules({ input: normalized, scope });

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
  await enforceHierarchyRules({
    input: normalized,
    scope: scope ?? {
      platformId: existingAccount.platformId,
      organizationId: existingAccount.organizationId,
      tenantId: existingAccount.tenantId,
      brandId: existingAccount.brandId,
      marketId: existingAccount.marketId,
    },
    existingAccount,
  });

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

  const descendants = await resolveAccountDescendants(id);
  const activeChildIds = descendants
    .filter((descendant) => descendant.depth === 1)
    .map((descendant) => descendant.accountId);
  const activeChildren = (
    await Promise.all(activeChildIds.map((childId) => findAccountById(childId)))
  ).filter((childAccount) => childAccount?.status === "ACTIVE");

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
  const descendants = await resolveAccountDescendants(parentAccountId);
  return (
    await Promise.all(
      descendants
        .filter((descendant) => descendant.depth === 1)
        .map((descendant) => findAccountById(descendant.accountId))
    )
  ).filter((account): account is Account => Boolean(account));
}
