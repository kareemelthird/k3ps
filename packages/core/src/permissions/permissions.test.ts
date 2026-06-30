/**
 * Tests for the pure permissions resolver (ADR-0012 Decision B1).
 *
 * Covers:
 *   - Owner always-true override
 *   - Permissive default (absent key = allowed)
 *   - Explicit false = denied
 *   - resolveOne edge cases (null/undefined permissionsJson)
 *   - hasPermission convenience wrapper
 *   - validatePermissions: valid and invalid inputs
 */

import type { StaffPermissionKey, ResolvedPermissions } from './permissions';
import { resolveStaffPermissions, hasPermission, validatePermissions } from './permissions';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ALL_TRUE: ResolvedPermissions = {
  can_restock:      true,
  can_void:         true,
  can_manage_debts: true,
  can_discount:     true,
};

const ALL_FALSE: ResolvedPermissions = {
  can_restock:      false,
  can_void:         false,
  can_manage_debts: false,
  can_discount:     false,
};

// ─── resolveStaffPermissions — owner ─────────────────────────────────────────

describe('resolveStaffPermissions — owner role', () => {
  it('owner with empty permissions gets all true', () => {
    expect(resolveStaffPermissions('owner', {})).toEqual(ALL_TRUE);
  });

  it('owner with all flags false still gets all true (owner override)', () => {
    const perms = {
      can_void:         false,
      can_restock:      false,
      can_manage_debts: false,
      can_discount:     false,
    };
    expect(resolveStaffPermissions('owner', perms)).toEqual(ALL_TRUE);
  });

  it('owner with null permissions gets all true', () => {
    expect(resolveStaffPermissions('owner', null)).toEqual(ALL_TRUE);
  });

  it('owner with undefined permissions gets all true', () => {
    expect(resolveStaffPermissions('owner', undefined)).toEqual(ALL_TRUE);
  });
});

// ─── resolveStaffPermissions — permissive default (absent flag = allowed) ─────

describe('resolveStaffPermissions — permissive default', () => {
  it('manager with empty permissions gets all true (permissive default)', () => {
    expect(resolveStaffPermissions('manager', {})).toEqual(ALL_TRUE);
  });

  it('staff with empty permissions gets all true (permissive default)', () => {
    expect(resolveStaffPermissions('staff', {})).toEqual(ALL_TRUE);
  });

  it('null permissionsJson treated as {} — all true', () => {
    expect(resolveStaffPermissions('staff', null)).toEqual(ALL_TRUE);
  });

  it('undefined permissionsJson treated as {} — all true', () => {
    expect(resolveStaffPermissions('manager', undefined)).toEqual(ALL_TRUE);
  });

  it('absent can_void key → can_void = true (permissive default)', () => {
    const result = resolveStaffPermissions('staff', { can_restock: false });
    expect(result.can_void).toBe(true);
    expect(result.can_restock).toBe(false);
  });
});

// ─── resolveStaffPermissions — explicit flags ─────────────────────────────────

describe('resolveStaffPermissions — explicit flag values', () => {
  it('explicit false flags are respected for non-owner', () => {
    const perms = {
      can_void:         false,
      can_restock:      false,
      can_manage_debts: false,
      can_discount:     false,
    };
    expect(resolveStaffPermissions('staff', perms)).toEqual(ALL_FALSE);
  });

  it('explicit true flags are respected', () => {
    const perms = { can_void: true, can_restock: true };
    const result = resolveStaffPermissions('staff', perms);
    expect(result.can_void).toBe(true);
    expect(result.can_restock).toBe(true);
    // Absent flags default to true
    expect(result.can_manage_debts).toBe(true);
    expect(result.can_discount).toBe(true);
  });

  it('can_void=false only denies can_void; others remain permissive', () => {
    const result = resolveStaffPermissions('manager', { can_void: false });
    expect(result.can_void).toBe(false);
    expect(result.can_restock).toBe(true);
    expect(result.can_manage_debts).toBe(true);
    expect(result.can_discount).toBe(true);
  });

  it('can_manage_debts=false only denies can_manage_debts', () => {
    const result = resolveStaffPermissions('staff', { can_manage_debts: false });
    expect(result.can_manage_debts).toBe(false);
    expect(result.can_void).toBe(true);
    expect(result.can_restock).toBe(true);
    expect(result.can_discount).toBe(true);
  });

  it('mixed: some true, some false', () => {
    const result = resolveStaffPermissions('staff', {
      can_void:    false,
      can_restock: true,
    });
    expect(result.can_void).toBe(false);
    expect(result.can_restock).toBe(true);
    expect(result.can_manage_debts).toBe(true); // absent = permissive
    expect(result.can_discount).toBe(true);      // absent = permissive
  });
});

