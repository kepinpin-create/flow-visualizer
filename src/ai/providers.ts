// Bring-your-own-key AI providers. Calls go straight from the browser to the provider;
// the key never touches any server of ours (there is none).
// Type-only import: the SDK itself is loaded on demand in callAnthropic.
import type Anthropic from '@anthropic-ai/sdk';

export type ProviderId = 'meta' | 'anthropic' | 'openai-compatible';

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  defaultModel: string;
  defaultBaseUrl: string;
  keyUrl: string;
  keyHint: string;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  meta: {
    id: 'meta',
    name: 'Meta Model API (Muse)',
    // Meta's recommended default; reads images and supports JSON-schema output.
    defaultModel: 'muse-spark-1.3',
    defaultBaseUrl: 'https://api.meta.ai/v1',
    keyUrl: 'https://dev.meta.ai/',
    keyHint: 'Create a key at dev.meta.ai.',
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic Claude',
    defaultModel: 'claude-opus-5-5',
    defaultBaseUrl: 'https://api.anthropic.com',
    keyUrl: 'https://platform.claude.com/',
    keyHint: 'Create a key at platform.claude.com.',
  },
  'openai-compatible': {
    id: 'openai-compatible',
    name: 'Other (OpenAI-compatible)',
    defaultModel: '',
    defaultBaseUrl: 'https://api.openai.com/v1',
    keyUrl: '',
    keyHint: 'OpenAI, Gemini, OpenRouter, or a local Ollama / llama.cpp server. The model must read images and return JSON.',
  },
};

export interface AiSettings {
  provider: ProviderId;
  apiKey: string;
  model: string;
  baseUrl: string;
}

export interface AiRequest {
  system: string;
  text: string;
  /** A data URL (JPEG/PNG) to send along, e.g. the floor plan. */
  imageDataUrl?: string;
  schemaName: string;
  schema: Record<string, unknown>;
  signal?: AbortSignal;
}

/** An error worded for the person using the app. */
export class AiError extends Error {}

function friendly(status: number, detail: string, provider: string): AiError {
  if (status === 401 || status === 403) return new AiError(`${provider} rejected the API key. Check it in AI settings.`);
  if (status === 404) return new AiError(`${provider} does not know that model or address. Check the model name and base URL in AI settings.`);
  if (status === 429) return new AiError(`${provider} is rate-limiting this key or it is out of credit. Wait a moment and try again.`);
  if (status >= 500) return new AiError(`${provider} had a server problem (${status}). Try again in a minute.`);
  return new AiError(`${provider} returned an error (${status}): ${detail}`);
}

/** OpenAI-style Chat Completions with a strict JSON-schema reply (Meta Model API and compatible servers). */
async function callChatCompletions(s: AiSettings, req: AiRequest, label: string): Promise<string> {
  const content: unknown[] = [{ type: 'text', text: req.text }];
  if (req.imageDataUrl) content.push({ type: 'image_url', image_url: { url: req.imageDataUrl } });
  let res: Response;
  try {
    res = await fetch(`${s.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.apiKey}` },
      body: JSON.stringify({
        model: s.model,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content },
        ],
        response_format: { type: 'json_schema', json_schema: { name: req.schemaName, strict: true, schema: req.schema } },
      }),
      signal: req.signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new AiError(`Could not reach ${label}. Check your internet connection and the base URL. A server that blocks browser requests (CORS) also shows up this way.`);
  }
  const body = await res.text();
  if (!res.ok) {
    let detail = body.slice(0, 300);
    try {
      detail = JSON.parse(body).error?.message ?? detail;
    } catch {
      // keep the raw text
    }
    throw friendly(res.status, detail, label);
  }
  const data = JSON.parse(body);
  const choice = data.choices?.[0];
  if (choice?.finish_reason === 'length') throw new AiError(`${label} stopped before finishing its answer. Try a smaller plan image.`);
  const text = choice?.message?.content;
  if (typeof text !== 'string' || !text.trim()) {
    throw new AiError(choice?.message?.refusal ? `${label} declined: ${choice.message.refusal}` : `${label} sent an empty answer.`);
  }
  return text;
}

