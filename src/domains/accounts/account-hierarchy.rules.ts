import type { Account, PersistedAccountType } from "./account.types";

export function getAllowedParentAccountTypes(
  accountType: PersistedAccountType
): PersistedAccountType[] {
  if (accountType === "MASTER_AGENT") {
    return ["SUPER_MASTER", "MASTER_AGENT"];
  }

  if (accountType === "AGENT") {
    return ["MASTER_AGENT"];
  }

  if (accountType === "PLAYER") {
    return ["AGENT"];
  }

  return [];
}

export function validateAccountParentRule({
  accountType,
  parentAccount,
}: {
  accountType: PersistedAccountType;
  parentAccount?: Account | null;
}): string[] {
  if (accountType === "SUPER_MASTER") {
    return parentAccount
      ? ["Super Master accounts cannot have a parent account."]
      : [];
  }

  if (!parentAccount) {
    return [`${accountType} accounts require a parent account.`];
  }

  const allowedParentTypes = getAllowedParentAccountTypes(accountType);

  if (!allowedParentTypes.includes(parentAccount.accountType)) {
    return [
      `${accountType} accounts cannot be assigned under ${parentAccount.accountType} accounts.`,
    ];
  }

  return [];
}
