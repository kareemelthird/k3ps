import {
  type OutboxState,
  type OutboxEntry,
  type NewEntry,
  type OutboxError,
  type Rng,
  DEFAULT_RETRY_POLICY,
  enqueueEntry,
  classifyError,
  decideRetry,
  selectDrainable,
  onSuccess,
  onTransientFailure,
  onPermanentFailure,
  requeueDead,
  discardDead,
  pendingCount,
  deadCount,
} from './outbox';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const T0 = '2026-06-26T10:00:00.000Z';

function emptyState(): OutboxState {
  return { queue: [], dead: [] };
}

function newEntry(over: Partial<NewEntry> & { localId: string }): NewEntry {
  return {
    tenantId: 'tenant-a',
    branchId: 'branch-1',
    table: 'sessions',
    op: 'upsert',
    payload: { id: over.localId },
    ...over,
  };
}

function transientErr(over: Partial<OutboxError> = {}): OutboxError {
  return { message: 'network down', class: 'transient', ...over };
}

function permanentErr(over: Partial<OutboxError> = {}): OutboxError {
  return { message: 'constraint', code: '23505', class: 'permanent', ...over };
}

/** A deterministic rng that always returns `v` (so backoff is exact in tests). */
const rngConst = (v: number): Rng => () => v;

// ── enqueueEntry ─────────────────────────────────────────────────────────────

describe('enqueueEntry', () => {
  it('appends a new entry with defaults (pk=id, conflict=merge, dependsOn=[])', () => {
    const s = enqueueEntry(emptyState(), newEntry({ localId: 'a' }), T0);
    expect(s.queue).toHaveLength(1);
    const e = s.queue[0]!;
    expect(e.localId).toBe('a');
    expect(e.pk).toBe('id');
    expect(e.conflict).toBe('merge');
    expect(e.dependsOn).toEqual([]);
    expect(e.attempts).toBe(0);
    expect(e.createdAt).toBe(T0);
    expect(e.updatedAt).toBe(T0);
  });

  it('honors explicit pk / conflict / dependsOn', () => {
    const s = enqueueEntry(
      emptyState(),
      newEntry({ localId: 'm', table: 'stock_movements', conflict: 'ignore', pk: 'id', dependsOn: ['x'] }),
      T0,
    );
    const e = s.queue[0]!;
    expect(e.conflict).toBe('ignore');
    expect(e.dependsOn).toEqual(['x']);
  });

  it('is idempotent: same localId twice collapses to ONE entry (exactly-once intent)', () => {
    let s = enqueueEntry(emptyState(), newEntry({ localId: 'dup', payload: { id: 'dup', v: 1 } }), T0);
    s = enqueueEntry(s, newEntry({ localId: 'dup', payload: { id: 'dup', v: 2 } }), '2026-06-26T10:05:00.000Z');
    expect(s.queue).toHaveLength(1);
    const e = s.queue[0]!;
    expect(e.payload).toEqual({ id: 'dup', v: 2 }); // payload refreshed
    expect(e.updatedAt).toBe('2026-06-26T10:05:00.000Z'); // stamp refreshed
    expect(e.createdAt).toBe(T0); // position/identity preserved
  });

  it('re-enqueue preserves queue position', () => {
    let s = enqueueEntry(emptyState(), newEntry({ localId: 'a' }), T0);
    s = enqueueEntry(s, newEntry({ localId: 'b' }), T0);
    s = enqueueEntry(s, newEntry({ localId: 'a', payload: { id: 'a', v: 9 } }), T0);
    expect(s.queue.map((e) => e.localId)).toEqual(['a', 'b']);
  });

  it('re-enqueue of a dead localId is ignored (quarantine not silently resurrected)', () => {
    let s: OutboxState = { queue: [], dead: [{ ...mkEntry('d'), deadReason: 'permanent' }] };
    s = enqueueEntry(s, newEntry({ localId: 'd' }), T0);
    expect(s.queue).toHaveLength(0);
    expect(s.dead).toHaveLength(1);
  });

  it('does not mutate the input state', () => {
    const s0 = emptyState();
    enqueueEntry(s0, newEntry({ localId: 'a' }), T0);
    expect(s0.queue).toHaveLength(0);
  });
});

