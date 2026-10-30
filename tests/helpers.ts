import { validateModel } from '../src/model/validate';
import type { ModelSpec } from '../src/model/types';

/** Validates a model and fails loudly if it is not runnable. */
export function valid(data: unknown): ModelSpec {
  const r = validateModel(data);
  if (!r.ok) throw new Error(r.errors.map((e) => e.message).join('\n'));
  return r.model!;
}

/** A source → queue → c servers → sink model with exponential arrivals and service. */
export function mmc(ratePerHour: number, meanServiceMin: number, servers: number, run: ModelSpec['run']): ModelSpec {
  return valid({
    version: '0.1',
    entityLabel: 'customer',
    blocks: [
      { id: 'in', type: 'source', label: 'In', x: 0, y: 0, arrival: { dist: 'exponential', ratePerHour } },
      { id: 'q', type: 'queue', label: 'Line', x: 1, y: 0 },
      { id: 's', type: 'server', label: 'Server', x: 2, y: 0, servers, service: { dist: 'exponential', meanMin: meanServiceMin } },
      { id: 'out', type: 'sink', label: 'Out', x: 3, y: 0 },
    ],
    links: [
      { from: 'in', to: 'q' },
      { from: 'q', to: 's' },
      { from: 's', to: 'out' },
    ],
    run,
  });
}
