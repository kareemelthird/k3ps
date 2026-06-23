/**
 * Tests for types module — AC 18–19.
 * Verifies that the multi-tenant type shapes are correct and the package is pure.
 */

// ─── AC 18: Role includes super_admin and tenant/branch types exist ───────────

import type {
  Role,
  Tenant,
  Branch,
  TenantMember,
  Profile,
  Device,
  Session,
  Shift,
  Order,
  StockMovement,
  SessionSegment,
  OrderItem,
  DebtPayment,
  PaymentMethod,
} from '../types/index';

describe('Role type', () => {
  test('AC 18a: Role includes super_admin', () => {
    const r: Role = 'super_admin';
    expect(r).toBe('super_admin');
  });

  test('Role includes owner', () => {
    const r: Role = 'owner';
    expect(r).toBe('owner');
  });

  test('Role includes manager', () => {
    const r: Role = 'manager';
    expect(r).toBe('manager');
  });

  test('Role includes staff', () => {
    const r: Role = 'staff';
    expect(r).toBe('staff');
  });
});

describe('PaymentMethod type', () => {
  test('includes debt (ADR-0004)', () => {
    const pm: PaymentMethod = 'debt';
    expect(pm).toBe('debt');
  });

  test('includes cash', () => {
    const pm: PaymentMethod = 'cash';
    expect(pm).toBe('cash');
  });
});

describe('Tenant entity shape', () => {
  test('AC 18b: Tenant has id, name, status, created_at, updated_at', () => {
    const t: Tenant = {
      id: 'uuid-1',
      name: 'Café Alpha',
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    expect(t.id).toBe('uuid-1');
    expect(t.status).toBe('active');
  });
});

describe('Branch entity shape', () => {
  test('AC 18c: Branch has tenant_id', () => {
    const b: Branch = {
      id: 'uuid-2',
      tenant_id: 'uuid-1',
      name: 'Main Branch',
      is_active: true,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    expect(b.tenant_id).toBe('uuid-1');
  });
});

describe('TenantMember entity shape', () => {
  test('AC 18d: TenantMember has tenant_id, profile_id, role', () => {
    const m: TenantMember = {
      tenant_id: 'uuid-1',
      profile_id: 'user-1',
      role: 'owner',
      is_active: true,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    expect(m.tenant_id).toBe('uuid-1');
    expect(m.profile_id).toBe('user-1');
  });
});

describe('Branch-scoped entities carry branch_id', () => {
  test('Device has tenant_id and branch_id', () => {
    const d: Device = {
      id: 'device-1',
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      name: 'PS5 #1',
      device_type: 'PS5',
      status: 'free',
      sort_order: 1,
      is_active: true,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    expect(d.tenant_id).toBe('tenant-1');
    expect(d.branch_id).toBe('branch-1');
  });

  test('Shift has tenant_id and branch_id', () => {
    const s: Shift = {
      id: 'shift-1',
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      manager_id: 'manager-1',
      opened_at: '2026-01-01T08:00:00.000Z',
      closed_at: null,
      opening_cash: 50000,
      expected_cash: 50000,
      actual_cash: null,
      difference: null,
      notes: null,
      status: 'open',
      created_at: '2026-01-01T08:00:00.000Z',
      updated_at: '2026-01-01T08:00:00.000Z',
    };
    expect(s.tenant_id).toBe('tenant-1');
    expect(s.branch_id).toBe('branch-1');
  });

  test('Session has tenant_id and branch_id', () => {
    const s: Session = {
      id: 'session-1',
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      device_id: 'device-1',
      manager_id: 'manager-1',
      shift_id: null,
      billing_mode: 'open',
      status: 'active',
      started_at: '2026-01-01T10:00:00.000Z',
      ended_at: null,
      prepaid_minutes: null,
      prepaid_total: null,
      match_count: null,
      time_total: 0,
      orders_total: 0,
      grand_total: 0,
      discount: 0,
      payment_method: null,
      created_at: '2026-01-01T10:00:00.000Z',
      updated_at: '2026-01-01T10:00:00.000Z',
    };
    expect(s.tenant_id).toBe('tenant-1');
    expect(s.branch_id).toBe('branch-1');
  });

  test('Order has tenant_id and branch_id', () => {
    const o: Order = {
      id: 'order-1',
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      session_id: null,
      shift_id: null,
      manager_id: 'manager-1',
      total: 500,
      status: 'open',
      payment_method: null,
      created_at: '2026-01-01T10:00:00.000Z',
      updated_at: '2026-01-01T10:00:00.000Z',
    };
    expect(o.branch_id).toBe('branch-1');
  });

  test('StockMovement has tenant_id and branch_id', () => {
    const sm: StockMovement = {
      id: 'sm-1',
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      product_id: 'product-1',
      delta: -1,
      reason: 'sale',
      order_id: null,
      manager_id: null,
      note: null,
      created_at: '2026-01-01T10:00:00.000Z',
      updated_at: '2026-01-01T10:00:00.000Z',
    };
    expect(sm.branch_id).toBe('branch-1');
  });
});

describe('Child entities carry tenant_id (branch via parent)', () => {
  test('SessionSegment has tenant_id but no branch_id field', () => {
    const seg: SessionSegment = {
      id: 'seg-1',
      tenant_id: 'tenant-1',
      session_id: 'session-1',
      play_mode: 'single',
      rate_rule_id: null,
      price_per_hour_snapshot: 6000,
      started_at: '2026-01-01T10:00:00.000Z',
      ended_at: null,
      created_at: '2026-01-01T10:00:00.000Z',
      updated_at: '2026-01-01T10:00:00.000Z',
    };
    expect(seg.tenant_id).toBe('tenant-1');
    // branch_id not present on this type (reached via parent session)
    expect('branch_id' in seg).toBe(false);
  });

  test('OrderItem has tenant_id', () => {
    const oi: OrderItem = {
      id: 'oi-1',
      tenant_id: 'tenant-1',
      order_id: 'order-1',
      product_id: 'product-1',
      qty: 2,
      unit_price: 500,
      created_at: '2026-01-01T10:00:00.000Z',
      updated_at: '2026-01-01T10:00:00.000Z',
    };
    expect(oi.tenant_id).toBe('tenant-1');
  });

  test('DebtPayment has tenant_id', () => {
    const dp: DebtPayment = {
      id: 'dp-1',
      tenant_id: 'tenant-1',
      debt_id: 'debt-1',
      amount: 1000,
      manager_id: 'manager-1',
      shift_id: null,
      created_at: '2026-01-01T10:00:00.000Z',
      updated_at: '2026-01-01T10:00:00.000Z',
    };
    expect(dp.tenant_id).toBe('tenant-1');
  });
});

// ─── AC 19: purity guard (no forbidden imports) ───────────────────────────────
// This is enforced statically in CI by the pricing-engine-guard skill.
// The test here provides a runtime documentation of the expectation.

describe('purity guard', () => {
  test('AC 19: @ps/core has no React/RN/Expo/Next/Supabase imports (static rule)', () => {
    // This test documents the constraint — the actual check is done by
    // pricing-engine-guard / tsc. If this package imported those modules,
    // "import ... from 'react'" would appear in the source files.
    //
    // We can verify at runtime that none of those globals are set unexpectedly:
    expect(typeof (globalThis as Record<string, unknown>)['React']).toBe('undefined');
    expect(typeof (globalThis as Record<string, unknown>)['__REACT_NATIVE__']).toBe('undefined');
  });
});
