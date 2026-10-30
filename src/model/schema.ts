// JSON Schema for the model spec. Structure only; graph rules live in validate.ts.

const positive = { type: 'number', exclusiveMinimum: 0 };
const nonNegative = { type: 'number', minimum: 0 };

const distribution = {
  type: 'object',
  required: ['dist'],
  discriminator: { propertyName: 'dist' },
  oneOf: [
    { type: 'object', required: ['dist', 'valueMin'], additionalProperties: false,
      properties: { dist: { const: 'fixed' }, valueMin: nonNegative } },
    { type: 'object', required: ['dist', 'meanMin'], additionalProperties: false,
      properties: { dist: { const: 'exponential' }, meanMin: positive } },
    { type: 'object', required: ['dist', 'meanMin', 'sdMin'], additionalProperties: false,
      properties: { dist: { const: 'normal' }, meanMin: positive, sdMin: nonNegative } },
    { type: 'object', required: ['dist', 'min', 'max'], additionalProperties: false,
      properties: { dist: { const: 'uniform' }, min: nonNegative, max: nonNegative } },
    { type: 'object', required: ['dist', 'min', 'mode', 'max'], additionalProperties: false,
      properties: { dist: { const: 'triangular' }, min: nonNegative, mode: nonNegative, max: nonNegative } },
  ],
};

const arrival = {
  oneOf: [
    { type: 'object', required: ['dist', 'ratePerHour'], additionalProperties: false,
      properties: { dist: { enum: ['exponential', 'fixed'] }, ratePerHour: positive } },
    ...distribution.oneOf,
  ],
};

const base = {
  id: { type: 'string', minLength: 1 },
  label: { type: 'string' },
  x: { type: 'number' },
  y: { type: 'number' },
  w: positive,
  h: positive,
  rotation: { type: 'number' },
  origin: { enum: ['user', 'ai'] },
  needsInput: { type: 'array', items: { enum: ['arrival', 'servers', 'service', 'time', 'routing'] }, uniqueItems: true },
};

function block(type: string, extra: Record<string, unknown>, required: string[] = []) {
  return {
    type: 'object',
    required: ['id', 'type', 'label', 'x', 'y', ...required],
    additionalProperties: false,
    properties: { ...base, type: { const: type }, ...extra },
  };
}

const count = { type: 'integer', minimum: 1 };

export const modelSchema = {
  type: 'object',
  required: ['version', 'entityLabel', 'blocks', 'links', 'run'],
  additionalProperties: false,
  properties: {
    version: { type: 'string' },
    entityLabel: { type: 'string', minLength: 1 },
    background: {
      type: 'object', required: ['file', 'metersPerPixel'], additionalProperties: false,
      properties: {
        file: { type: 'string' },
        metersPerPixel: positive,
        width: positive,
        height: positive,
        calibrated: { type: 'boolean' },
      },
    },
    walls: {
      type: 'array',
      items: { type: 'array', items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } },
    },
    travelSpeedMps: positive,
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['type'],
        discriminator: { propertyName: 'type' },
        oneOf: [
          block('source', { arrival, groupSize: count, maxArrivals: count }, ['arrival']),
          block('queue', { capacity: count, discipline: { enum: ['FIFO', 'LIFO'] }, balkThreshold: count }),
          block('server', { servers: count, service: distribution }, ['servers', 'service']),
          block('resource', { count, speedMps: positive }, ['count']),
          block('delay', { time: distribution }, ['time']),
          block('decision', {}),
          block('sink', {}),
        ],
      },
    },
    links: {
      type: 'array',
      items: {
        type: 'object', required: ['from', 'to'], additionalProperties: false,
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          prob: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
    run: {
      type: 'object', required: ['hours', 'warmupMin', 'replications', 'seed'], additionalProperties: false,
      properties: {
        hours: positive,
        warmupMin: nonNegative,
        replications: { type: 'integer', minimum: 2, maximum: 1000 },
        seed: { type: 'integer' },
      },
    },
  },
} as const;
