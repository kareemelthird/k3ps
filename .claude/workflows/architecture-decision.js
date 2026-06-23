export const meta = {
  name: 'architecture-decision',
  description: 'Resolve a hard, hard-to-reverse decision (e.g. tenant isolation model) via a judge panel: generate N independent approaches, score each from multiple lenses, synthesize a recommendation, and write an ADR for the human to approve.',
  whenToUse: 'Run when the architect faces a significant decision with multiple viable options. Pass the question as args (string) or {question, options:[...], criteria:[...]}.',
  phases: [
    { title: 'Frame' },
    { title: 'Explore' },
    { title: 'Judge' },
    { title: 'Synthesize' },
  ],
};

const question = (typeof args === 'string' ? args : args?.question) || 'UNSPECIFIED DECISION';
const seedOptions = (args && args.options) || null; // optional explicit option list
const criteria = (args && args.criteria) || [
  'tenant isolation strength',
  'operational complexity / migrations',
  'cost at scale',
  'developer velocity',
  'reversibility',
];

const OPTION = {
  type: 'object',
  required: ['name', 'approach', 'pros', 'cons'],
  properties: {
    name: { type: 'string' },
    approach: { type: 'string' },
    pros: { type: 'array', items: { type: 'string' } },
    cons: { type: 'array', items: { type: 'string' } },
    evidence: { type: 'array', items: { type: 'string' } }, // cited URLs
  },
};

const SCORE = {
  type: 'object',
  required: ['option', 'total', 'rationale'],
  properties: {
    option: { type: 'string' },
    perCriterion: { type: 'array', items: { type: 'object', properties: { criterion: { type: 'string' }, score: { type: 'number' } } } },
    total: { type: 'number' },
    rationale: { type: 'string' },
  },
};

// 1. Frame: architect lists the realistic options (unless caller provided them).
phase('Frame');
let options = seedOptions;
if (!options) {
  const framed = await agent(
    `You are the architect. Frame the realistic options for this decision. Use deep-research/WebSearch and cite sources. ` +
      `Return 2-4 distinct options.\n\nDECISION:\n${question}\n\nEvaluation criteria: ${criteria.join(', ')}`,
    { agentType: 'architect', phase: 'Frame', schema: { type: 'object', required: ['options'], properties: { options: { type: 'array', items: OPTION } } }, label: 'frame' }
  );
  options = (framed?.options || []).map((o) => o.name);
}
log(`Options: ${options.join(' | ')}`);

// 2. Explore: one independent agent deep-dives each option (parallel).
phase('Explore');
const explored = (
  await parallel(
    options.map((opt) => () =>
      agent(
        `You are the architect exploring ONE option for this decision. Research it thoroughly (cite sources) and report ` +
          `its approach, pros, cons, and evidence for our multi-tenant gaming-cafe SaaS (see CLAUDE.md §5).\n\n` +
          `DECISION: ${question}\nOPTION: ${opt}\nCriteria: ${criteria.join(', ')}`,
        { agentType: 'architect', phase: 'Explore', schema: OPTION, label: `explore:${opt}`.slice(0, 40) }
      )
    )
  )
).filter(Boolean);

// 3. Judge: independent scorers rate every option across criteria (parallel).
phase('Judge');
const optionBlock = explored
  .map((o) => `## ${o.name}\nApproach: ${o.approach}\nPros: ${(o.pros || []).join('; ')}\nCons: ${(o.cons || []).join('; ')}`)
  .join('\n\n');

const judges = (
  await parallel(
    explored.map((o) => () =>
      agent(
        `Score this option from 0-10 on each criterion (${criteria.join(', ')}) for our multi-tenant SaaS, then give a weighted total ` +
          `(isolation strength weighted highest). Be critical and independent.\n\n## OPTION TO SCORE: ${o.name}\n\n## ALL OPTIONS FOR CONTEXT:\n${optionBlock}`,
        { phase: 'Judge', schema: SCORE, label: `judge:${o.name}`.slice(0, 40) }
      )
    )
  )
).filter(Boolean);

judges.sort((a, b) => (b.total || 0) - (a.total || 0));
const winner = judges[0];

// 4. Synthesize: architect writes the ADR recommending the winner, grafting runner-up strengths.
phase('Synthesize');
const adr = await agent(
  `You are the architect. Using the adr-write skill, WRITE an ADR to docs/adr/ recommending the winning option and ` +
    `noting trade-offs + what must be verified (isolation tests). Graft useful ideas from runners-up.\n\n` +
    `DECISION: ${question}\n\nSCORES (high to low):\n${judges.map((j) => `${j.option}: ${j.total} — ${j.rationale}`).join('\n')}\n\n` +
    `RECOMMENDED: ${winner?.option}`,
  { agentType: 'architect', phase: 'Synthesize', schema: { type: 'object', required: ['adrPath', 'recommendation', 'summary'], properties: { adrPath: { type: 'string' }, recommendation: { type: 'string' }, summary: { type: 'string' }, mustVerify: { type: 'array', items: { type: 'string' } } } }, label: 'adr' }
);

return {
  question,
  ranked: judges.map((j) => ({ option: j.option, total: j.total })),
  recommendation: adr?.recommendation || winner?.option,
  adrPath: adr?.adrPath,
  summary: adr?.summary,
  mustVerify: adr?.mustVerify || [],
  note: 'HUMAN APPROVAL REQUIRED: review the ADR before this decision is locked in.',
};