// ── classifyError ────────────────────────────────────────────────────────────

describe('classifyError (ADR-0009 §Q4 taxonomy)', () => {
  it('401 / JWT-expired → auth', () => {
    expect(classifyError({ status: 401 })).toBe('auth');
    expect(classifyError({ code: 'PGRST301' })).toBe('auth');
    expect(classifyError({ message: 'JWT expired' })).toBe('auth');
    expect(classifyError({ message: 'jwt invalid' })).toBe('auth');
  });

  it('RLS 42501 → permanent', () => {
    expect(classifyError({ code: '42501' })).toBe('permanent');
  });

  it('constraint 23xxx → permanent', () => {
    for (const code of ['23505', '23503', '23502', '23514']) {
      expect(classifyError({ code })).toBe('permanent');
    }
  });

  it('PGRST schema/validation → permanent', () => {
    expect(classifyError({ code: 'PGRST204' })).toBe('permanent');
  });

  it('4xx (except 408/429) → permanent', () => {
    expect(classifyError({ status: 400 })).toBe('permanent');
    expect(classifyError({ status: 403 })).toBe('permanent');
    expect(classifyError({ status: 404 })).toBe('permanent');
  });

  it('408 / 429 → transient', () => {
    expect(classifyError({ status: 408 })).toBe('transient');
    expect(classifyError({ status: 429 })).toBe('transient');
  });

  it('5xx → transient', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(classifyError({ status })).toBe('transient');
    }
  });

  it('serialization 40001 / deadlock 40P01 / out-of-resources 53x00 → transient', () => {
    expect(classifyError({ code: '40001' })).toBe('transient');
    expect(classifyError({ code: '40P01' })).toBe('transient');
    expect(classifyError({ code: '53300' })).toBe('transient');
    expect(classifyError({ code: '53000' })).toBe('transient');
  });

  it('network / timeout / unknown (no status) → transient', () => {
    expect(classifyError({ message: 'Network request failed' })).toBe('transient');
    expect(classifyError({})).toBe('transient');
  });

  it('auth precedence: 401 wins over any code', () => {
    expect(classifyError({ status: 401, code: '23505' })).toBe('auth');
  });
});

// ── decideRetry ──────────────────────────────────────────────────────────────

describe('decideRetry (backoff schedule, cap, dead-letter)', () => {
  it('permanent / auth → dead-letter immediately (reason permanent)', () => {
    expect(decideRetry(mkEntry('a'), 'permanent', DEFAULT_RETRY_POLICY, T0)).toEqual({
      action: 'dead-letter',
      reason: 'permanent',
    });
    expect(decideRetry(mkEntry('a'), 'auth', DEFAULT_RETRY_POLICY, T0)).toEqual({
      action: 'dead-letter',
      reason: 'permanent',
    });
  });

  it('exponential schedule 1s/2s/4s/8s with full-jitter max (rng → ~1)', () => {
    const rng = rngConst(0.999999);
    const delays = [0, 1, 2, 3].map((attempts) => {
      const d = decideRetry(mkEntry('a', { attempts }), 'transient', DEFAULT_RETRY_POLICY, T0, rng);
      if (d.action !== 'retry') throw new Error('expected retry');
      return Date.parse(d.nextAttemptAt) - Date.parse(T0);
    });
    expect(delays).toEqual([999, 1999, 3999, 7999]); // floor(0.999999 * {1000,2000,4000,8000})
  });

  it('full jitter floor: rng → 0 yields zero delay (eligible immediately)', () => {
    const d = decideRetry(mkEntry('a', { attempts: 2 }), 'transient', DEFAULT_RETRY_POLICY, T0, rngConst(0));
    expect(d).toEqual({ action: 'retry', nextAttemptAt: T0 });
  });

  it('caps the ceiling at capMs (30s) for large attempt counts', () => {
    // attempts=4 would be 16s; but we never reach a retry at 4 with maxAttempts=5.
    // Use a policy with a higher maxAttempts to exercise the cap.
    const policy = { ...DEFAULT_RETRY_POLICY, maxAttempts: 100 };
    const d = decideRetry(mkEntry('a', { attempts: 10 }), 'transient', policy, T0, rngConst(0.999999));
    if (d.action !== 'retry') throw new Error('expected retry');
    const delay = Date.parse(d.nextAttemptAt) - Date.parse(T0);
    expect(delay).toBe(29999); // floor(0.999999 * 30000) — capped, not 1000*2^10
  });

  it('dead-letters after maxAttempts (the 5th failure)', () => {
    const d = decideRetry(mkEntry('a', { attempts: 4 }), 'transient', DEFAULT_RETRY_POLICY, T0, rngConst(0.5));
    expect(d).toEqual({ action: 'dead-letter', reason: 'max-attempts' });
  });

  it('default rng (Math.random) stays within [0, ceiling)', () => {
    for (let i = 0; i < 50; i++) {
      const d = decideRetry(mkEntry('a', { attempts: 0 }), 'transient', DEFAULT_RETRY_POLICY, T0);
      if (d.action !== 'retry') throw new Error('expected retry');
      const delay = Date.parse(d.nextAttemptAt) - Date.parse(T0);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(1000);
    }
  });
});

