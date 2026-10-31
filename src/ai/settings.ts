// AI settings live only in this browser. The key is kept in memory for the tab unless
// the user ticks "remember", which stores it in localStorage on this device.
import { PROVIDERS, type AiSettings, type ProviderId } from './providers';

const SETTINGS_KEY = 'flow-visualizer.ai';
const keyName = (p: ProviderId) => `flow-visualizer.ai.key.${p}`;

interface Stored {
  provider: ProviderId;
  models: Partial<Record<ProviderId, string>>;
  baseUrls: Partial<Record<ProviderId, string>>;
  remember: boolean;
}

const sessionKeys: Partial<Record<ProviderId, string>> = {};

function read(): Stored {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Stored | null;
    if (s && s.provider in PROVIDERS) {
      return { provider: s.provider, models: s.models ?? {}, baseUrls: s.baseUrls ?? {}, remember: !!s.remember };
    }
  } catch {
    // Storage blocked or corrupt: fall back to defaults.
  }
  return { provider: 'meta', models: {}, baseUrls: {}, remember: false };
}

export function loadSettings(provider?: ProviderId): AiSettings & { remember: boolean } {
  const s = read();
  const p = provider ?? s.provider;
  let apiKey = sessionKeys[p] ?? '';
  if (!apiKey) {
    try {
      apiKey = localStorage.getItem(keyName(p)) ?? '';
    } catch {
      // ignore
    }
  }
  return {
    provider: p,
    apiKey,
    model: s.models[p] || PROVIDERS[p].defaultModel,
    baseUrl: s.baseUrls[p] || PROVIDERS[p].defaultBaseUrl,
    remember: s.remember,
  };
}

export function saveSettings(next: AiSettings & { remember: boolean }) {
  const s = read();
  s.provider = next.provider;
  s.models[next.provider] = next.model.trim();
  s.baseUrls[next.provider] = next.baseUrl.trim();
  s.remember = next.remember;
  sessionKeys[next.provider] = next.apiKey.trim();
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    if (next.remember && next.apiKey.trim()) localStorage.setItem(keyName(next.provider), next.apiKey.trim());
    else localStorage.removeItem(keyName(next.provider));
  } catch {
    // Without storage the settings still last for this tab.
  }
}

/** Removes every stored key from this device. */
export function forgetKeys() {
  for (const p of Object.keys(PROVIDERS) as ProviderId[]) {
    delete sessionKeys[p];
    try {
      localStorage.removeItem(keyName(p));
    } catch {
      // ignore
    }
  }
}
