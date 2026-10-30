import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyChanges, parseDescribeReply, planChanges } from '../src/ai/describe';
import { applySuggestion, parseLayoutReply, type LayoutReply } from '../src/ai/layout';
import { AiError, callAi } from '../src/ai/providers';
import { validateModel } from '../src/model/validate';
import bank from '../src/templates/bank.json';
import { valid } from './helpers';

/** What a model might send back for a small bank plan. */
const bankReply: LayoutReply = {
  blocks: [
    { id: 'door', type: 'source', label: 'Main door', x: 100, y: 500, widthM: null, depthM: null, servers: null, arrivalsPerHour: null, minutes: null, capacity: null },
    { id: 'line', type: 'queue', label: 'Queue area', x: 400, y: 500, widthM: 6, depthM: 1.5, servers: null, arrivalsPerHour: null, minutes: null, capacity: null },
    { id: 'tellers', type: 'server', label: 'Teller 1-3', x: 700, y: 500, widthM: null, depthM: null, servers: 3, arrivalsPerHour: null, minutes: null, capacity: null },
    { id: 'split', type: 'decision', label: 'Loan or leave', x: 800, y: 500, widthM: null, depthM: null, servers: null, arrivalsPerHour: null, minutes: null, capacity: null },
    { id: 'loans', type: 'delay', label: 'Loan desk', x: 850, y: 250, widthM: null, depthM: null, servers: null, arrivalsPerHour: null, minutes: null, capacity: null },
    { id: 'exit', type: 'sink', label: 'Exit', x: 950, y: 500, widthM: null, depthM: null, servers: null, arrivalsPerHour: null, minutes: null, capacity: null },
  ],
  links: [
    { from: 'door', to: 'line', probability: null },
    { from: 'line', to: 'tellers', probability: null },
    { from: 'tellers', to: 'split', probability: null },
    { from: 'split', to: 'exit', probability: null },
    { from: 'split', to: 'loans', probability: null },
    { from: 'loans', to: 'exit', probability: null },
    { from: 'line', to: 'exit', probability: null }, // not allowed: a queue only feeds its server
    { from: 'ghost', to: 'exit', probability: null }, // unknown block
  ],
  notes: 'Arrival rate and service times are not shown on the plan.',
};

const plan = { width: 2000, height: 1000 };
// An empty plan is a well-formed model that simply cannot run yet.
const empty = validateModel({ ...bank, blocks: [], links: [] }).model!;

describe('Suggest layout: turning an AI reply into a model', () => {
  const applied = applySuggestion(empty, parseLayoutReply(JSON.stringify(bankReply)), plan, 'replace');

  it('places blocks on the plan from the 0-1000 grid and marks them AI-detected', () => {
    const door = applied.model.blocks.find((b) => b.id === 'door')!;
    expect([door.x, door.y]).toEqual([200, 500]);
    expect(applied.model.blocks.every((b) => b.origin === 'ai')).toBe(true);
  });

  it('uses numbers the plan shows and flags the ones it does not', () => {
    const tellers = applied.model.blocks.find((b) => b.id === 'tellers')!;
    expect(tellers.type === 'server' && tellers.servers).toBe(3);
    expect(tellers.needsInput).toEqual(['service']);
    expect(applied.model.blocks.find((b) => b.id === 'door')!.needsInput).toEqual(['arrival']);
    expect(applied.model.blocks.find((b) => b.id === 'line')!.w).toBe(6);
  });

  it('drops links the editor would refuse, and says why', () => {
    expect(applied.addedLinks).toBe(6);
    expect(applied.dropped).toHaveLength(2);
    expect(applied.dropped.join('\n')).toMatch(/only link to a Server/);
    expect(applied.dropped.join('\n')).toMatch(/did not create/);
  });

  it('splits a decision evenly when the AI gave no probabilities, and flags it', () => {
    const outs = applied.model.links.filter((l) => l.from === 'split').map((l) => l.prob);
    expect(outs).toEqual([0.5, 0.5]);
    expect(applied.model.blocks.find((b) => b.id === 'split')!.needsInput).toEqual(['routing']);
  });

  it('blocks the run until the flagged numbers are checked', () => {
    const v = validateModel(applied.model);
    expect(v.ok).toBe(false);
    expect(v.errors.filter((e) => /AI could not read/.test(e.message))).toHaveLength(4);
  });

  it('keeps existing blocks in add mode and avoids id clashes', () => {
    const withBank = valid(bank);
    const added = applySuggestion(withBank, { ...bankReply, blocks: [{ ...bankReply.blocks[5], id: 'exit' }], links: [] }, plan, 'add');
    expect(added.model.blocks.map((b) => b.id)).toEqual(['entrance', 'waiting', 'tellers', 'exit', 'exit_2']);
  });

  it('rejects a reply that does not match the schema', () => {
    expect(() => parseLayoutReply('{"blocks": []}')).toThrow(/expected format/);
    expect(() => parseLayoutReply('not json')).toThrow(/not valid JSON/);
  });
});

