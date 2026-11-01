// Runs one experiment in a background worker and resolves with its result.
import type { ModelSpec } from '../model/types';
import type { ExperimentResult } from './experiment';
import type { WorkerRequest, WorkerResponse } from './worker';
// Vite builds this as a classic worker (see vite.config.ts), so older browsers can run it too.
import SimulationWorker from './worker?worker';

export function runInWorker(
  model: ModelSpec,
  opts: { distances?: Record<string, number>; recordLog?: boolean; onProgress?: (done: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<ExperimentResult> {
  return new Promise((resolve, reject) => {
    const worker = new SimulationWorker();
    const stop = () => {
      worker.terminate();
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    };
    if (opts.signal?.aborted) return stop();
    opts.signal?.addEventListener('abort', stop, { once: true });
    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      if (msg.type === 'progress') {
        opts.onProgress?.(msg.done, msg.total);
        return;
      }
      worker.terminate();
      opts.signal?.removeEventListener('abort', stop);
      if (msg.type === 'error') reject(new Error(msg.message));
      else resolve(msg.result);
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'The simulation stopped unexpectedly.'));
    };
    worker.postMessage({ model, recordLog: opts.recordLog, distances: opts.distances } satisfies WorkerRequest);
  });
}
