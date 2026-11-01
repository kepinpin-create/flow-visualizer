// The step bar under the header: where you are in plan → blocks → numbers → run → improve,
// with one click to the next action.

export interface StepState {
  hasPlan: boolean;
  blocks: number;
  links: number;
  problems: number;
  ranFresh: boolean;
  improved: boolean;
}

type Status = 'done' | 'current' | 'todo' | 'skipped';

interface Step {
  id: 'plan' | 'blocks' | 'numbers' | 'run' | 'improve';
  label: string;
  status: (s: StepState) => 'done' | 'todo' | 'skipped';
  hint: (s: StepState) => string;
}

const STEPS: Step[] = [
  {
    id: 'plan', label: 'Floor plan',
    status: (s) => (s.hasPlan ? 'done' : s.blocks ? 'skipped' : 'todo'),
    hint: (s) => (s.hasPlan ? 'Uploaded' : s.blocks ? 'Optional' : 'Upload a plan'),
  },
  {
    id: 'blocks', label: 'Blocks & flow',
    status: (s) => (s.blocks && s.links ? 'done' : 'todo'),
    hint: (s) => (s.blocks ? `${s.blocks} blocks, ${s.links} links` : 'Place or let AI place'),
  },
  {
    id: 'numbers', label: 'Numbers',
    status: (s) => (s.blocks && !s.problems ? 'done' : 'todo'),
    hint: (s) => (!s.blocks ? 'Rates and times' : s.problems ? `${s.problems} to fix` : 'All set'),
  },
  {
    id: 'run', label: 'Run',
    status: (s) => (s.ranFresh ? 'done' : 'todo'),
    hint: (s) => (s.ranFresh ? 'Results ready' : 'Simulate the day'),
  },
  {
    id: 'improve', label: 'Improve',
    status: (s) => (s.improved ? 'done' : 'todo'),
    hint: (s) => (s.improved ? 'Ideas tested' : 'AI review, optimize'),
  },
];

export function setupSteps(host: HTMLElement, act: (id: Step['id']) => void) {
  host.addEventListener('click', (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('[data-step]')?.dataset.step as Step['id'] | undefined;
    if (id) act(id);
  });

  return {
    update(s: StepState) {
      let currentFound = false;
      const items = STEPS.map((step, i) => {
        const base = step.status(s);
        let status: Status = base;
        if (base === 'todo' && !currentFound) {
          status = 'current';
          currentFound = true;
        }
        const mark = status === 'done'
          ? '<svg class="i" aria-hidden="true"><use href="#i-check"/></svg>'
          : `<span aria-hidden="true">${i + 1}</span>`;
        const sr = status === 'done' ? 'done' : status === 'current' ? 'next step' : status === 'skipped' ? 'optional, skipped' : 'to do';
        return `<li class="step ${status}">
          <button type="button" data-step="${step.id}" ${status === 'current' ? 'aria-current="step"' : ''}>
            <span class="dot">${mark}</span>
            <span class="txt"><strong>${step.label}</strong><small>${step.hint(s)}</small></span>
            <span class="visually-hidden">(${sr})</span>
          </button>
        </li>`;
      });
      host.innerHTML = `<ol>${items.join('')}</ol>`;
    },
  };
}
