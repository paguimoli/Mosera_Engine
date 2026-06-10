import { ALL_ADMIN_PERMISSIONS } from "./admin-access.types";
import type { AdminRole } from "./admin-access.types";

export function buildDefaultAdminRoles(adminRoles: AdminRole[]) {
  const defaultRoles: Array<Omit<AdminRole, "id" | "active" | "createdAt">> = [
    {
      name: "Super Admin",
      description: "Full platform access for all admin configuration.",
      permissions: ALL_ADMIN_PERMISSIONS,
    },
    {
      name: "Operations Manager",
      description: "Runs daily games, draws, results, settlement, and audit review.",
      permissions: [
        "games.view",
        "draws.view",
        "draws.manage",
        "results.post",
        "results.correct",
        "paytables.view",
        "wagers.view",
        "tickets.view",
        "settlement.view",
        "settlement.run",
        "reports.view",
        "audit.view",
      ],
    },
    {
      name: "Risk Manager",
      description: "Reviews exposure, risk, reports, and settlement status.",
      permissions: [
        "games.view",
        "draws.view",
        "tickets.view",
        "settlement.view",
        "reports.view",
        "reports.export",
        "risk.view",
        "risk.manage",
        "audit.view",
      ],
    },
    {
      name: "Finance Manager",
      description:
        "Manages wallet adjustments, settlement review, and finance reporting.",
      permissions: [
        "players.view",
        "wallets.view",
        "wallets.adjust",
        "tickets.view",
        "settlement.view",
        "settlement.resettle",
        "reports.view",
        "reports.export",
        "audit.view",
      ],
    },
    {
      name: "Read Only Auditor",
      description: "Read-only visibility for audit and operational review.",
      permissions: [
        "games.view",
        "draws.view",
        "paytables.view",
        "wagers.view",
        "players.view",
        "wallets.view",
        "tickets.view",
        "settlement.view",
        "reports.view",
        "audit.view",
      ],
    },
  ];
  const existingNames = new Set(
    adminRoles.map((role) => role.name.trim().toLowerCase())
  );
  const createdAt = new Date().toISOString();
  const idSeed = Date.now();

  return defaultRoles
    .filter((role) => !existingNames.has(role.name.toLowerCase()))
    .map((role, index) => ({
      id: `ROLE-${idSeed}-${index}`,
      active: true,
      createdAt,
      ...role,
    }));
}
