/**
 * types — shared domain types for PS-Managment (multi-tenant SaaS).
 *
 * This module is the single source of truth for enums and entity shapes.
 * All operational entities carry tenant_id; branch-scoped entities also
 * carry branch_id (devices, shifts, sessions, orders, stock_movements).
 *
 * HARD RULES:
 * - Zero imports from React, React Native, Expo, Next.js, or Supabase.
 * - Money fields are type Piastres (integer); never floats.
 * - Timestamps are UTC ISO-8601 strings.
 */

// ─── Platform roles ───────────────────────────────────────────────────────────

/**
 * User roles, ordered from highest to lowest platform privilege.
 * super_admin is a platform role (profiles.is_platform_admin = true).
 * owner/manager/staff are tenant-scoped (tenant_members.role).
 */
export type Role = 'super_admin' | 'owner' | 'manager' | 'staff';

// ─── Domain enums ─────────────────────────────────────────────────────────────

export type DeviceStatus = 'free' | 'busy' | 'maintenance';

/** play_mode for sessions (actual mode; not for rules). */
export type PlayMode = 'single' | 'multi';

/** play_mode_rule for rate rules (includes 'any' sentinel). */
export type PlayModeRule = 'single' | 'multi' | 'any';

export type BillingMode = 'open' | 'prepaid' | 'fixed_match';

/** day_type_rule for rate rules. */
export type DayTypeRule = 'weekday' | 'weekend' | 'any';

export type SessionStatus = 'active' | 'closed' | 'void';

/**
 * Payment method.
 * 'debt' is present in the enum (ADR-0004) but is inert until Phase 5.
 */
export type PaymentMethod = 'cash' | 'wallet' | 'other' | 'debt';

export type OrderStatus = 'open' | 'paid' | 'void';

export type StockReason = 'initial' | 'restock' | 'adjust' | 'sale' | 'void';

export type ShiftStatus = 'open' | 'closed';

/** Tenant-level status. */
export type TenantStatus = 'active' | 'suspended';

/** Permission keys used for per-user capability grants. */
export type PermissionKey = 'restock' | 'void' | 'manageDebts' | 'discount';

// ─── Tenancy entities ─────────────────────────────────────────────────────────

/** A café business — the top-level tenancy unit. */
export interface Tenant {
  id: string;
  name: string;
  status: TenantStatus;
  created_at: string;
  updated_at: string;
}

