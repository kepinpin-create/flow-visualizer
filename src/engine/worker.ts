/// <reference lib="webworker" />
// Runs experiments off the main thread so the UI stays responsive.
import { runExperiment, type ExperimentResult } from './experiment';
import type { ModelSpec } from '../model/types';

export type WorkerRequest = { model: ModelSpec; recordLog?: boolean };
export type WorkerResponse =
  | { type: 'progress'; done: number; total: number }
  | { type: 'result'; result: ExperimentResult }
  | { type: 'error'; message: string };

const post = (msg: WorkerResponse) => (self as DedicatedWorkerGlobalScope).postMessage(msg);

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  try {
    const result = runExperiment(ev.data.model, {
      recordLog: ev.data.recordLog,
      onProgress: (done, total) => post({ type: 'progress', done, total }),
    });
    post({ type: 'result', result });
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
