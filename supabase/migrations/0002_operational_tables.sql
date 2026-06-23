-- =============================================================================
-- Migration 0002 — Operational tables
-- Creates all domain tables with tenant_id (+ branch_id where branch-scoped).
-- tenant_id is the LEADING column in every PK/composite index (ADR-0002).
-- Branch-scoped tables: devices, shifts, sessions, orders, stock_movements.
-- Tenant-scoped: rate_rules, products, settings, customers, debts, debt_payments.
-- Children: session_segments (via sessions), order_items (via orders),
--           debt_payments (via debts).
-- Special: audit_log (tenant_id not null, branch_id nullable).
-- RLS enabled on every table; policies defined in 0004.
-- SECURITY REVIEWER: required sign-off on all RLS.
-- =============================================================================

-- =============================================================================
-- SECTION 1: Enums (all new enums for multi-tenant operational domain)
-- =============================================================================

create type public.device_status    as enum ('free', 'busy', 'maintenance');
create type public.play_mode_rule   as enum ('single', 'multi', 'any');
create type public.play_mode        as enum ('single', 'multi');
create type public.billing_mode     as enum ('open', 'prepaid', 'fixed_match');
create type public.day_type_rule    as enum ('weekday', 'weekend', 'any');
create type public.session_status   as enum ('active', 'closed', 'void');
-- 'debt' is added now (ADR-0004) and kept inert until Phase 5.
create type public.payment_method   as enum ('cash', 'wallet', 'other', 'debt');
create type public.order_status     as enum ('open', 'paid', 'void');
create type public.stock_reason     as enum ('initial', 'restock', 'adjust', 'sale', 'void');
create type public.shift_status     as enum ('open', 'closed');

-- =============================================================================
-- SECTION 2: devices (branch-scoped)
-- =============================================================================

create table public.devices (
  id          uuid not null default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  branch_id   uuid not null,
  name        text not null,
  device_type text not null,
  status      public.device_status not null default 'free',
  sort_order  int not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (id),
  -- Composite FK to branches: ensures branch belongs to the same tenant (ADR-0004)
  foreign key (tenant_id, branch_id) references public.branches (tenant_id, id) on delete cascade
);

create trigger set_devices_updated_at
  before update on public.devices
  for each row execute function public.set_updated_at();

-- tenant_id-leading indexes (ADR-0002)
create index devices_tenant_idx        on public.devices (tenant_id);
create index devices_tenant_branch_idx on public.devices (tenant_id, branch_id);
create index devices_tenant_status_idx on public.devices (tenant_id, status);

alter table public.devices enable row level security;

-- =============================================================================
-- SECTION 3: rate_rules (tenant-scoped)
-- =============================================================================

create table public.rate_rules (
  id                  uuid not null default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants (id) on delete cascade,
  device_type         text not null default 'any',
  play_mode           public.play_mode_rule not null default 'any',
  billing_mode        public.billing_mode not null,
  day_type            public.day_type_rule not null default 'any',
  time_start          text,   -- 'HH:mm' or null (all-day)
  time_end            text,   -- 'HH:mm' or null
  price_per_hour      int,    -- piastres
  block_minutes       int,
  block_price         int,    -- piastres
  fixed_match_price   int,    -- piastres
  rounding_minutes    int not null default 5,
  min_charge_minutes  int not null default 0,
  priority            int not null default 0,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (id)
);

create trigger set_rate_rules_updated_at
  before update on public.rate_rules
  for each row execute function public.set_updated_at();

create index rate_rules_tenant_idx on public.rate_rules (tenant_id);
-- Full rule-resolution index: tenant_id leading (ADR-0002 perf note)
create index rate_rules_resolution_idx on public.rate_rules
  (tenant_id, device_type, play_mode, billing_mode, day_type, priority);

alter table public.rate_rules enable row level security;

-- =============================================================================
-- SECTION 4: products (tenant-scoped)
-- =============================================================================

create table public.products (
  id          uuid not null default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  name        text not null,
  category    text not null default '',
  price       int not null default 0,  -- piastres
  cost        int,                      -- piastres; null = uncosted
  stock       int,                      -- null = untracked
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (id)
);

create trigger set_products_updated_at
  before update on public.products
  for each row execute function public.set_updated_at();

create index products_tenant_idx on public.products (tenant_id);

alter table public.products enable row level security;

-- =============================================================================
-- SECTION 5: settings (tenant-scoped, keyed (tenant_id, key) — ADR-0004)
-- =============================================================================

create table public.settings (
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  key        text not null,
  value      jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- PK is (tenant_id, key) per ADR-0004; tenant_id leads
  primary key (tenant_id, key)
);

create trigger set_settings_updated_at
  before update on public.settings
  for each row execute function public.set_updated_at();

-- PK is already (tenant_id, key); add a secondary index for lookups by tenant
create index settings_tenant_idx on public.settings (tenant_id);

alter table public.settings enable row level security;

-- =============================================================================
-- SECTION 6: shifts (branch-scoped)
-- =============================================================================

