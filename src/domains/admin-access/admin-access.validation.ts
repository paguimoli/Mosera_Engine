import { invalid, valid } from "@/src/lib/validation/validation.types";
import type { AdminRole, AdminUser } from "./admin-access.types";

export function validateAdminRoleForm({
  form,
  adminRoles,
  editingAdminRoleId,
}: {
  form: { name: string; permissions: string[] };
  adminRoles: AdminRole[];
  editingAdminRoleId?: string | null;
}) {
  const name = form.name.trim();

  if (!name) {
    return invalid("Please enter a role name.");
  }

  if (form.permissions.length === 0) {
    return invalid("Please select at least one permission.");
  }

  if (
    adminRoles.some(
      (role) =>
        role.id !== editingAdminRoleId &&
        role.name.trim().toLowerCase() === name.toLowerCase()
    )
  ) {
    return invalid("An admin role with this name already exists.");
  }

  return valid();
}

export function validateAdminUserForm({
  form,
  adminUsers,
  editingAdminUserId,
}: {
  form: { name: string; email: string; roleIds: string[] };
  adminUsers: AdminUser[];
  editingAdminUserId?: string | null;
}) {
  const name = form.name.trim();
  const email = form.email.trim().toLowerCase();
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!name) {
    return invalid("Please enter an admin user name.");
  }

  if (!email || !emailPattern.test(email)) {
    return invalid("Please enter a valid admin user email.");
  }

  if (form.roleIds.length === 0) {
    return invalid("Please assign at least one admin role.");
  }

  if (
    adminUsers.some(
      (user) =>
        user.id !== editingAdminUserId &&
        user.email.trim().toLowerCase() === email
    )
  ) {
    return invalid("An admin user with this email already exists.");
  }

  return valid();
}
