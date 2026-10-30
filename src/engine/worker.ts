/// <reference lib="webworker" />
// Runs experiments off the main thread so the UI stays responsive.
import { runExperiment, type ExperimentResult } from './experiment';
import { straightLineDistance } from './simulator';
import type { ModelSpec } from '../model/types';

export type WorkerRequest = {
  model: ModelSpec;
  recordLog?: boolean;
  /** Walking distance in meters per link, keyed "from>to"; links not listed use a straight line. */
  distances?: Record<string, number>;
};
export type WorkerResponse =
  | { type: 'progress'; done: number; total: number }
  | { type: 'result'; result: ExperimentResult }
  | { type: 'error'; message: string };

const post = (msg: WorkerResponse) => (self as DedicatedWorkerGlobalScope).postMessage(msg);

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const { model, recordLog, distances } = ev.data;
  try {
    const straight = straightLineDistance(model);
    const result = runExperiment(model, {
      recordLog,
      distance: distances ? (a, b) => distances[`${a}>${b}`] ?? straight(a, b) : undefined,
      onProgress: (done, total) => post({ type: 'progress', done, total }),
    });
    post({ type: 'result', result });
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
