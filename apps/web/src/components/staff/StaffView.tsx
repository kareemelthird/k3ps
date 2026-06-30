'use client';

/**
 * StaffView — owner staff management (Slice 2, ADR-0012).
 *
 * Lists tenant_members for the active tenant (name from profiles, role, is_active,
 * and 4 permission flags resolved via @ps/core resolveStaffPermissions).
 *
 * Invite:  Dialog form → POST to the invite-staff edge function (caller JWT).
 *          Returns temp_password for new users only (shown once, copy-to-clipboard).
 * Edit:    Direct RLS-protected update on tenant_members (tenant_members_owner_write).
 *          Permission toggles write the permissions jsonb column.
 * Owner rows are read-only (cannot demote or modify).
 *
 * HARD RULES:
 *  - All strings from i18n — no hardcoded user-facing text.
 *  - RTL: logical spacing only (start/end, ms/me/ps/pe).
 *  - Tenant isolation: tenant_id from JWT claim, never client-supplied trust.
 *  - validatePermissions() before invite; resolveStaffPermissions() for display.
 *  - temp_password shown once in copyable Dialog with "shown once" warning.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { resolveStaffPermissions, validatePermissions } from '@ps/core';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { getBrowserClient } from '@/lib/supabase/client';
import { useAuth } from '@/lib/auth/AuthContext';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Flat member shape after merging tenant_members + profiles rows. */
interface MemberRow {
  tenant_id: string;
  profile_id: string;
  role: 'owner' | 'manager' | 'staff';
  is_active: boolean;
  permissions: Record<string, unknown>;
  full_name: string;
}

type RoleFilter = '' | 'owner' | 'manager' | 'staff';
type StatusFilter = 'all' | 'active' | 'inactive';

type Modal =
  | { type: 'invite' }
  | { type: 'edit'; member: MemberRow }
  | { type: 'tempPassword'; password: string; email: string }
  | null;

// ─── Permission checkboxes (shared between invite + edit forms) ──────────────

const PERM_KEYS = ['can_restock', 'can_void', 'can_manage_debts', 'can_discount'] as const;
type PermKey = typeof PERM_KEYS[number];

interface PermFormState {
  can_restock: boolean;
  can_void: boolean;
  can_manage_debts: boolean;
  can_discount: boolean;
}

function PermCheckboxes({
  perms,
  onChange,
  t,
}: {
  perms: PermFormState;
  onChange: (key: PermKey, value: boolean) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <fieldset className="space-y-xs">
      <legend className="text-label text-text-muted mb-xs">{t('staff.field.permissions')}</legend>
      {PERM_KEYS.map((key) => (
        <label key={key} className="flex items-center gap-sm cursor-pointer">
          <input
            type="checkbox"
            checked={perms[key]}
            onChange={(e) => onChange(key, e.target.checked)}
            className="w-4 h-4 rounded-xs border-border text-primary focus:ring-primary"
          />
          <span className="text-label text-text">{t(`staff.perm.${key}`)}</span>
        </label>
      ))}
      <p className="text-caption text-text-faint">{t('staff.permHint')}</p>
    </fieldset>
  );
}

// ─── Invite form ──────────────────────────────────────────────────────────────

interface InviteFormProps {
  onClose: () => void;
  onTempPassword: (password: string, email: string) => void;
  onExistingUser: () => void;
  onRefresh: () => void;
}

