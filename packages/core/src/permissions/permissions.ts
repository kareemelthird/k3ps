/**
 * permissions — pure per-staff permission resolver (ADR-0012 Decision B1)
 *
 * Resolves the effective permissions for a tenant_members row into a typed
 * flat struct that UI/mobile can gate on. Mirrors the SQL has_permission()
 * helper's semantics exactly:
 *
 *   - role='owner' → all flags true unconditionally.
 *   - Active non-owner with absent flag → true (permissive default).
 *   - Active non-owner with explicit false → false.
 *   - Non-member / inactive member: callers should never call this; the DB
 *     rejects the write. The resolver doesn't encode membership.
 *
 * HARD RULES (CLAUDE.md §4):
 *   - Pure: no I/O, no clock reads, no React/RN/Expo/Next/Supabase imports.
 *   - All functions are deterministic: same input → same output.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * The four per-staff permission keys (ADR-0012 §1).
 * Stored as JSONB on tenant_members.permissions in the DB.
 */
export type StaffPermissionKey =
  | 'can_restock'
  | 'can_void'
  | 'can_manage_debts'
  | 'can_discount';

/**
 * The resolved effective permissions for a staff member.
 * All booleans — true means the action is permitted.
 */
export interface ResolvedPermissions {
  can_restock:      boolean;
  can_void:         boolean;
  can_manage_debts: boolean;
  can_discount:     boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** All valid permission key strings (for validation). */
export const ALL_STAFF_PERMISSION_KEYS: readonly StaffPermissionKey[] = [
  'can_restock',
  'can_void',
  'can_manage_debts',
  'can_discount',
];

const ALLOWED_KEY_SET = new Set<string>(ALL_STAFF_PERMISSION_KEYS);

// ─── Core resolver ────────────────────────────────────────────────────────────

/**
 * Resolve the effective permissions for a tenant staff member.
 *
 * @param role            The member's role string (e.g. 'owner', 'manager', 'staff').
 * @param permissionsJson The raw `tenant_members.permissions` JSONB value.
 *                        Nullish is treated as `{}` (all permissive defaults).
 */
export function resolveStaffPermissions(
  role: string,
  permissionsJson: Record<string, unknown> | null | undefined,
): ResolvedPermissions {
  // Owners have all permissions unconditionally — mirrors is_tenant_owner() branch.
  if (role === 'owner') {
    return {
      can_restock:      true,
      can_void:         true,
      can_manage_debts: true,
      can_discount:     true,
    };
  }

  const perms: Record<string, unknown> = permissionsJson ?? {};

  return {
    can_restock:      resolveOne(perms, 'can_restock'),
    can_void:         resolveOne(perms, 'can_void'),
    can_manage_debts: resolveOne(perms, 'can_manage_debts'),
    can_discount:     resolveOne(perms, 'can_discount'),
  };
}

/**
 * Convenience wrapper: check a single permission key on already-resolved permissions.
 *
 * @param resolved A `ResolvedPermissions` struct from {@link resolveStaffPermissions}.
 * @param key      The permission to check.
 */
export function hasPermission(
  resolved: ResolvedPermissions,
  key: StaffPermissionKey,
): boolean {
  return resolved[key];
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Validate that a raw permissions object contains only known keys with boolean values.
 *
 * Returns `null` if valid (including `null` / `undefined` / `{}`).
 * Returns a non-empty error message string if invalid.
 *
 * Used by the invite-staff edge function and the web form before writing to the DB.
 */
export function validatePermissions(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return 'permissions must be a plain object';
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEY_SET.has(key)) {
      return `unknown permission key: "${key}"`;
    }
    // noUncheckedIndexedAccess: obj[key] may be undefined at the type level,
    // but Object.keys guarantees the key is present — val is never undefined here.
    const val: unknown = obj[key];
    if (typeof val !== 'boolean') {
      return `permission "${key}" must be a boolean, got ${typeof val}`;
    }
  }
  return null;
}

// ─── Private helpers ─────────────────────────────────────────────────────────

/**
 * Resolve a single permission flag from the raw permissions map.
 * Absent key → true (permissive default, matching the SQL coalesce(flag, true)).
 * Explicit boolean value → that value.
 * Non-boolean / undefined → true (permissive default; validator should catch this).
 */
function resolveOne(
  perms: Record<string, unknown>,
  key: StaffPermissionKey,
): boolean {
  if (!(key in perms)) return true; // absent ⇒ permissive default
  const val: unknown = perms[key];
  // Strict equality: only explicit `false` denies; anything else is treated as allowed.
  return val !== false;
}
