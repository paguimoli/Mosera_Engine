import type { AdminRole, AdminUser } from "./admin-access.types";

export function findAdminRoleById(adminRoles: AdminRole[], roleId: string) {
  return adminRoles.find((role) => role.id === roleId);
}

export function findAdminUserById(adminUsers: AdminUser[], userId: string) {
  return adminUsers.find((user) => user.id === userId);
}

export function saveAdminRole(adminRoles: AdminRole[], role: AdminRole) {
  return [...adminRoles, role];
}

export function updateAdminRole(adminRoles: AdminRole[], role: AdminRole) {
  return adminRoles.map((createdRole) =>
    createdRole.id === role.id ? role : createdRole
  );
}

export function deleteAdminRole(adminRoles: AdminRole[], roleId: string) {
  return adminRoles.filter((role) => role.id !== roleId);
}

export function saveAdminUser(adminUsers: AdminUser[], user: AdminUser) {
  return [...adminUsers, user];
}

export function updateAdminUser(adminUsers: AdminUser[], user: AdminUser) {
  return adminUsers.map((createdUser) =>
    createdUser.id === user.id ? user : createdUser
  );
}

export function deleteAdminUser(adminUsers: AdminUser[], userId: string) {
  return adminUsers.filter((user) => user.id !== userId);
}

export function removeRoleFromAdminUsers(adminUsers: AdminUser[], roleId: string) {
  return adminUsers.map((user) => ({
    ...user,
    roleIds: user.roleIds.filter((userRoleId) => userRoleId !== roleId),
  }));
}