describe('Fill from description', () => {
  const start = applySuggestion(empty, bankReply, plan, 'replace').model;
  const reply = parseDescribeReply(JSON.stringify({
    updates: [
      { blockId: 'door', field: 'arrivalsPerHour', value: 30, toBlockId: null, evidence: 'about 30 customers an hour' },
      { blockId: 'tellers', field: 'serviceMinutes', value: 4, toBlockId: null, evidence: 'about 4 minutes each' },
      { blockId: 'split', field: 'probability', value: 0.2, toBlockId: 'loans', evidence: '1 in 5 goes to the loan desk' },
      { blockId: 'split', field: 'probability', value: 0.8, toBlockId: 'exit', evidence: 'the rest leave' },
      { blockId: 'loans', field: 'delayMinutes', value: 15, toBlockId: null, evidence: 'loans take 15 minutes' },
      { blockId: 'exit', field: 'servers', value: 2, toBlockId: null, evidence: 'two doors' },
    ],
    unmatched: '',
  }));
  const changes = planChanges(start, reply);

  it('words each change and refuses ones that do not fit the block', () => {
    expect(changes[0].summary).toBe('Main door: arrivals → 30/h (replaces the placeholder)');
    expect(changes[1].summary).toBe('Teller 1-3: mean service → 4 min (replaces the placeholder)');
    expect(changes[5].problem).toMatch(/is a sink, not a server/);
  });

  it('applies the changes and clears the flags, so the model can run', () => {
    const m = JSON.parse(JSON.stringify(start));
    applyChanges(m, changes);
    const tellers = m.blocks.find((b: { id: string }) => b.id === 'tellers');
    expect(tellers.service).toEqual({ dist: 'exponential', meanMin: 4 });
    expect(m.blocks.some((b: { needsInput?: unknown }) => b.needsInput)).toBe(false);
    expect(validateModel(m).ok).toBe(true);
  });
});

describe('providers', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends a Chat Completions request with the image and a strict JSON schema to Meta', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] })));
    vi.stubGlobal('fetch', fetchMock);
    const text = await callAi(
      { provider: 'meta', apiKey: 'k', model: 'muse-spark-1.3', baseUrl: 'https://api.meta.ai/v1' },
      { system: 'sys', text: 'hi', imageDataUrl: 'data:image/jpeg;base64,AAA', schemaName: 'x', schema: { type: 'object' } },
    );
    expect(text).toBe('{"ok":true}');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.meta.ai/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('muse-spark-1.3');
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'x', strict: true, schema: { type: 'object' } } });
    expect(body.messages[1].content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAA' } });
  });

  it('turns a rejected key into a plain message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"Unauthorized"}}', { status: 401 })));
    await expect(callAi(
      { provider: 'meta', apiKey: 'bad', model: 'muse-spark-1.3', baseUrl: 'https://api.meta.ai/v1' },
      { system: '', text: '', schemaName: 'x', schema: {} },
    )).rejects.toThrow(AiError);
  });

  it('asks for a key before calling anything', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(callAi({ provider: 'meta', apiKey: ' ', model: 'm', baseUrl: 'u' }, { system: '', text: '', schemaName: 'x', schema: {} }))
      .rejects.toThrow(/API key/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