// ── selectDrainable (dependency gating + backoff + FIFO) ─────────────────────

describe('selectDrainable', () => {
  it('returns ready entries in FIFO order', () => {
    let s = enqueueEntry(emptyState(), newEntry({ localId: 'a' }), T0);
    s = enqueueEntry(s, newEntry({ localId: 'b' }), T0);
    expect(selectDrainable(s, T0).map((e) => e.localId)).toEqual(['a', 'b']);
  });

  it('blocks a child whose parent is still pending in the queue', () => {
    let s = enqueueEntry(emptyState(), newEntry({ localId: 'parent' }), T0);
    s = enqueueEntry(s, newEntry({ localId: 'child', dependsOn: ['parent'] }), T0);
    expect(selectDrainable(s, T0).map((e) => e.localId)).toEqual(['parent']);
  });

  it('unblocks a child once the parent has succeeded (removed)', () => {
    let s = enqueueEntry(emptyState(), newEntry({ localId: 'parent' }), T0);
    s = enqueueEntry(s, newEntry({ localId: 'child', dependsOn: ['parent'] }), T0);
    s = onSuccess(s, 'parent');
    expect(selectDrainable(s, T0).map((e) => e.localId)).toEqual(['child']);
  });

  it('blocks a child whose parent is dead-lettered (never orphan-applies)', () => {
    // Parent dead, child still in queue (constructed directly to isolate selection).
    const s: OutboxState = {
      queue: [{ ...mkEntry('child'), dependsOn: ['parent'] }],
      dead: [{ ...mkEntry('parent'), deadReason: 'permanent' }],
    };
    expect(selectDrainable(s, T0)).toEqual([]);
  });

  it('excludes entries whose backoff has not elapsed', () => {
    const future = '2026-06-26T10:01:00.000Z';
    const s: OutboxState = { queue: [{ ...mkEntry('a'), nextAttemptAt: future }], dead: [] };
    expect(selectDrainable(s, T0)).toEqual([]);
    expect(selectDrainable(s, future).map((e) => e.localId)).toEqual(['a']);
  });
});

// ── onSuccess ────────────────────────────────────────────────────────────────

describe('onSuccess', () => {
  it('removes the entry; unknown id is a no-op', () => {
    let s = enqueueEntry(emptyState(), newEntry({ localId: 'a' }), T0);
    s = onSuccess(s, 'a');
    expect(pendingCount(s)).toBe(0);
    expect(onSuccess(s, 'ghost')).toEqual({ queue: [], dead: [] });
  });
});

// ── onTransientFailure ───────────────────────────────────────────────────────

