// API keys live in SecureStore (never in code). The device voice pipeline
// reads them per request: Groq = STT + fast classify/answer, hcnsec-style
// OPENAI_BASE_URL proxy = quality answers, Gemini = fallback.

import * as SecureStore from "expo-secure-store";

export interface ApiKeys {
  groqKey: string;
  openaiKey: string;
  openaiBase: string;
  openaiModel: string;
  geminiKey: string;
}

const DEFAULTS: ApiKeys = {
  groqKey: "",
  openaiKey: "",
  openaiBase: "https://api.hcnsec.cn/v1",
  openaiModel: "DeepSeek-V4-Flash",
  geminiKey: "",
};

export async function loadKeys(): Promise<ApiKeys> {
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS) as (keyof ApiKeys)[]) {
    try {
      const v = await SecureStore.getItemAsync(`sb.key.${k}`);
      if (v !== null) out[k] = v;
    } catch {
      // SecureStore unavailable (e.g. web preview) — fall back to defaults
    }
  }
  return out;
}

export async function saveKeys(keys: ApiKeys): Promise<void> {
  for (const k of Object.keys(keys) as (keyof ApiKeys)[]) {
    try {
      await SecureStore.setItemAsync(`sb.key.${k}`, keys[k]);
    } catch {
      // ignore on platforms without secure storage
    }
  }
}
