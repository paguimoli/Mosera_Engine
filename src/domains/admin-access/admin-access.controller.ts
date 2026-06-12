import {
  controllerFailure,
  controllerSuccess,
} from "@/src/lib/controller/controller.types";
import { createAuditEvent } from "../audit/audit.service";
import { AUDIT_ACTIONS } from "../audit/audit.types";
import {
  deleteAdminRole,
  deleteAdminUser,
  findAdminRoleById,
  findAdminUserById,
  removeRoleFromAdminUsers,
  saveAdminRole,
  saveAdminUser,
  updateAdminRole,
  updateAdminUser,
} from "./admin-access.repository";
import { buildDefaultAdminRoles } from "./admin-access.service";
import type { AdminRole, AdminUser } from "./admin-access.types";
import {
  validateAdminRoleForm,
  validateAdminUserForm,
} from "./admin-access.validation";

export function saveAdminRoleController({
  form,
  adminRoles,
  editingAdminRoleId,
}: {
  form: {
    name: string;
    description: string;
    permissions: AdminRole["permissions"];
    active: boolean;
  };
  adminRoles: AdminRole[];
  editingAdminRoleId?: string | null;
}) {
  const validation = validateAdminRoleForm({
    form,
    adminRoles,
    editingAdminRoleId,
  });

  if (!validation.valid) {
    return controllerFailure(validation.errors);
  }

  const existingRole = editingAdminRoleId
    ? findAdminRoleById(adminRoles, editingAdminRoleId)
    : undefined;
  const role: AdminRole = {
    id: existingRole?.id || `ROLE-${Date.now()}`,
    name: form.name.trim(),
    description: form.description.trim(),
    permissions: form.permissions,
    active: form.active,
    createdAt: existingRole?.createdAt || new Date().toISOString(),
  };
  const grantedPermissions = form.permissions.filter(
    (permission) => !existingRole?.permissions.includes(permission)
  );
  const revokedPermissions =
    existingRole?.permissions.filter(
      (permission) => !form.permissions.includes(permission)
    ) || [];

  return controllerSuccess({
    role,
    auditEvents: [
      createAuditEvent({
        entityType: "admin_role",
        entityId: role.id,
        action: editingAdminRoleId
          ? AUDIT_ACTIONS.ROLE_UPDATED
          : AUDIT_ACTIONS.ROLE_CREATED,
        actorType: "admin",
        actorId: "admin",
        oldValue: existingRole,
        newValue: role,
      }),
      ...grantedPermissions.map((permission) =>
        createAuditEvent({
          entityType: "admin_role",
          entityId: role.id,
          action: AUDIT_ACTIONS.PERMISSION_GRANTED,
          actorType: "admin",
          actorId: "admin",
          newValue: { permission },
        })
      ),
      ...revokedPermissions.map((permission) =>
        createAuditEvent({
          entityType: "admin_role",
          entityId: role.id,
          action: AUDIT_ACTIONS.PERMISSION_REVOKED,
          actorType: "admin",
          actorId: "admin",
          oldValue: { permission },
        })
      ),
    ],
    adminRoles: editingAdminRoleId
      ? updateAdminRole(adminRoles, role)
      : saveAdminRole(adminRoles, role),
  });
}

export function deleteAdminRoleController({
  roleId,
  adminRoles,
  adminUsers,
}: {
  roleId: string;
  adminRoles: AdminRole[];
  adminUsers: AdminUser[];
}) {
  const role = findAdminRoleById(adminRoles, roleId);

  return controllerSuccess({
    auditEvents: role
      ? [
          createAuditEvent({
            entityType: "admin_role",
            entityId: role.id,
            action: AUDIT_ACTIONS.ROLE_DELETED,
            actorType: "admin",
            actorId: "admin",
            oldValue: role,
          }),
        ]
      : [],
    adminRoles: deleteAdminRole(adminRoles, roleId),
    adminUsers: removeRoleFromAdminUsers(adminUsers, roleId),
  });
}

export function addDefaultRolesController(adminRoles: AdminRole[]) {
  const newRoles = buildDefaultAdminRoles(adminRoles);

  if (newRoles.length === 0) {
    return controllerFailure("Default admin roles already exist.");
  }

  return controllerSuccess({
    newRoles,
    adminRoles: newRoles.reduce(
      (nextRoles, role) => saveAdminRole(nextRoles, role),
      adminRoles
    ),
  });
}

export function saveAdminUserController({
  form,
  adminUsers,
  editingAdminUserId,
}: {
  form: {
    name: string;
    email: string;
    roleIds: string[];
    status: AdminUser["status"];
  };
  adminUsers: AdminUser[];
  editingAdminUserId?: string | null;
}) {
  const validation = validateAdminUserForm({
    form,
    adminUsers,
    editingAdminUserId,
  });

  if (!validation.valid) {
    return controllerFailure(validation.errors);
  }

  const existingUser = editingAdminUserId
    ? findAdminUserById(adminUsers, editingAdminUserId)
    : undefined;
  const user: AdminUser = {
    id: existingUser?.id || `ADMIN-${Date.now()}`,
    name: form.name.trim(),
    email: form.email.trim().toLowerCase(),
    roleIds: form.roleIds,
    status: form.status,
    createdAt: existingUser?.createdAt || new Date().toISOString(),
  };

  return controllerSuccess({
    user,
    auditEvents: [
      createAuditEvent({
        entityType: "admin_user",
        entityId: user.id,
        action: editingAdminUserId
          ? AUDIT_ACTIONS.ADMIN_UPDATED
          : AUDIT_ACTIONS.ADMIN_CREATED,
        actorType: "admin",
        actorId: "admin",
        oldValue: existingUser,
        newValue: user,
      }),
    ],
    adminUsers: editingAdminUserId
      ? updateAdminUser(adminUsers, user)
      : saveAdminUser(adminUsers, user),
  });
}

export function deleteAdminUserController({
  userId,
  adminUsers,
}: {
  userId: string;
  adminUsers: AdminUser[];
}) {
  const user = findAdminUserById(adminUsers, userId);

  return controllerSuccess({
    auditEvents: user
      ? [
          createAuditEvent({
            entityType: "admin_user",
            entityId: user.id,
            action: AUDIT_ACTIONS.ADMIN_UPDATED,
            actorType: "admin",
            actorId: "admin",
            oldValue: user,
            metadata: { deleteRequested: true },
          }),
        ]
      : [],
    adminUsers: deleteAdminUser(adminUsers, userId),
  });
}