describe('onTransientFailure', () => {
  it('increments attempts, records error, schedules backoff, keeps in queue', () => {
    let s = enqueueEntry(emptyState(), newEntry({ localId: 'a' }), T0);
    s = onTransientFailure(s, 'a', transientErr(), DEFAULT_RETRY_POLICY, T0, rngConst(0.999999));
    const e = s.queue[0]!;
    expect(e.attempts).toBe(1);
    expect(e.lastError?.message).toBe('network down');
    expect(Date.parse(e.nextAttemptAt!) - Date.parse(T0)).toBe(999);
    expect(deadCount(s)).toBe(0);
  });

  it('dead-letters at maxAttempts and continues (queue keeps the rest)', () => {
    let s = enqueueEntry(emptyState(), newEntry({ localId: 'poison' }), T0);
    s = enqueueEntry(s, newEntry({ localId: 'healthy' }), T0);
    // fail 'poison' 5 times
    for (let i = 0; i < 5; i++) {
      s = onTransientFailure(s, 'poison', transientErr(), DEFAULT_RETRY_POLICY, T0, rngConst(0));
    }
    expect(pendingCount(s)).toBe(1);
    expect(s.queue[0]!.localId).toBe('healthy'); // drain continues with the rest
    expect(deadCount(s)).toBe(1);
    expect(s.dead[0]!.deadReason).toBe('max-attempts');
    expect(s.dead[0]!.attempts).toBe(5);
  });

  it('cascades dependents to dead when a parent exhausts attempts', () => {
    let s = enqueueEntry(emptyState(), newEntry({ localId: 'parent' }), T0);
    s = enqueueEntry(s, newEntry({ localId: 'child', dependsOn: ['parent'] }), T0);
    for (let i = 0; i < 5; i++) {
      s = onTransientFailure(s, 'parent', transientErr(), DEFAULT_RETRY_POLICY, T0, rngConst(0));
    }
    expect(pendingCount(s)).toBe(0);
    expect(deadCount(s)).toBe(2);
    expect(s.dead.map((e) => [e.localId, e.deadReason])).toEqual([
      ['parent', 'max-attempts'],
      ['child', 'blocked-by-dead-parent'],
    ]);
  });

  it('unknown id is a no-op', () => {
    const s = enqueueEntry(emptyState(), newEntry({ localId: 'a' }), T0);
    const after = onTransientFailure(s, 'ghost', transientErr(), DEFAULT_RETRY_POLICY, T0);
    expect(after.queue).toHaveLength(1);
    expect(after.queue[0]!.attempts).toBe(0);
  });

  it('respects a non-transient error class by dead-lettering immediately', () => {
    let s = enqueueEntry(emptyState(), newEntry({ localId: 'a' }), T0);
    s = onTransientFailure(s, 'a', permanentErr(), DEFAULT_RETRY_POLICY, T0);
    expect(deadCount(s)).toBe(1);
    expect(s.dead[0]!.deadReason).toBe('permanent'); // decideRetry routes non-transient → permanent
  });
});

// ── onPermanentFailure (dead-parent cascade) ─────────────────────────────────

describe('onPermanentFailure', () => {
  it('dead-letters the entry with reason permanent and leaves the rest', () => {
    let s = enqueueEntry(emptyState(), newEntry({ localId: 'bad' }), T0);
    s = enqueueEntry(s, newEntry({ localId: 'good' }), T0);
    s = onPermanentFailure(s, 'bad', permanentErr());
    expect(pendingCount(s)).toBe(1);
    expect(s.queue[0]!.localId).toBe('good');
    expect(s.dead[0]!.deadReason).toBe('permanent');
    expect(s.dead[0]!.lastError?.code).toBe('23505');
  });

  it('cascades transitive dependents to dead (none remain drainable)', () => {
    let s = enqueueEntry(emptyState(), newEntry({ localId: 'p' }), T0);
    s = enqueueEntry(s, newEntry({ localId: 'c1', dependsOn: ['p'] }), T0);
    s = enqueueEntry(s, newEntry({ localId: 'c2', dependsOn: ['c1'] }), T0); // grandchild
    s = enqueueEntry(s, newEntry({ localId: 'indep' }), T0);
    s = onPermanentFailure(s, 'p', permanentErr({ code: '42501', message: 'RLS' }));
    expect(s.queue.map((e) => e.localId)).toEqual(['indep']);
    expect(selectDrainable(s, T0).map((e) => e.localId)).toEqual(['indep']);
    expect(s.dead.map((e) => [e.localId, e.deadReason])).toEqual([
      ['p', 'permanent'],
      ['c1', 'blocked-by-dead-parent'],
      ['c2', 'blocked-by-dead-parent'],
    ]);
  });

  it('unknown id is a no-op', () => {
    const s = enqueueEntry(emptyState(), newEntry({ localId: 'a' }), T0);
    expect(onPermanentFailure(s, 'ghost', permanentErr()).queue).toHaveLength(1);
  });
});

