export const meta = {
  name: 'feature',
  description: 'Build one feature/phase end-to-end: spec -> design -> build (parallel, isolated) -> test -> adversarial review -> debate/reconcile -> human-gate summary.',
  whenToUse: 'Run for each feature or phase of PS-Managment. Pass the feature goal as args (string) or {goal, surfaces}. Ends by returning a human-gate summary; the human approves before the next phase.',
  phases: [
    { title: 'Spec' },
    { title: 'Design' },
    { title: 'Build' },
    { title: 'Test' },
    { title: 'Review' },
    { title: 'Reconcile' },
    { title: 'Gate' },
  ],
};

// ---- Inputs -------------------------------------------------------------
const goal = (typeof args === 'string' ? args : args?.goal) || 'UNSPECIFIED FEATURE GOAL';
// Which engineer lanes to fan out. Defaults to all; pass {surfaces:[...]} to scope.
const surfaces = (args && args.surfaces) || ['core', 'backend', 'mobile', 'web'];

const ENGINEER = {
  core: 'core-engineer',
  backend: 'backend-engineer',
  mobile: 'mobile-engineer',
  web: 'web-engineer',
};

// ---- Schemas (force structured returns) ---------------------------------
const SPEC = {
  type: 'object',
  required: ['summary', 'acceptanceCriteria', 'handoff'],
  properties: {
    summary: { type: 'string' },
    inScope: { type: 'array', items: { type: 'string' } },
    outOfScope: { type: 'array', items: { type: 'string' } },
    acceptanceCriteria: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
    handoff: { type: 'string' },
    specPath: { type: 'string' },
  },
};

const DESIGN = {
  type: 'object',
  required: ['summary'],
  properties: {
    summary: { type: 'string' },
    docPath: { type: 'string' },
    componentContracts: { type: 'array', items: { type: 'string' } },
    decisions: { type: 'array', items: { type: 'string' } },
  },
};

const BUILD = {
  type: 'object',
  required: ['surface', 'summary', 'filesTouched'],
  properties: {
    surface: { type: 'string' },
    summary: { type: 'string' },
    filesTouched: { type: 'array', items: { type: 'string' } },
    contractGaps: { type: 'array', items: { type: 'string' } },
    manualTestSteps: { type: 'array', items: { type: 'string' } },
  },
};

const QA = {
  type: 'object',
  required: ['verifyPassed', 'criteria'],
  properties: {
    verifyPassed: { type: 'boolean' },
    coverageCore: { type: 'string' },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        required: ['criterion', 'pass'],
        properties: {
          criterion: { type: 'string' },
          pass: { type: 'boolean' },
          repro: { type: 'string' },
        },
      },
    },
    failingOutput: { type: 'string' },
  },
};

const FINDINGS = {
  type: 'object',
  required: ['findings', 'signOff'],
  properties: {
    signOff: { type: 'boolean' }, // security: RLS/auth sign-off; code: no blockers
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'severity', 'file', 'fix'],
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['blocker', 'should-fix', 'nit'] },
          file: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
  },
};

const VERDICT = {
  type: 'object',
  required: ['isReal', 'reason'],
  properties: { isReal: { type: 'boolean' }, reason: { type: 'string' } },
};

// ---- 1. Spec ------------------------------------------------------------
phase('Spec');
const spec = await agent(
  `You are the product-manager. Read CLAUDE.md, docs/ROADMAP.md, docs/BACKLOG.md, and the Pochinki trial for prior art.\n` +
    `Produce the spec for this feature/phase and WRITE it to docs/specs/. Goal:\n\n${goal}\n\n` +
    `Return the structured spec; acceptanceCriteria must be testable Given/When/Then statements.`,
  { agentType: 'product-manager', phase: 'Spec', schema: SPEC, label: 'spec' }
);

const acceptance = (spec?.acceptanceCriteria || []).join('\n- ');

// ---- 2. Design (technical + UX in parallel) -----------------------------
phase('Design');
const needsUx = surfaces.includes('mobile') || surfaces.includes('web');
const designs = await parallel(
  [
    () =>
      agent(
        `You are the architect. Based on this spec, produce the technical design + an ADR for any hard decision ` +
          `(WRITE the ADR to docs/adr/ using the adr-write skill). Enforce tenant isolation per CLAUDE.md §5.\n\nSPEC:\n${spec?.summary}\n\nAcceptance:\n- ${acceptance}\n\nHandoff:\n${spec?.handoff}`,
        { agentType: 'architect', phase: 'Design', schema: DESIGN, label: 'design:architecture' }
      ),
    ...(needsUx
      ? [
          () =>
            agent(
              `You are the ux-designer. Produce the screen/flow design + component contracts for this feature and WRITE to docs/design/. ` +
                `Arabic-first RTL, counter-speed. Mine the Pochinki .design-src references.\n\nSPEC:\n${spec?.summary}\n\nAcceptance:\n- ${acceptance}`,
              { agentType: 'ux-designer', phase: 'Design', schema: DESIGN, label: 'design:ux' }
            ),
        ]
      : []),
  ]
);
const archDesign = designs[0];
const uxDesign = designs[1];

// ---- 3. Build (parallel lanes, worktree-isolated to avoid conflicts) ----
phase('Build');
const builds = (
  await parallel(
    surfaces.map((s) => () =>
      agent(
        `You are the ${ENGINEER[s]}. Implement the "${s}" slice of this feature to the spec + design + contracts.\n\n` +
          `SPEC:\n${spec?.summary}\n\nACCEPTANCE:\n- ${acceptance}\n\n` +
          `TECH DESIGN:\n${archDesign?.summary || '(see docs/design & docs/adr)'}\n\n` +
          `UX DESIGN:\n${uxDesign?.summary || '(n/a for this surface)'}\n\n` +
          `Honor CLAUDE.md rules. Run your skills (ps-verify etc.) before returning.`,
        {
          agentType: ENGINEER[s],
          phase: 'Build',
          schema: BUILD,
          label: `build:${s}`,
          // Lanes own disjoint paths (packages/core, supabase, apps/*) so they build
          // directly in the working tree. Re-enable isolation:'worktree' only if two
          // lanes ever edit the same files AND you add a merge-back step.
        }
      )
    )
  )
).filter(Boolean);