/** A physical location belonging to a tenant. */
export interface Branch {
  id: string;
  tenant_id: string;
  name: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** Membership of a user in a tenant with a role. Many-to-many. */
export interface TenantMember {
  tenant_id: string;
  profile_id: string;
  role: Exclude<Role, 'super_admin'>; // super_admin is a platform flag, not a tenant membership
  is_active: boolean;
  /**
   * Per-staff permission flags stored as JSONB on tenant_members (ADR-0012 Slice 2).
   * Absent key ⇒ allowed (permissive default). Explicit false ⇒ denied.
   * Use resolveStaffPermissions() from @ps/core/permissions to resolve into typed booleans.
   */
  permissions: Record<string, boolean>;
  created_at: string;
  updated_at: string;
}

/** A user's profile. Cross-tenant. is_platform_admin backs the super_admin role. */
export interface Profile {
  id: string; // = auth.users.id
  full_name: string;
  phone: string | null;
  is_platform_admin: boolean;
  is_active: boolean;
  permissions: Partial<Record<PermissionKey, boolean>>;
  created_at: string;
  updated_at: string;
}

// ─── Operational entities (all carry tenant_id) ───────────────────────────────

/**
 * A gaming device (PS4/PS5/VIP/etc.).
 * Branch-scoped: carries both tenant_id and branch_id.
 */
export interface Device {
  id: string;
  tenant_id: string;
  branch_id: string;
  name: string;
  device_type: string;
  status: DeviceStatus;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * A pricing rule. Tenant-scoped (not branch-scoped — shared across branches).
 */
export interface RateRule {
  id: string;
  tenant_id: string;
  device_type: string;
  play_mode: PlayModeRule;
  billing_mode: BillingMode;
  day_type: DayTypeRule;
  time_start: string | null; // 'HH:mm'
  time_end: string | null;   // 'HH:mm'
  price_per_hour: number | null;
  block_minutes: number | null;
  block_price: number | null;
  fixed_match_price: number | null;
  rounding_minutes: number;
  min_charge_minutes: number;
  priority: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * A product (drinks, snacks, accessories, etc.).
 * Tenant-scoped — shared across branches.
 */
export interface Product {
  id: string;
  tenant_id: string;
  name: string;
  category: string;
  price: number; // piastres
  cost: number | null; // piastres; null = uncosted
  stock: number | null; // null = untracked
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * A per-tenant configuration key-value pair.
 * PK is (tenant_id, key).
 */
export interface Setting {
  tenant_id: string;
  key: string;
  value: unknown;
  created_at: string;
  updated_at: string;
}

/**
 * A manager's work shift.
 * Branch-scoped.
 */
export interface Shift {
  id: string;
  tenant_id: string;
  branch_id: string;
  manager_id: string;
  opened_at: string;
  closed_at: string | null;
  opening_cash: number; // piastres
  expected_cash: number; // piastres
  actual_cash: number | null; // piastres
  difference: number | null; // piastres
  notes: string | null;
  status: ShiftStatus;
  created_at: string;
  updated_at: string;
}

/**
 * A gaming session on a device.
 * Branch-scoped. Exactly one active session per (tenant_id, device_id).
 */
export interface Session {
  id: string;
  tenant_id: string;
  branch_id: string;
  device_id: string;
  manager_id: string;
  shift_id: string | null;
  billing_mode: BillingMode;
  status: SessionStatus;
  started_at: string;
  ended_at: string | null;
  prepaid_minutes: number | null;
  prepaid_total: number | null; // piastres; locked at purchase — never reconstructed
  match_count: number | null;
  time_total: number; // piastres
  orders_total: number; // piastres
  grand_total: number; // piastres
  discount: number; // piastres
  payment_method: PaymentMethod | null;
  created_at: string;
  updated_at: string;
}

/**
 * A time segment within a session (mode/rate snapshot).
 * Carries tenant_id for RLS. Branch reached via parent session.
 */
export interface SessionSegment {
  id: string;
  tenant_id: string;
  session_id: string;
  play_mode: PlayMode;
  rate_rule_id: string | null;
  price_per_hour_snapshot: number; // piastres
  started_at: string;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * An order (products purchased during a session or walk-in).
 * Branch-scoped.
 */
export interface Order {
  id: string;
  tenant_id: string;
  branch_id: string;
  session_id: string | null; // null = walk-in
  shift_id: string | null;
  manager_id: string;
  total: number; // piastres
  status: OrderStatus;
  payment_method: PaymentMethod | null;
  created_at: string;
  updated_at: string;
}

/**
 * A line item within an order.
 * Carries tenant_id for RLS. Branch reached via parent order.
 */
export interface OrderItem {
  id: string;
  tenant_id: string;
  order_id: string;
  product_id: string;
  qty: number;
  unit_price: number; // piastres (snapshot at time of order)
  created_at: string;
  updated_at: string;
}

/**
 * A stock movement (inventory event).
 * Branch-scoped.
 */
export interface StockMovement {
  id: string;
  tenant_id: string;
  branch_id: string;
  product_id: string;
  delta: number; // positive = in, negative = out
  reason: StockReason;
  order_id: string | null;
  manager_id: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A customer record (business-wide relationship, tenant-scoped).
 */
export interface Customer {
  id: string;
  tenant_id: string;
  name: string;
  phone: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A debt owed by a customer or linked to a session.
 * Tenant-scoped (not branch-scoped — debts are a business-level relationship).
 */
export interface Debt {
  id: string;
  tenant_id: string;
  customer_id: string | null;
  customer_name: string;
  amount: number; // piastres
  session_id: string | null;
  manager_id: string;
  shift_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A payment against a debt.
 * Carries tenant_id for RLS. Debt reached via parent.
 */
export interface DebtPayment {
  id: string;
  tenant_id: string;
  debt_id: string;
  amount: number; // piastres
  manager_id: string;
  shift_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * An audit log entry. Records money-affecting and cross-tenant actions.
 * branch_id is nullable (tenant/platform actions may not be branch-specific).
 */
export interface AuditLog {
  id: string;
  tenant_id: string;
  branch_id: string | null;
  actor_id: string | null;
  action: string;
  entity: string | null;
  entity_id: string | null;
  amount: number | null; // piastres
  meta: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}