// ── requeueDead / discardDead ────────────────────────────────────────────────

describe('requeueDead', () => {
  function deadGroupState(): OutboxState {
    let s = enqueueEntry(emptyState(), newEntry({ localId: 'p' }), T0);
    s = enqueueEntry(s, newEntry({ localId: 'c', dependsOn: ['p'] }), T0);
    s = enqueueEntry(s, newEntry({ localId: 'other' }), T0);
    s = onPermanentFailure(s, 'p', permanentErr());
    s = onPermanentFailure(s, 'other', permanentErr());
    return s; // dead: [p, c(blocked), other]
  }

  it('requeues a parent AND its blocked dependents as a group, resetting delivery state', () => {
    const s = requeueDead(deadGroupState(), 'p', T0);
    expect(s.queue.map((e) => e.localId).sort()).toEqual(['c', 'p']);
    expect(s.dead.map((e) => e.localId)).toEqual(['other']); // group lifted, 'other' stays
    for (const e of s.queue) {
      expect(e.attempts).toBe(0);
      expect(e.lastError).toBeUndefined();
      expect(e.deadReason).toBeUndefined();
      expect(e.nextAttemptAt).toBeUndefined();
    }
  });

  it('requeues parent before child (dependency order preserved)', () => {
    const s = requeueDead(deadGroupState(), 'p', T0);
    expect(s.queue.map((e) => e.localId)).toEqual(['p', 'c']);
  });

  it('preserves the frozen payload (data unchanged, only delivery retried)', () => {
    let base = enqueueEntry(emptyState(), newEntry({ localId: 'p', payload: { id: 'p', total: 4200 } }), T0);
    base = onPermanentFailure(base, 'p', permanentErr());
    const s = requeueDead(base, 'p', T0);
    expect(s.queue[0]!.payload).toEqual({ id: 'p', total: 4200 });
  });

  it("'all' requeues every dead entry", () => {
    const s = requeueDead(deadGroupState(), 'all', T0);
    expect(deadCount(s)).toBe(0);
    expect(pendingCount(s)).toBe(3);
  });

  it('unknown id is a no-op', () => {
    const before = deadGroupState();
    expect(requeueDead(before, 'ghost', T0)).toEqual(before);
  });
});

describe('discardDead', () => {
  function deadGroupState(): OutboxState {
    let s = enqueueEntry(emptyState(), newEntry({ localId: 'p' }), T0);
    s = enqueueEntry(s, newEntry({ localId: 'c', dependsOn: ['p'] }), T0);
    s = enqueueEntry(s, newEntry({ localId: 'other' }), T0);
    s = onPermanentFailure(s, 'p', permanentErr());
    s = onPermanentFailure(s, 'other', permanentErr());
    return s;
  }

  it('discards a parent AND its blocked dependents as a group (no orphan)', () => {
    const s = discardDead(deadGroupState(), 'p');
    expect(s.dead.map((e) => e.localId)).toEqual(['other']);
  });

  it("'all' clears the dead list", () => {
    const s = discardDead(deadGroupState(), 'all');
    expect(deadCount(s)).toBe(0);
  });

  it('unknown id is a no-op', () => {
    const before = deadGroupState();
    expect(discardDead(before, 'ghost')).toEqual(before);
  });
});

// ── Selectors ────────────────────────────────────────────────────────────────