// ---- 4. Test ------------------------------------------------------------
phase('Test');
const qa = await agent(
  `You are the qa-tester. Run ps-verify and validate EVERY acceptance criterion below. Add tests for gaps ` +
    `(money invariants via pricing-engine-guard, tenant isolation via rls-tenant-audit). Report honestly.\n\n` +
    `ACCEPTANCE CRITERIA:\n- ${acceptance}\n\n` +
    `WHAT WAS BUILT:\n${builds.map((b) => `[${b.surface}] ${b.summary}`).join('\n')}`,
  { agentType: 'qa-tester', phase: 'Test', schema: QA, label: 'qa' }
);

// ---- 5. Review (code + security in parallel, each finding verified) -----
phase('Review');
const touchedBackend = surfaces.includes('backend');
const reviews = (
  await parallel([
    () =>
      agent(
        `You are the code-reviewer. Review the diff for this feature at high effort. Enforce CLAUDE.md rules. ` +
          `For each finding give file, severity, concrete fix. Be self-skeptical.\n\nSPEC:\n${spec?.summary}`,
        { agentType: 'code-reviewer', phase: 'Review', schema: FINDINGS, label: 'review:code' }
      ),
    ...(touchedBackend
      ? [
          () =>
            agent(
              `You are the security-reviewer. Audit auth + RLS + tenant isolation for this feature. ` +
                `Demand isolation tests (rls-tenant-audit). Give an explicit sign-off verdict. Any cross-tenant leak is a blocker.\n\nSPEC:\n${spec?.summary}`,
              { agentType: 'security-reviewer', phase: 'Review', schema: FINDINGS, label: 'review:security' }
            ),
        ]
      : []),
  ])
).filter(Boolean);

const allFindings = reviews.flatMap((r) => r.findings || []);

// Adversarial verify: a skeptic tries to refute each finding; keep only the real ones.
const verified = (
  await parallel(
    allFindings.map((f) => () =>
      agent(
        `Adversarially evaluate this review finding. Try to REFUTE it. If you cannot show it is a real problem, mark isReal=false.\n\n` +
          `Finding: ${f.title}\nFile: ${f.file}\nProposed fix: ${f.fix}\nSeverity: ${f.severity}`,
        { phase: 'Review', schema: VERDICT, label: `verify:${(f.file || 'finding').slice(-24)}` }
      ).then((v) => ({ ...f, verdict: v }))
    )
  )
).filter(Boolean);

const realFindings = verified.filter((f) => f.verdict?.isReal);
const blockers = realFindings.filter((f) => f.severity === 'blocker');

// ---- 6. Reconcile / debate ----------------------------------------------
phase('Reconcile');
let reconciliation = { fixed: [], remaining: realFindings };
if (blockers.length > 0) {
  // Route blockers back to the owning engineer lane(s) to fix, then note outcome.
  const fixSummaries = (
    await parallel(
      surfaces.map((s) => () => {
        const mine = blockers.filter((b) => (b.file || '').includes(`/${s}/`) || (b.file || '').includes(`${s}\\`));
        if (mine.length === 0) return Promise.resolve(null);
        return agent(
          `You are the ${ENGINEER[s]}. Fix these verified BLOCKER findings in your lane, then re-run ps-verify.\n\n` +
            mine.map((m) => `- ${m.title} (${m.file}): ${m.fix}`).join('\n'),
          { agentType: ENGINEER[s], phase: 'Reconcile', label: `fix:${s}` }
        );
      })
    )
  ).filter(Boolean);
  reconciliation = { fixed: fixSummaries, remaining: realFindings.filter((f) => f.severity !== 'blocker') };
  log(`Reconciled ${blockers.length} blocker(s) across lanes.`);
}

// ---- 7. Human-gate summary ----------------------------------------------
phase('Gate');
const summary = {
  goal,
  spec: { path: spec?.specPath, summary: spec?.summary, openQuestions: spec?.openQuestions || [] },
  design: { architecture: archDesign?.summary, ux: uxDesign?.summary || null, adrs: archDesign?.decisions || [] },
  built: builds.map((b) => ({ surface: b.surface, summary: b.summary, contractGaps: b.contractGaps || [] })),
  test: {
    verifyPassed: qa?.verifyPassed,
    coverageCore: qa?.coverageCore,
    failedCriteria: (qa?.criteria || []).filter((c) => !c.pass),
  },
  security: reviews.find((r) => r.findings && r.signOff !== undefined) ? { signedOff: reviews.map((r) => r.signOff) } : null,
  findingsConfirmed: realFindings.map((f) => ({ title: f.title, severity: f.severity, file: f.file })),
  blockersRemaining: blockers.filter((f) => f.severity === 'blocker' && !reconciliation.fixed?.length),
  readyForHuman: !!qa?.verifyPassed && (qa?.criteria || []).every((c) => c.pass) && blockers.length === 0,
  note: 'HUMAN APPROVAL REQUIRED before starting the next phase. Review failedCriteria, findingsConfirmed, and openQuestions.',
};

log(summary.readyForHuman ? 'Feature READY for human gate.' : 'Feature has open items — see summary.');
return summary;