create table public.shifts (
  id            uuid not null default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  branch_id     uuid not null,
  manager_id    uuid not null references public.profiles (id),
  opened_at     timestamptz not null default now(),
  closed_at     timestamptz,
  opening_cash  int not null default 0,  -- piastres
  expected_cash int not null default 0,  -- piastres
  actual_cash   int,                      -- piastres; null until closed
  difference    int,                      -- piastres; null until closed
  notes         text,
  status        public.shift_status not null default 'open',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (id),
  foreign key (tenant_id, branch_id) references public.branches (tenant_id, id) on delete cascade
);

create trigger set_shifts_updated_at
  before update on public.shifts
  for each row execute function public.set_updated_at();

create index shifts_tenant_idx           on public.shifts (tenant_id);
create index shifts_tenant_branch_idx    on public.shifts (tenant_id, branch_id);
create index shifts_tenant_manager_idx   on public.shifts (tenant_id, manager_id);
create index shifts_tenant_status_idx    on public.shifts (tenant_id, status);

alter table public.shifts enable row level security;

-- =============================================================================
-- SECTION 7: sessions (branch-scoped)
-- Active-session uniqueness: partial unique (tenant_id, device_id) where active
-- =============================================================================

create table public.sessions (
  id               uuid not null default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants (id) on delete cascade,
  branch_id        uuid not null,
  device_id        uuid not null references public.devices (id),
  manager_id       uuid not null references public.profiles (id),
  shift_id         uuid references public.shifts (id),
  billing_mode     public.billing_mode not null,
  status           public.session_status not null default 'active',
  started_at       timestamptz not null default now(),
  ended_at         timestamptz,
  prepaid_minutes  int,
  prepaid_total    int,  -- piastres; LOCKED at purchase (never reconstruct from rules)
  match_count      int,
  time_total       int not null default 0,    -- piastres
  orders_total     int not null default 0,    -- piastres
  grand_total      int not null default 0,    -- piastres
  discount         int not null default 0,    -- piastres
  payment_method   public.payment_method,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (id),
  foreign key (tenant_id, branch_id) references public.branches (tenant_id, id) on delete cascade
);

create trigger set_sessions_updated_at
  before update on public.sessions
  for each row execute function public.set_updated_at();

-- AC 23: Partial unique index on (tenant_id, device_id) where status='active'
-- Replaces the trial's single-café (device_id) unique index.
create unique index sessions_one_active_per_device
  on public.sessions (tenant_id, device_id)
  where status = 'active';

create index sessions_tenant_idx         on public.sessions (tenant_id);
create index sessions_tenant_branch_idx  on public.sessions (tenant_id, branch_id);
create index sessions_tenant_device_idx  on public.sessions (tenant_id, device_id);
create index sessions_tenant_manager_idx on public.sessions (tenant_id, manager_id);
create index sessions_tenant_shift_idx   on public.sessions (tenant_id, shift_id);
create index sessions_started_idx        on public.sessions (tenant_id, started_at);

alter table public.sessions enable row level security;

-- =============================================================================
-- SECTION 8: session_segments (tenant_id for RLS; branch via parent session)
-- =============================================================================

create table public.session_segments (
  id                       uuid not null default gen_random_uuid(),
  tenant_id                uuid not null references public.tenants (id) on delete cascade,
  session_id               uuid not null references public.sessions (id) on delete cascade,
  play_mode                public.play_mode not null,
  rate_rule_id             uuid references public.rate_rules (id),
  price_per_hour_snapshot  int not null default 0,  -- piastres; locked at segment open
  started_at               timestamptz not null default now(),
  ended_at                 timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  primary key (id)
);

create trigger set_session_segments_updated_at
  before update on public.session_segments
  for each row execute function public.set_updated_at();

create index session_segments_tenant_idx   on public.session_segments (tenant_id);
create index session_segments_session_idx  on public.session_segments (tenant_id, session_id);

alter table public.session_segments enable row level security;

-- =============================================================================
-- SECTION 9: orders (branch-scoped)
-- =============================================================================

create table public.orders (
  id             uuid not null default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants (id) on delete cascade,
  branch_id      uuid not null,
  session_id     uuid references public.sessions (id) on delete set null,
  shift_id       uuid references public.shifts (id),
  manager_id     uuid not null references public.profiles (id),
  total          int not null default 0,  -- piastres
  status         public.order_status not null default 'open',
  payment_method public.payment_method,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (id),
  foreign key (tenant_id, branch_id) references public.branches (tenant_id, id) on delete cascade
);

create trigger set_orders_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();

create index orders_tenant_idx         on public.orders (tenant_id);
create index orders_tenant_branch_idx  on public.orders (tenant_id, branch_id);
create index orders_tenant_session_idx on public.orders (tenant_id, session_id);
create index orders_tenant_shift_idx   on public.orders (tenant_id, shift_id);
create index orders_tenant_manager_idx on public.orders (tenant_id, manager_id);

alter table public.orders enable row level security;

-- =============================================================================
-- SECTION 10: order_items (tenant_id for RLS; branch via parent order)
-- =============================================================================