// ─── resolveStaffPermissions — unknown roles ──────────────────────────────────

describe('resolveStaffPermissions — unknown role (not owner)', () => {
  it('unknown role is treated as non-owner — flags apply', () => {
    const result = resolveStaffPermissions('cashier', { can_void: false });
    expect(result.can_void).toBe(false);
  });

  it('empty string role is not owner — permissive default applies', () => {
    expect(resolveStaffPermissions('', {})).toEqual(ALL_TRUE);
  });
});

// ─── hasPermission ────────────────────────────────────────────────────────────

describe('hasPermission — convenience wrapper', () => {
  it('returns true for a granted permission', () => {
    const resolved = resolveStaffPermissions('staff', { can_void: true });
    expect(hasPermission(resolved, 'can_void')).toBe(true);
  });

  it('returns false for a denied permission', () => {
    const resolved = resolveStaffPermissions('staff', { can_void: false });
    expect(hasPermission(resolved, 'can_void')).toBe(false);
  });

  it('returns true for a permissive-default permission', () => {
    const resolved = resolveStaffPermissions('staff', {});
    expect(hasPermission(resolved, 'can_restock')).toBe(true);
  });

  it('owner resolved permissions — all true via hasPermission', () => {
    const resolved = resolveStaffPermissions('owner', {});
    const keys: StaffPermissionKey[] = [
      'can_restock', 'can_void', 'can_manage_debts', 'can_discount',
    ];
    for (const key of keys) {
      expect(hasPermission(resolved, key)).toBe(true);
    }
  });
});

// ─── validatePermissions ──────────────────────────────────────────────────────

describe('validatePermissions — valid inputs', () => {
  it('null is valid (no permissions object)', () => {
    expect(validatePermissions(null)).toBeNull();
  });

  it('undefined is valid', () => {
    expect(validatePermissions(undefined)).toBeNull();
  });

  it('empty object is valid', () => {
    expect(validatePermissions({})).toBeNull();
  });

  it('object with all known keys as booleans is valid', () => {
    const perms = {
      can_restock:      true,
      can_void:         false,
      can_manage_debts: true,
      can_discount:     false,
    };
    expect(validatePermissions(perms)).toBeNull();
  });

  it('object with subset of known keys is valid', () => {
    expect(validatePermissions({ can_void: true })).toBeNull();
    expect(validatePermissions({ can_restock: false })).toBeNull();
  });
});

describe('validatePermissions — invalid inputs', () => {
  it('non-object (string) is invalid', () => {
    const err = validatePermissions('true');
    expect(err).not.toBeNull();
    expect(err).toContain('plain object');
  });

  it('array is invalid', () => {
    const err = validatePermissions([true, false]);
    expect(err).not.toBeNull();
  });

  it('number is invalid', () => {
    expect(validatePermissions(42)).not.toBeNull();
  });

  it('unknown key is invalid', () => {
    const err = validatePermissions({ can_delete: true });
    expect(err).not.toBeNull();
    expect(err).toContain('unknown permission key');
    expect(err).toContain('can_delete');
  });

  it('known key with non-boolean string value is invalid', () => {
    const err = validatePermissions({ can_void: 'yes' });
    expect(err).not.toBeNull();
    expect(err).toContain('boolean');
  });

  it('known key with numeric value is invalid', () => {
    const err = validatePermissions({ can_restock: 1 });
    expect(err).not.toBeNull();
    expect(err).toContain('boolean');
  });

  it('known key with null value is invalid', () => {
    const err = validatePermissions({ can_void: null });
    expect(err).not.toBeNull();
    expect(err).toContain('boolean');
  });
});