/** Claude through the official SDK, in the browser with the user's own key. */
async function callAnthropic(s: AiSettings, req: AiRequest): Promise<string> {
  // Loaded on demand so the SDK only downloads for people who pick Claude.
  const { default: AnthropicSdk } = await import('@anthropic-ai/sdk');
  const client = new AnthropicSdk({
    apiKey: s.apiKey,
    baseURL: s.baseUrl || undefined,
    // The key is the user's own and stays in their browser; there is no server to hide it on.
    dangerouslyAllowBrowser: true,
  });
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (req.imageDataUrl) {
    const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.*)$/.exec(req.imageDataUrl);
    if (!m) throw new AiError('The plan image could not be prepared for Claude.');
    content.push({ type: 'image', source: { type: 'base64', media_type: m[1] as 'image/png', data: m[2] } });
  }
  content.push({ type: 'text', text: req.text });
  try {
    const response = await client.beta.messages.create(
      {
        model: s.model,
        max_tokens: 16000,
        system: req.system,
        messages: [{ role: 'user', content }],
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: req.schema } },
        // If a safety classifier declines, the API retries on a fallback model in the same call.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      },
      { signal: req.signal },
    );
    if (response.stop_reason === 'refusal') {
      throw new AiError(`Claude declined this request${response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : '.'}`);
    }
    if (response.stop_reason === 'max_tokens') throw new AiError('Claude stopped before finishing its answer. Try a smaller plan image.');
    const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    if (!text.trim()) throw new AiError('Claude sent an empty answer.');
    return text;
  } catch (e) {
    if (e instanceof AiError) throw e;
    if (e instanceof AnthropicSdk.APIUserAbortError) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    if (e instanceof AnthropicSdk.APIConnectionError) throw new AiError('Could not reach Anthropic. Check your internet connection.');
    if (e instanceof AnthropicSdk.APIError && e.status) throw friendly(e.status, e.message, 'Anthropic');
    throw e;
  }
}

/** Sends one request and returns the model's JSON reply as text. */
export async function callAi(s: AiSettings, req: AiRequest): Promise<string> {
  if (!s.apiKey.trim()) throw new AiError('Add your API key in AI settings first.');
  if (!s.model.trim()) throw new AiError('Choose a model in AI settings first.');
  switch (s.provider) {
    case 'meta':
      return callChatCompletions(s, req, 'Meta');
    case 'openai-compatible':
      return callChatCompletions(s, req, 'The AI service');
    case 'anthropic':
      return callAnthropic(s, req);
  }
}

/** Cheap check that the key and address work: lists models without generating anything. */
export async function testConnection(s: AiSettings): Promise<string> {
  if (!s.apiKey.trim()) throw new AiError('Enter an API key to test.');
  if (s.provider === 'anthropic') {
    const { default: AnthropicSdk } = await import('@anthropic-ai/sdk');
    const client = new AnthropicSdk({ apiKey: s.apiKey, baseURL: s.baseUrl || undefined, dangerouslyAllowBrowser: true });
    try {
      await client.models.retrieve(s.model);
      return `Connected. ${s.model} is available.`;
    } catch (e) {
      if (e instanceof AnthropicSdk.APIConnectionError) throw new AiError('Could not reach Anthropic.');
      if (e instanceof AnthropicSdk.APIError && e.status) throw friendly(e.status, e.message, 'Anthropic');
      throw e;
    }
  }
  const label = s.provider === 'meta' ? 'Meta' : 'The AI service';
  let res: Response;
  try {
    res = await fetch(`${s.baseUrl.replace(/\/+$/, '')}/models`, { headers: { Authorization: `Bearer ${s.apiKey}` } });
  } catch {
    throw new AiError(`Could not reach ${label}. Check the base URL; a server that blocks browser requests (CORS) also shows up this way.`);
  }
  if (!res.ok) throw friendly(res.status, (await res.text()).slice(0, 200), label);
  const ids: string[] = ((await res.json()).data ?? []).map((m: { id: string }) => m.id);
  if (s.model && ids.length && !ids.includes(s.model)) {
    return `Connected, but "${s.model}" is not in this key's model list. Available: ${ids.slice(0, 8).join(', ')}${ids.length > 8 ? '…' : ''}`;
  }
  return `Connected.${s.model ? ` ${s.model} is available.` : ''}`;
}