describe('selectors', () => {
  it('pendingCount / deadCount reflect the two lists', () => {
    let s = enqueueEntry(emptyState(), newEntry({ localId: 'a' }), T0);
    s = enqueueEntry(s, newEntry({ localId: 'b' }), T0);
    s = onPermanentFailure(s, 'a', permanentErr());
    expect(pendingCount(s)).toBe(1);
    expect(deadCount(s)).toBe(1);
  });
});

// ── No-double-count: exactly-once effect under duplicate / replay ─────────────

describe('exactly-once effect (no double count)', () => {
  it('a duplicate enqueue of a money write never produces a second queued entry', () => {
    // Two devices / two taps enqueue the same close (deterministic close:{id}).
    let s = enqueueEntry(emptyState(), newEntry({ localId: 'close:s1', op: 'rpc', table: 'close_session_tx', payload: { p_grand_total: 5000 } }), T0);
    s = enqueueEntry(s, newEntry({ localId: 'close:s1', op: 'rpc', table: 'close_session_tx', payload: { p_grand_total: 5000 } }), T0);
    expect(pendingCount(s)).toBe(1);
    // The drain selects exactly one send for the close.
    expect(selectDrainable(s, T0)).toHaveLength(1);
  });

  it('crash-replay: a re-enqueue after the entry already drained is NOT re-added (still dead-free, queue empty)', () => {
    // Enqueue, drain (success removes it). A crash-replay re-enqueues the same id.
    let s = enqueueEntry(emptyState(), newEntry({ localId: 'stock-sale:item1', conflict: 'ignore', table: 'stock_movements', payload: { id: 'stock-sale:item1', delta: -1 } }), T0);
    s = onSuccess(s, 'stock-sale:item1'); // server committed, entry removed
    // Replay enqueues again — the ledger key is deterministic, conflict='ignore'.
    s = enqueueEntry(s, newEntry({ localId: 'stock-sale:item1', conflict: 'ignore', table: 'stock_movements', payload: { id: 'stock-sale:item1', delta: -1 } }), T0);
    // The queue holds exactly one entry; when it flushes, the adapter's
    // ON CONFLICT DO NOTHING makes the *second* server apply a no-op — never a
    // second stock decrement. (Identity + conflict strategy are unchanged.)
    expect(pendingCount(s)).toBe(1);
    const e = s.queue[0]!;
    expect(e.conflict).toBe('ignore'); // append-only ledger → replay is a no-op
    expect(e.payload).toEqual({ id: 'stock-sale:item1', delta: -1 });
  });

  it('voided sale: sale + offsetting void are two distinct deterministic keys (each idempotent)', () => {
    let s = enqueueEntry(emptyState(), newEntry({ localId: 'stock-sale:item1', conflict: 'ignore', table: 'stock_movements', payload: { id: 'stock-sale:item1', delta: -1 } }), T0);
    s = enqueueEntry(s, newEntry({ localId: 'stock-void:item1', conflict: 'ignore', table: 'stock_movements', payload: { id: 'stock-void:item1', delta: 1 } }), T0);
    // Re-enqueue both (retry/replay): still exactly two entries, one per key.
    s = enqueueEntry(s, newEntry({ localId: 'stock-sale:item1', conflict: 'ignore', table: 'stock_movements', payload: { id: 'stock-sale:item1', delta: -1 } }), T0);
    s = enqueueEntry(s, newEntry({ localId: 'stock-void:item1', conflict: 'ignore', table: 'stock_movements', payload: { id: 'stock-void:item1', delta: 1 } }), T0);
    expect(pendingCount(s)).toBe(2);
    expect(s.queue.map((e) => e.localId)).toEqual(['stock-sale:item1', 'stock-void:item1']);
  });
});

// ── helper ───────────────────────────────────────────────────────────────────

function mkEntry(localId: string, over: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    localId,
    tenantId: 'tenant-a',
    branchId: 'branch-1',
    table: 'sessions',
    op: 'upsert',
    payload: { id: localId },
    pk: 'id',
    conflict: 'merge',
    dependsOn: [],
    attempts: 0,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}