create table public.order_items (
  id          uuid not null default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  order_id    uuid not null references public.orders (id) on delete cascade,
  product_id  uuid not null references public.products (id),
  qty         int not null default 1,
  unit_price  int not null default 0,  -- piastres; snapshot at order time
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (id)
);

create trigger set_order_items_updated_at
  before update on public.order_items
  for each row execute function public.set_updated_at();

create index order_items_tenant_idx  on public.order_items (tenant_id);
create index order_items_order_idx   on public.order_items (tenant_id, order_id);

alter table public.order_items enable row level security;

-- =============================================================================
-- SECTION 11: stock_movements (branch-scoped)
-- reason='adjust' is owner-only (AC 31a); enforced in 0004 RLS.
-- =============================================================================

create table public.stock_movements (
  id          uuid not null default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  branch_id   uuid not null,
  product_id  uuid not null references public.products (id),
  delta       int not null,  -- positive = in, negative = out
  reason      public.stock_reason not null,
  order_id    uuid references public.orders (id) on delete set null,
  manager_id  uuid references public.profiles (id),
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (id),
  foreign key (tenant_id, branch_id) references public.branches (tenant_id, id) on delete cascade
);

create trigger set_stock_movements_updated_at
  before update on public.stock_movements
  for each row execute function public.set_updated_at();

create index stock_movements_tenant_idx         on public.stock_movements (tenant_id);
create index stock_movements_tenant_branch_idx  on public.stock_movements (tenant_id, branch_id);
create index stock_movements_tenant_product_idx on public.stock_movements (tenant_id, product_id);

alter table public.stock_movements enable row level security;

-- =============================================================================
-- SECTION 12: customers (tenant-scoped)
-- =============================================================================

create table public.customers (
  id          uuid not null default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  name        text not null,
  phone       text,
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (id)
);

create trigger set_customers_updated_at
  before update on public.customers
  for each row execute function public.set_updated_at();

create index customers_tenant_idx on public.customers (tenant_id);

alter table public.customers enable row level security;

-- =============================================================================
-- SECTION 13: debts (tenant-scoped)
-- =============================================================================

create table public.debts (
  id            uuid not null default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  customer_id   uuid references public.customers (id) on delete set null,
  customer_name text not null,
  amount        int not null,  -- piastres
  session_id    uuid references public.sessions (id) on delete set null,
  manager_id    uuid not null references public.profiles (id),
  shift_id      uuid references public.shifts (id),
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (id)
);

create trigger set_debts_updated_at
  before update on public.debts
  for each row execute function public.set_updated_at();

create index debts_tenant_idx          on public.debts (tenant_id);
create index debts_tenant_customer_idx on public.debts (tenant_id, customer_id);

alter table public.debts enable row level security;

-- =============================================================================
-- SECTION 14: debt_payments (tenant_id for RLS; parent debt FK)
-- =============================================================================

create table public.debt_payments (
  id          uuid not null default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  debt_id     uuid not null references public.debts (id) on delete cascade,
  amount      int not null,  -- piastres
  manager_id  uuid not null references public.profiles (id),
  shift_id    uuid references public.shifts (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (id)
);

create trigger set_debt_payments_updated_at
  before update on public.debt_payments
  for each row execute function public.set_updated_at();

create index debt_payments_tenant_idx on public.debt_payments (tenant_id);
create index debt_payments_debt_idx   on public.debt_payments (tenant_id, debt_id);

alter table public.debt_payments enable row level security;

-- =============================================================================
-- SECTION 15: audit_log (tenant_id not null; branch_id nullable)
-- Records actor/action/timestamp/amount for money-affecting and cross-tenant actions.
-- CLAUDE.md §2.7.
-- =============================================================================

create table public.audit_log (
  id         uuid not null default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  branch_id  uuid,  -- nullable: tenant/platform actions may not be branch-specific
  actor_id   uuid references public.profiles (id) on delete set null,
  action     text not null,
  entity     text,
  entity_id  uuid,
  amount     int,   -- piastres; null for non-money actions
  meta       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  -- No updated_at: audit rows are append-only
  primary key (id)
);

create index audit_log_tenant_idx        on public.audit_log (tenant_id);
create index audit_log_tenant_actor_idx  on public.audit_log (tenant_id, actor_id);
create index audit_log_tenant_action_idx on public.audit_log (tenant_id, action);
create index audit_log_created_idx       on public.audit_log (tenant_id, created_at);

alter table public.audit_log enable row level security;

-- =============================================================================
-- SECTION 16: product_stock_levels view (security_invoker = true — AC 29)
-- =============================================================================

-- Drop if exists (idempotent)
drop view if exists public.product_stock_levels;

create view public.product_stock_levels
  with (security_invoker = true)
  as
  select
    p.id          as product_id,
    p.tenant_id,
    p.name,
    p.category,
    p.price,
    p.cost,
    p.stock       as initial_stock,
    coalesce(sum(sm.delta), 0)::int as on_hand
  from public.products p
  left join public.stock_movements sm
    on sm.product_id = p.id and sm.tenant_id = p.tenant_id
  group by p.id, p.tenant_id, p.name, p.category, p.price, p.cost, p.stock;

-- =============================================================================
-- END OF MIGRATION 0002
-- =============================================================================
