// The JSON model spec: the one contract every part of the app reads or writes.
// All times are in minutes unless a field name says otherwise.

export type Distribution =
  | { dist: 'fixed'; valueMin: number }
  | { dist: 'exponential'; meanMin: number }
  | { dist: 'normal'; meanMin: number; sdMin: number }
  | { dist: 'uniform'; min: number; max: number }
  | { dist: 'triangular'; min: number; mode: number; max: number };

/** Arrivals: a rate (Poisson or evenly spaced), or any inter-arrival distribution. */
export type Arrival =
  | { dist: 'exponential' | 'fixed'; ratePerHour: number }
  | Distribution;

export type Origin = 'user' | 'ai';

export type BlockType = 'source' | 'queue' | 'server' | 'resource' | 'delay' | 'decision' | 'sink';

interface BlockBase {
  id: string;
  type: BlockType;
  label: string;
  /** Position on the floor plan, in image pixels. */
  x: number;
  y: number;
  /** Footprint in meters. */
  w?: number;
  h?: number;
  rotation?: number;
  origin?: Origin;
}

export interface SourceBlock extends BlockBase {
  type: 'source';
  arrival: Arrival;
  groupSize?: number;
  maxArrivals?: number;
}

export interface QueueBlock extends BlockBase {
  type: 'queue';
  /** Max entities waiting; omitted = unlimited. Arrivals to a full queue are lost. */
  capacity?: number;
  discipline?: 'FIFO' | 'LIFO';
  /** Arriving entities leave (balk) when this many are already waiting. */
  balkThreshold?: number;
}

export interface ServerBlock extends BlockBase {
  type: 'server';
  servers: number;
  service: Distribution;
}

export interface ResourceBlock extends BlockBase {
  type: 'resource';
  count: number;
  speedMps?: number;
}

export interface DelayBlock extends BlockBase {
  type: 'delay';
  time: Distribution;
}

export interface DecisionBlock extends BlockBase {
  type: 'decision';
}

export interface SinkBlock extends BlockBase {
  type: 'sink';
}

export type Block =
  | SourceBlock
  | QueueBlock
  | ServerBlock
  | ResourceBlock
  | DelayBlock
  | DecisionBlock
  | SinkBlock;

export interface Link {
  from: string;
  to: string;
  /** Required on Decision outputs; they must sum to 1. */
  prob?: number;
}

export type Point = [number, number];

export interface Background {
  /** A file name, or the plan image itself as a data URL so a saved model is self-contained. */
  file: string;
  metersPerPixel: number;
  /** Plan size in image pixels. */
  width?: number;
  height?: number;
  /** False until the user sets the scale with two-point calibration. */
  calibrated?: boolean;
}

export interface RunSettings {
  hours: number;
  warmupMin: number;
  replications: number;
  seed: number;
}

export interface ModelSpec {
  version: string;
  entityLabel: string;
  background?: Background;
  /** Walls and obstacles as polylines, in image pixels. */
  walls?: Point[][];
  /** Walking speed for people, m/s. */
  travelSpeedMps?: number;
  blocks: Block[];
  links: Link[];
  run: RunSettings;
}

export const DEFAULT_TRAVEL_SPEED_MPS = 1.2;

/** Scale used until the plan is calibrated: 50 pixels per meter. */
export const DEFAULT_METERS_PER_PIXEL = 0.02;