function InviteForm({ onClose, onTempPassword, onExistingUser, onRefresh }: InviteFormProps) {
  const t = useTranslations();
  const { claim } = useAuth();

  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState<'manager' | 'staff'>('staff');
  const [perms, setPerms] = useState<PermFormState>({
    can_restock: true,
    can_void: true,
    can_manage_debts: true,
    can_discount: true,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handlePermChange(key: PermKey, value: boolean) {
    setPerms((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setError(t('staff.validation.emailRequired'));
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setError(t('staff.validation.emailInvalid'));
      return;
    }

    const permsErr = validatePermissions(perms);
    if (permsErr) {
      setError(t('staff.validation.permissionsInvalid'));
      return;
    }

    setLoading(true);
    try {
      const supabase = getBrowserClient();
      const { data, error: fnErr } = await supabase.functions.invoke('invite-staff', {
        body: {
          tenant_id: claim?.tenant_id,
          email: trimmedEmail,
          role,
          ...(fullName.trim() ? { full_name: fullName.trim() } : {}),
          permissions: perms,
        },
      });

      if (fnErr) {
        throw new Error((fnErr as { message?: string }).message ?? String(fnErr));
      }

      const result = (data ?? {}) as { profile_id?: string; temp_password?: string };
      onRefresh();

      if (result.temp_password) {
        onTempPassword(result.temp_password, trimmedEmail);
      } else {
        onExistingUser();
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} noValidate className="space-y-md">
      {/* Email */}
      <div className="space-y-xs">
        <label htmlFor="invite-email" className="text-label text-text">
          {t('staff.field.email')}
          <span aria-hidden="true" className="text-danger ms-1">*</span>
        </label>
        <input
          id="invite-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
          placeholder="example@mail.com"
          className="w-full h-[52px] px-sm rounded-sm text-label text-text bg-surface-3 border border-border
            transition-colors duration-fast focus:outline-none focus:ring-2 focus:ring-primary focus:border-border-strong"
          dir="ltr"
        />
        <p className="text-caption text-text-faint">{t('staff.field.emailHelper')}</p>
      </div>

      {/* Full name (optional) */}
      <div className="space-y-xs">
        <label htmlFor="invite-fullname" className="text-label text-text">
          {t('staff.field.fullName')}
        </label>
        <input
          id="invite-fullname"
          type="text"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          autoComplete="name"
          className="w-full h-[52px] px-sm rounded-sm text-label text-text bg-surface-3 border border-border
            transition-colors duration-fast focus:outline-none focus:ring-2 focus:ring-primary focus:border-border-strong"
        />
      </div>

      {/* Role */}
      <div className="space-y-xs">
        <label htmlFor="invite-role" className="text-label text-text">
          {t('staff.field.role')}
          <span aria-hidden="true" className="text-danger ms-1">*</span>
        </label>
        <select
          id="invite-role"
          value={role}
          onChange={(e) => setRole(e.target.value as 'manager' | 'staff')}
          className="w-full h-[52px] px-sm rounded-sm text-label text-text bg-surface-3 border border-border
            transition-colors duration-fast focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <option value="manager">{t('staff.role.manager')}</option>
          <option value="staff">{t('staff.role.staff')}</option>
        </select>
      </div>

      {/* Permissions */}
      <PermCheckboxes perms={perms} onChange={handlePermChange} t={t} />

      {/* Error */}
      {error && (
        <p role="alert" className="text-label text-danger">
          {error}
        </p>
      )}

      {/* Actions */}
      <div className="flex gap-md justify-end pt-xs">
        <Button type="button" variant="secondary" onClick={onClose} disabled={loading}>
          {t('staff.action.cancel')}
        </Button>
        <Button type="submit" variant="primary" loading={loading}>
          {t('staff.action.invite')}
        </Button>
      </div>
    </form>
  );
}

// ─── Edit member form ─────────────────────────────────────────────────────────

interface EditMemberFormProps {
  member: MemberRow;
  onClose: () => void;
  onSaved: (updated: MemberRow) => void;
}

function EditMemberForm({ member, onClose, onSaved }: EditMemberFormProps) {
  const t = useTranslations();
  const { claim } = useAuth();

  // Resolve initial perm state from stored permissions
  const resolved = resolveStaffPermissions(member.role, member.permissions);

  const [role, setRole] = useState<'manager' | 'staff'>(
    member.role === 'owner' ? 'manager' : (member.role as 'manager' | 'staff'),
  );
  const [isActive, setIsActive] = useState(member.is_active);
  const [perms, setPerms] = useState<PermFormState>({
    can_restock: resolved.can_restock,
    can_void: resolved.can_void,
    can_manage_debts: resolved.can_manage_debts,
    can_discount: resolved.can_discount,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handlePermChange(key: PermKey, value: boolean) {
    setPerms((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const permsErr = validatePermissions(perms);
    if (permsErr) {
      setError(t('staff.validation.permissionsInvalid'));
      return;
    }

    setLoading(true);
    try {
      const supabase = getBrowserClient();
      const now = new Date().toISOString();
      const { error: err } = await supabase
        .from('tenant_members')
        .update({
          role,
          is_active: isActive,
          permissions: perms,
          updated_at: now,
        })
        .eq('tenant_id', claim?.tenant_id ?? '')
        .eq('profile_id', member.profile_id);

      if (err) throw err;

      onSaved({ ...member, role, is_active: isActive, permissions: { ...perms } as Record<string, unknown> });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} noValidate className="space-y-md">
      {/* Role */}
      <div className="space-y-xs">
        <label htmlFor="edit-role" className="text-label text-text">
          {t('staff.field.role')}
        </label>
        <select
          id="edit-role"
          value={role}
          onChange={(e) => setRole(e.target.value as 'manager' | 'staff')}
          className="w-full h-[52px] px-sm rounded-sm text-label text-text bg-surface-3 border border-border
            transition-colors duration-fast focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <option value="manager">{t('staff.role.manager')}</option>
          <option value="staff">{t('staff.role.staff')}</option>
        </select>
      </div>

      {/* Is-active toggle */}
      <label className="flex items-center gap-sm cursor-pointer">
        <input
          type="checkbox"
          checked={isActive}
          onChange={(e) => setIsActive(e.target.checked)}
          className="w-4 h-4 rounded-xs border-border text-primary focus:ring-primary"
        />
        <span className="text-label text-text">{t('staff.field.isActive')}</span>
      </label>

      {/* Permissions */}
      <PermCheckboxes perms={perms} onChange={handlePermChange} t={t} />

      {/* Error */}
      {error && (
        <p role="alert" className="text-label text-danger">
          {error}
        </p>
      )}

      {/* Actions */}
      <div className="flex gap-md justify-end pt-xs">
        <Button type="button" variant="secondary" onClick={onClose} disabled={loading}>
          {t('staff.action.cancel')}
        </Button>
        <Button type="submit" variant="primary" loading={loading}>
          {t('staff.action.save')}
        </Button>
      </div>
    </form>
  );
}

// ─── Temp password display ────────────────────────────────────────────────────

function TempPasswordDisplay({
  password,
  email,
  onClose,
}: {
  password: string;
  email: string;
  onClose: () => void;
}) {
  const t = useTranslations();
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard API not available
    }
  }

  return (
    <div className="space-y-lg">
      {/* Warning icon */}
      <div className="flex items-start gap-sm p-md bg-warning/10 rounded-sm border border-warning/30">
        <svg
          aria-hidden="true"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="text-warning flex-shrink-0 mt-0.5"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
          />
        </svg>
        <div className="space-y-xs">
          <p className="text-label font-medium text-text">{t('staff.tempPassword.title')}</p>
          <p className="text-caption text-text-muted">{t('staff.tempPassword.body')}</p>
          <p className="text-caption text-text-faint" dir="ltr">{email}</p>
        </div>
      </div>

      {/* Password field */}
      <div className="space-y-xs">
        <label className="text-label text-text-muted">{t('staff.tempPassword.label')}</label>
        <div className="flex gap-sm items-stretch">
          <input
            readOnly
            type="text"
            value={password}
            dir="ltr"
            className="flex-1 h-[52px] px-sm rounded-sm text-label text-text bg-surface-3 border border-border font-mono select-all"
            aria-label={t('staff.tempPassword.label')}
          />
          <Button
            type="button"
            variant="secondary"
            onClick={() => void handleCopy()}
            aria-label={t('staff.tempPassword.copy')}
            className="h-[52px] px-md flex-shrink-0"
          >
            {copied ? (
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
              </svg>
            )}
            {copied ? t('staff.tempPassword.copied') : t('staff.tempPassword.copy')}
          </Button>
        </div>
      </div>

      <div className="flex justify-end">
        <Button variant="primary" onClick={onClose}>
          {t('staff.tempPassword.close')}
        </Button>
      </div>
    </div>
  );
}

// ─── Member card ──────────────────────────────────────────────────────────────

function PermBadge({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 text-micro font-medium px-xs py-0.5 rounded-xs
        ${on ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'}`}
    >
      <svg
        aria-hidden="true"
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
      >
        {on ? (
          <polyline points="20 6 9 17 4 12" />
        ) : (
          <>
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </>
        )}
      </svg>
      {label}
    </span>
  );
}

interface MemberCardProps {
  member: MemberRow;
  pending: boolean;
  onEdit: () => void;
  t: ReturnType<typeof useTranslations>;
}

function MemberCard({ member, pending, onEdit, t }: MemberCardProps) {
  const resolved = resolveStaffPermissions(member.role, member.permissions);
  const isOwner = member.role === 'owner';
  const isInactive = !member.is_active;

  return (
    <article
      aria-label={`${member.full_name || member.profile_id} — ${t(`staff.role.${member.role}`)}`}
      className={`rounded-md bg-surface border p-md flex flex-col sm:flex-row sm:items-start gap-sm transition-opacity
        ${isInactive ? 'opacity-50 border-border' : 'border-border hover:border-border-strong'}`}
    >
      {/* Status dot */}
      <span
        className={`w-2 h-2 rounded-full flex-shrink-0 mt-1.5 ${isInactive ? 'bg-text-faint' : 'bg-status-free'}`}
        aria-hidden="true"
      />

      {/* Member details */}
      <div className="flex-1 min-w-0 space-y-sm">
        {/* Name + role row */}
        <div className="flex flex-wrap items-center gap-xs">
          <span className="text-body font-medium text-text">
            {member.full_name || member.profile_id.slice(0, 8)}
          </span>

          {/* Role badge */}
          <span
            className={`text-micro font-medium px-xs py-0.5 rounded-xs
              ${isOwner
                ? 'bg-primary/10 text-primary'
                : member.role === 'manager'
                ? 'bg-surface-3 text-text-muted'
                : 'bg-surface-2 text-text-faint'
              }`}
          >
            {t(`staff.role.${member.role}`)}
          </span>

          {isInactive && (
            <span className="text-micro font-medium text-text-faint">
              {t('staff.filter.inactive')}
            </span>
          )}

          {isOwner && (
            <span className="text-caption text-text-faint">{t('staff.ownerReadOnly')}</span>
          )}
        </div>

        {/* Permission badges — resolved semantics */}
        {!isOwner && (
          <div className="flex flex-wrap gap-xs">
            {PERM_KEYS.map((key) => (
              <PermBadge key={key} on={resolved[key]} label={t(`staff.perm.${key}`)} />
            ))}
          </div>
        )}

        {/* Owner always-on note */}
        {isOwner && (
          <div className="flex flex-wrap gap-xs">
            {PERM_KEYS.map((key) => (
              <PermBadge key={key} on label={t(`staff.perm.${key}`)} />
            ))}
          </div>
        )}
      </div>

      {/* Edit button — only for non-owners */}
      {!isOwner && (
        <div className="flex items-center flex-shrink-0">
          <Button
            variant="ghost"
            size="md"
            onClick={onEdit}
            aria-label={`${t('staff.edit')} ${member.full_name || member.profile_id}`}
            className="h-9 px-sm text-text-muted"
            disabled={pending}
          >
            <svg
              aria-hidden="true"
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            {t('staff.edit')}
          </Button>
        </div>
      )}
    </article>
  );
}

// ─── Main view ────────────────────────────────────────────────────────────────

export function StaffView() {
  const t = useTranslations();
  const { claim } = useAuth();

  const [members, setMembers] = useState<MemberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [existingUserBanner, setExistingUserBanner] = useState(false);

  // Filters
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const fetchMembers = useCallback(async () => {
    if (!claim?.tenant_id) return;
    setLoading(true);
    setError(null);
    try {
      const supabase = getBrowserClient();

      // 1. Fetch tenant_members for this tenant
      const { data: memberData, error: memberErr } = await supabase
        .from('tenant_members')
        .select('tenant_id, profile_id, role, is_active, permissions')
        .eq('tenant_id', claim.tenant_id)
        .order('role', { ascending: true })
        .order('is_active', { ascending: false });

      if (memberErr) throw memberErr;

      const memberships = (memberData ?? []) as Array<{
        tenant_id: string;
        profile_id: string;
        role: 'owner' | 'manager' | 'staff';
        is_active: boolean;
        permissions: Record<string, unknown>;
      }>;

      // 2. Fetch profiles for those members (profiles_co_member_select allows this)
      let profileMap = new Map<string, string>();
      if (memberships.length > 0) {
        const profileIds = memberships.map((m) => m.profile_id);
        const { data: profileData } = await supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', profileIds);

        for (const p of (profileData ?? []) as Array<{ id: string; full_name: string }>) {
          profileMap.set(p.id, p.full_name ?? '');
        }
      }

      setMembers(
        memberships.map((m) => ({
          ...m,
          full_name: profileMap.get(m.profile_id) ?? '',
        })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [claim?.tenant_id]);

  useEffect(() => {
    void fetchMembers();
  }, [fetchMembers]);

  // Filtered list
  const filtered = useMemo(() => {
    return members.filter((m) => {
      if (roleFilter && m.role !== roleFilter) return false;
      if (statusFilter === 'active' && !m.is_active) return false;
      if (statusFilter === 'inactive' && m.is_active) return false;
      return true;
    });
  }, [members, roleFilter, statusFilter]);

  function handleSaved(updated: MemberRow) {
    setMembers((prev) =>
      prev.map((m) =>
        m.profile_id === updated.profile_id ? { ...m, ...updated } : m,
      ),
    );
    setPendingId(null);
    setModal(null);
  }

  function handleExistingUser() {
    setExistingUserBanner(true);
    setTimeout(() => setExistingUserBanner(false), 4000);
  }

  return (
    <div className="space-y-2xl">
      {/* Page header */}
      <div className="flex items-center justify-between gap-md flex-wrap">
        <div>
          <h1 className="text-h1 text-text">{t('staff.title')}</h1>
          <p className="text-label text-text-muted mt-xs">{t('staff.subtitle')}</p>
        </div>
        <Button
          variant="primary"
          onClick={() => setModal({ type: 'invite' })}
          aria-label={t('staff.invite')}
        >
          <svg
            aria-hidden="true"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          {t('staff.invite')}
        </Button>
      </div>

      {/* Existing-user banner */}
      {existingUserBanner && (
        <div
          role="status"
          aria-live="polite"
          className="p-sm rounded-sm bg-success/10 border border-success/30 text-label text-success"
        >
          {t('staff.existingUser')}
        </div>
      )}

      {/* Filter bar */}
      {!loading && !error && members.length > 0 && (
        <div className="flex flex-wrap items-center gap-md">
          <select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value as RoleFilter)}
            aria-label={t('staff.filter.allRoles')}
            className="h-9 px-sm rounded-sm text-label text-text bg-surface-3 border border-border
              transition-colors duration-fast focus:outline-none focus:ring-2 focus:ring-primary focus:border-border-strong"
          >
            <option value="">{t('staff.filter.allRoles')}</option>
            <option value="owner">{t('staff.role.owner')}</option>
            <option value="manager">{t('staff.role.manager')}</option>
            <option value="staff">{t('staff.role.staff')}</option>
          </select>

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            aria-label={t('staff.filter.allStatuses')}
            className="h-9 px-sm rounded-sm text-label text-text bg-surface-3 border border-border
              transition-colors duration-fast focus:outline-none focus:ring-2 focus:ring-primary focus:border-border-strong"
          >
            <option value="all">{t('staff.filter.allStatuses')}</option>
            <option value="active">{t('staff.filter.active')}</option>
            <option value="inactive">{t('staff.filter.inactive')}</option>
          </select>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-md" aria-busy="true" aria-label={t('state.loading')}>
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-20 rounded-md bg-surface-2 animate-pulse" />
          ))}
        </div>
      )}

      {/* Error */}
      {!loading && error && <ErrorState message={error} onRetry={fetchMembers} />}

      {/* Empty — no members at all */}
      {!loading && !error && members.length === 0 && (
        <EmptyState
          title={t('staff.empty.title')}
          body={t('staff.empty.body')}
          action={
            <Button variant="primary" onClick={() => setModal({ type: 'invite' })}>
              {t('staff.invite')}
            </Button>
          }
        />
      )}

      {/* Empty after filtering */}
      {!loading && !error && members.length > 0 && filtered.length === 0 && (
        <EmptyState title={t('staff.empty.title')} body={t('staff.empty.body')} />
      )}

      {/* Member list */}
      {!loading && !error && filtered.length > 0 && (
        <div className="space-y-sm">
          {filtered.map((member) => (
            <MemberCard
              key={member.profile_id}
              member={member}
              pending={pendingId === member.profile_id}
              onEdit={() => {
                setPendingId(member.profile_id);
                setModal({ type: 'edit', member });
              }}
              t={t}
            />
          ))}
        </div>
      )}

      {/* ── Dialogs ── */}

      {/* Invite */}
      {modal?.type === 'invite' && (
        <Dialog labelledBy="staff-invite-title" onClose={() => setModal(null)}>
          <div className="space-y-lg">
            <h2 id="staff-invite-title" className="text-h2 text-text">
              {t('staff.invite')}
            </h2>
            <InviteForm
              onClose={() => setModal(null)}
              onTempPassword={(pwd, email) => setModal({ type: 'tempPassword', password: pwd, email })}
              onExistingUser={handleExistingUser}
              onRefresh={() => void fetchMembers()}
            />
          </div>
        </Dialog>
      )}

      {/* Edit */}
      {modal?.type === 'edit' && (
        <Dialog labelledBy="staff-edit-title" onClose={() => { setModal(null); setPendingId(null); }}>
          <div className="space-y-lg">
            <h2 id="staff-edit-title" className="text-h2 text-text">
              {t('staff.edit')} — {modal.member.full_name || modal.member.profile_id.slice(0, 8)}
            </h2>
            <EditMemberForm
              member={modal.member}
              onClose={() => { setModal(null); setPendingId(null); }}
              onSaved={handleSaved}
            />
          </div>
        </Dialog>
      )}

      {/* Temp password — shown once */}
      {modal?.type === 'tempPassword' && (
        <Dialog labelledBy="staff-temppwd-title" onClose={() => setModal(null)}>
          <div className="space-y-lg">
            <h2 id="staff-temppwd-title" className="text-h2 text-text">
              {t('staff.tempPassword.title')}
            </h2>
            <TempPasswordDisplay
              password={modal.password}
              email={modal.email}
              onClose={() => setModal(null)}
            />
          </div>
        </Dialog>
      )}
    </div>
  );
}
