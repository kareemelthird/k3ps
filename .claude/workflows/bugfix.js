export const meta = {
  name: 'bugfix',
  description: 'Fix a reported bug with confidence: reproduce -> diagnose root cause -> adversarially confirm the cause -> fix in an isolated worktree -> QA re-verify. Loops once if the first fix does not hold.',
  whenToUse: 'Run when a bug is reported during or after a phase. Pass the bug report as args (string) or {report, surface}.',
  phases: [{ title: 'Diagnose' }, { title: 'Confirm' }, { title: 'Fix' }, { title: 'Verify' }],
};

const report = (typeof args === 'string' ? args : args?.report) || 'UNSPECIFIED BUG';
const surface = (args && args.surface) || 'core';
const ENGINEER = { core: 'core-engineer', backend: 'backend-engineer', mobile: 'mobile-engineer', web: 'web-engineer' };

const DIAG = {
  type: 'object',
  required: ['reproduced', 'rootCause', 'proposedFix'],
  properties: {
    reproduced: { type: 'boolean' },
    repro: { type: 'string' },
    rootCause: { type: 'string' },
    proposedFix: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
  },
};
const VERDICT = { type: 'object', required: ['isReal', 'reason'], properties: { isReal: { type: 'boolean' }, reason: { type: 'string' } } };
const QA = { type: 'object', required: ['fixed'], properties: { fixed: { type: 'boolean' }, evidence: { type: 'string' }, regressions: { type: 'array', items: { type: 'string' } } } };

// 1. Diagnose
phase('Diagnose');
const diag = await agent(
  `You are the ${ENGINEER[surface]}. Reproduce this bug, find the ROOT cause (not the symptom), and propose a fix + a regression test. ` +
    `Do NOT apply the fix yet.\n\nBUG REPORT:\n${report}`,
  { agentType: ENGINEER[surface], phase: 'Diagnose', schema: DIAG, label: 'diagnose' }
);

if (!diag?.reproduced) {
  return { status: 'could-not-reproduce', report, note: diag?.repro || 'Bug could not be reproduced; need more info from reporter.' };
}

// 2. Confirm root cause adversarially
phase('Confirm');
const confirm = await agent(
  `Adversarially evaluate this root-cause diagnosis. Try to show it is WRONG or incomplete (a deeper cause, a wrong file). ` +
    `Mark isReal=true only if the diagnosis truly explains the bug.\n\nRoot cause: ${diag.rootCause}\nProposed fix: ${diag.proposedFix}\nFiles: ${(diag.files || []).join(', ')}`,
  { phase: 'Confirm', schema: VERDICT, label: 'confirm-cause' }
);

if (!confirm?.isReal) {
  // Re-diagnose once with the skeptic's objection in hand.
  const rediag = await agent(
    `Your previous diagnosis was challenged: "${confirm?.reason}". Re-diagnose this bug accounting for that objection, ` +
      `and propose a corrected fix + test.\n\nBUG:\n${report}\n\nPrevious (suspect) root cause: ${diag.rootCause}`,
    { agentType: ENGINEER[surface], phase: 'Confirm', schema: DIAG, label: 'rediagnose' }
  );
  if (rediag) Object.assign(diag, rediag);
}

// 3. Fix (isolated worktree)
phase('Fix');
const fix = await agent(
  `You are the ${ENGINEER[surface]}. Apply this fix and ADD the regression test, then run ps-verify.\n\n` +
    `Root cause: ${diag.rootCause}\nFix: ${diag.proposedFix}\nFiles: ${(diag.files || []).join(', ')}`,
  { agentType: ENGINEER[surface], phase: 'Fix', label: 'apply-fix', isolation: 'worktree' }
);

// 4. Verify
phase('Verify');
const qa = await agent(
  `You are the qa-tester. Confirm the bug is fixed and nothing regressed. Run ps-verify + the new regression test.\n\n` +
    `BUG:\n${report}\n\nFIX SUMMARY:\n${fix}`,
  { agentType: 'qa-tester', phase: 'Verify', schema: QA, label: 'verify-fix' }
);

return {
  status: qa?.fixed ? 'fixed' : 'fix-incomplete',
  rootCause: diag.rootCause,
  files: diag.files,
  evidence: qa?.evidence,
  regressions: qa?.regressions || [],
  note: qa?.fixed ? 'Fix verified. Include in next human-gate summary.' : 'Fix did not hold — escalate to engineer + human.',
};
