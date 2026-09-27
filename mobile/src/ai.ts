// Voice AI pipeline ported from the website (src/lib/ai.ts) to React Native.
// Same strategy: Groq Whisper STT -> fast rule-based intents -> LLM classify
// (Groq-first) -> short (<=20 word) answers for the 128x64 OLED.
// All provider calls use plain fetch (no Node-only SDKs). Audio arrives as
// Uint8Array from the phone's HTTP server; base64/multipart via Buffer.

import { Buffer } from "buffer";
import type { ApiKeys } from "./keys";
import { fetchWithTimeout, postJson } from "./net";
import {
  listTasks,
  listNotes,
  listVoice,
  getActiveDevice,
} from "./db";

export interface IntentOutput {
  transcript: string;
  intent:
    | "CREATE_TODO" | "CREATE_NOTE" | "QUERY_WEATHER" | "QUERY_CLOCK"
    | "QUERY_TASKS" | "QUERY_NOTES" | "GENERAL_AI" | "NAVIGATION";
  extractedData: {
    todoTitle?: string;
    todoPriority?: "low" | "medium" | "high";
    todoDueDate?: string;
    noteTitle?: string;
    noteContent?: string;
    noteTags?: string;
    weatherQuery?: string;
    generalPrompt?: string;
    navigationTarget?:
      | "todo" | "notes" | "weather" | "clock"
      | "ai" | "history" | "settings" | "overview";
  };
}

export class NoSpeechError extends Error {
  constructor(message = "No speech detected in audio") {
    super(message);
    this.name = "NoSpeechError";
  }
}

export class TranscriptionError extends Error {
  constructor(message = "Speech-to-text unavailable") {
    super(message);
    this.name = "TranscriptionError";
  }
}

const SYSTEM_INSTRUCTION = `
You are the AI engine for "Second Brain", a wearable companion.
You will process the user's spoken audio transcription and classify their intent.
Provide a clean JSON output matching this structure:
{
  "transcript": "what the user said",
  "intent": "CREATE_TODO" | "CREATE_NOTE" | "QUERY_WEATHER" | "QUERY_CLOCK" | "QUERY_TASKS" | "QUERY_NOTES" | "GENERAL_AI" | "NAVIGATION",
  "extractedData": {
    "todoTitle": "Title of the task",
    "todoPriority": "low" | "medium" | "high",
    "todoDueDate": "YYYY-MM-DD or time representation if mentioned",
    "noteTitle": "Title for the note",
    "noteContent": "Detailed note content",
    "noteTags": "comma,separated,tags",
    "weatherQuery": "location or tomorrow/today query",
    "generalPrompt": "the question for general AI",
    "navigationTarget": "todo" | "notes" | "weather" | "clock" | "ai" | "history" | "settings" | "overview"
  }
}

Language rule (IMPORTANT):
- Write ALL output fields in English, even if the model defaults to another language.
- Transcribe/keep the user's words as-is, but titles, note content, and answers must be English.

Navigation targets map to the dashboard sections:
- "todo" = Tasks queue, "notes" = Memory Bank notes, "weather" = weather,
- "clock" = clock, "ai" = AI Chat Link, "history" = Voice Index/history log,
- "settings" = device settings, "overview" = dashboard overview.

Guidelines:
- If they want to add a task, to-do, reminder, or item to buy, set intent to CREATE_TODO.
- If they want to remember something, write down a note, or save information, set intent to CREATE_NOTE.
- If they ask about the weather, set intent to QUERY_WEATHER.
- If they ask about time or clock, set intent to QUERY_CLOCK.
- If they ask to list/read/recap their tasks or to-do list, set intent to QUERY_TASKS.
- If they ask to list/read/recap their notes or memory, set intent to QUERY_NOTES.
- If they want to navigate/open a section (tasks, notes, weather, clock, AI chat, voice history/index, settings, overview/dashboard), set intent to NAVIGATION.
- For general questions/queries (e.g. "how does a transistor work"), set intent to GENERAL_AI.
- Keep "generalPrompt" to the user's core question in one short sentence.
- Output ONLY valid JSON. No markdown backticks. All text in English.
`;

export const DEVICE_IDENTITY =
  "You are Second Brain, a wearable ESP32 voice companion. You can: create tasks, save notes, report weather, tell time, list tasks and notes, and chat.";

export const OLED_SHORT_INSTRUCTION =
  "Reply in at most 20 words. Plain short phrases, no markdown, no lists. English only.";

export function capWords(text: string, maxWords = 20): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length > maxWords ? words.slice(0, maxWords).join(" ") : words.join(" ");
}

// ---------------------------------------------------------------------------
// WAV silence gate (16-bit mono PCM, 16kHz from the ESP32)
// ---------------------------------------------------------------------------

export interface AudioAnalysis {
  durationSec: number;
  rms: number;
  peak: number;
  nonSilentRatio: number;
  isSilent: boolean;
  reason?: string;
}

function readI16LE(u8: Uint8Array, off: number): number {
  const v = u8[off] | (u8[off + 1] << 8);
  return v >= 0x8000 ? v - 0x10000 : v;
}

export function analyzeWavBytes(audio: Uint8Array): AudioAnalysis {
  let dataStart = 44;
  let sampleRate = 16000;
  let bitsPerSample = 16;
  try {
    const ascii = (a: number, b: number) =>
      String.fromCharCode(...audio.subarray(a, b));
    if (audio.length > 44 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") {
      let offset = 12;
      const dv = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
      while (offset + 8 <= audio.length) {
        const chunkId = ascii(offset, offset + 4);
        const chunkSize = dv.getUint32(offset + 4, true);
        if (chunkId === "fmt " && chunkSize >= 16) {
          sampleRate = dv.getUint32(offset + 12, true);
          bitsPerSample = dv.getUint16(offset + 22, true);
        }
        if (chunkId === "data") {
          dataStart = offset + 8;
          break;
        }
        offset += 8 + chunkSize;
        if (offset > 512) break;
      }
    }
  } catch {
    // fall through to defaults
  }
  const pcmStart = Math.min(dataStart, audio.length);
  const bytesPerSample = Math.max(1, Math.floor(bitsPerSample / 8));
  const sampleCount = Math.floor((audio.length - pcmStart) / bytesPerSample);
  if (sampleCount < sampleRate * 0.4) {
    return {
      durationSec: sampleCount / Math.max(1, sampleRate),
      rms: 0, peak: 0, nonSilentRatio: 0, isSilent: true,
      reason: "audio too short (<0.4s of samples)",
    };
  }
  let sumSq = 0;
  let peak = 0;
  let nonSilent = 0;
  const step = Math.max(1, Math.floor(sampleCount / 8000));
  let evaluated = 0;
  for (let i = 0; i < sampleCount; i += step) {
    let s = 0;
    if (bytesPerSample >= 2) {
      s = readI16LE(audio, pcmStart + i * bytesPerSample);
    } else {
      s = (audio[pcmStart + i] - 128) * 256;
    }
    const abs = Math.abs(s);
    if (abs > peak) peak = abs;
    sumSq += s * s;
    if (abs > 500) nonSilent++;
    evaluated++;
  }
  const trueRms = Math.sqrt(sumSq / Math.max(1, evaluated));
  const nonSilentRatio = nonSilent / Math.max(1, evaluated);
  const durationSec = sampleCount / Math.max(1, sampleRate);
  const isSilent =
    trueRms < 150 || peak < 800 || nonSilentRatio < 0.02 || durationSec < 0.5;
  return {
    durationSec, rms: Math.round(trueRms), peak, nonSilentRatio, isSilent,
    reason: isSilent
      ? `rms=${Math.round(trueRms)} peak=${peak} voiced=${(nonSilentRatio * 100).toFixed(1)}% dur=${durationSec.toFixed(2)}s`
      : undefined,
  };
}

const HALLUCINATION_DENYLIST = new Set([
  "you", "thank you", "thanks", "thank you for watching",
  "thanks for watching", "thanks for watching this video", "subtitles",
]);

export function assertRealSpeech(transcript: string, source: string): string {
  const text = (transcript || "").trim();
  const normalized = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    throw new NoSpeechError(`${source} returned only punctuation/empty text`);
  }
  if (HALLUCINATION_DENYLIST.has(normalized)) {
    throw new NoSpeechError(`${source} hallucinated "${text}" (no intelligible speech)`);
  }
  const words = normalized.split(" ");
  if (words.length >= 4 && words.every((w) => w === words[0])) {
    throw new NoSpeechError(`${source} hallucinated repeated word "${words[0]}"`);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Transcription providers
// ---------------------------------------------------------------------------

function buildMultipart(
  fileBytes: Uint8Array,
  fields: Record<string, string>
): { body: Blob; contentType: string } {
  const boundary = "----secondbrain" + Date.now().toString(36) + Math.random().toString(36).slice(2);
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const push = (u8: Uint8Array) => parts.push(u8);
  for (const [k, v] of Object.entries(fields)) {
    push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="speech.wav"\r\nContent-Type: audio/wav\r\n\r\n`));
  push(new Uint8Array(fileBytes.buffer, fileBytes.byteOffset, fileBytes.byteLength));
  push(enc.encode(`\r\n--${boundary}--\r\n`));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  const contentType = `multipart/form-data; boundary=${boundary}`;
  return { body: new Blob([out as BlobPart], { type: contentType }), contentType };
}

async function transcribeWithGroq(audio: Uint8Array, keys: ApiKeys): Promise<string> {
  if (!keys.groqKey) throw new Error("GROQ_API_KEY not configured");
  const { body, contentType } = buildMultipart(audio, {
    model: "whisper-large-v3-turbo",
    language: "en",
    response_format: "json",
  });
  try {
    const res = await fetchWithTimeout(
      "https://api.groq.com/openai/v1/audio/transcriptions",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${keys.groqKey}`, "Content-Type": contentType },
        body,
      },
      15000
    );
    if (!res.ok) throw new Error(`Groq STT status ${res.status}`);
    const json = await res.json();
    const text = ((json.text as string) || "").trim();
    if (text) return text;
    throw new Error("Groq model whisper-large-v3-turbo returned empty transcript");
  } catch (e) {
    console.warn("Groq STT failed:", (e as Error)?.message || e);
    throw e instanceof Error ? e : new Error(String(e));
  }
}

async function transcribeWithGemini(audio: Uint8Array, keys: ApiKeys): Promise<string> {
  if (!keys.geminiKey) throw new Error("GEMINI_API_KEY not configured");
  const b64 = Buffer.from(audio).toString("base64");
  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(keys.geminiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { inline_data: { mime_type: "audio/wav", data: b64 } },
              { text: "Transcribe this audio exactly. If there is no intelligible speech, respond with exactly: NO_SPEECH. Otherwise respond with ONLY the transcription text, no commentary." },
            ],
          },
        ],
      }),
    },
    20000
  );
  if (!res.ok) throw new Error(`Gemini STT status ${res.status}`);
  const json = await res.json();
  const text = (json.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("") || "").trim();
  if (!text || text === "NO_SPEECH") {
    throw new NoSpeechError("Gemini detected no intelligible speech");
  }
  return text;
}

async function transcribeWithOpenAICompatible(
  audio: Uint8Array,
  keys: ApiKeys
): Promise<string> {
  if (!keys.openaiKey) throw new Error("OPENAI_API_KEY not configured");
  const base = (keys.openaiBase || "https://api.openai.com/v1").replace(/\/+$/, "");
  const { body, contentType } = buildMultipart(audio, { model: "whisper-1" });
  try {
    const res = await fetchWithTimeout(
      `${base}/audio/transcriptions`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${keys.openaiKey}`, "Content-Type": contentType },
        body,
      },
      15000
    );
    if (!res.ok) throw new Error(`OpenAI-compatible STT status ${res.status}`);
    const json = await res.json();
    const text = ((json.text as string) || "").trim();
    if (text) return text;
    throw new Error("Model whisper-1 returned empty transcript");
  } catch (e) {
    console.warn("OpenAI-compatible STT failed:", (e as Error)?.message || e);
    throw e instanceof Error ? e : new Error(String(e));
  }
}

// ---------------------------------------------------------------------------
// Intent classification
// ---------------------------------------------------------------------------

async function chatCompletions(
  base: string,
  apiKey: string,
  model: string,
  system: string,
  user: string,
  opts?: { maxTokens?: number; jsonMode?: boolean }
): Promise<string | null> {
  const cleanBase = base.replace(/\/+$/, "");
  try {
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    };
    if (opts?.maxTokens) body.max_tokens = opts.maxTokens;
    if (opts?.jsonMode) body.response_format = { type: "json_object" };
    const { ok, json } = await postJson(
      `${cleanBase}/chat/completions`,
      { Authorization: `Bearer ${apiKey}` },
      body,
      20000
    );
    if (!ok) {
      console.warn(`chatCompletions ${model} status != 200`);
      return null;
    }
    const text = (json.choices?.[0]?.message?.content || "").trim();
    return text || null;
  } catch (e) {
    console.warn(`chatCompletions ${model} failed:`, (e as Error)?.message || e);
    return null;
  }
}

async function classifyIntent(transcript: string, keys: ApiKeys): Promise<IntentOutput> {
  // Fast path: obvious read-only commands skip the LLM entirely. CREATE_*
  // still goes through the LLM so stray keywords can't auto-create junk.
  const quick = ruleBasedIntent(transcript);
  if (
    quick.intent === "QUERY_CLOCK" ||
    quick.intent === "QUERY_TASKS" ||
    quick.intent === "QUERY_NOTES" ||
    quick.intent === "QUERY_WEATHER" ||
    quick.intent === "NAVIGATION"
  ) {
    return quick;
  }

  // Groq first (~seconds), proxy second, Gemini last.
  if (keys.groqKey) {
    try {
      const text = await chatCompletions(
        "https://api.groq.com/openai/v1",
        keys.groqKey,
        "openai/gpt-oss-20b",
        SYSTEM_INSTRUCTION,
        `Process this transcript: "${transcript}"`,
        { jsonMode: true }
      );
      if (text) {
        const parsed = JSON.parse(text) as IntentOutput;
        parsed.transcript = transcript;
        return parsed;
      }
    } catch (e) {
      console.warn("Groq classification error:", (e as Error)?.message || e);
    }
  }

  if (keys.openaiKey) {
    try {
      const text = await chatCompletions(
        keys.openaiBase || "https://api.hcnsec.cn/v1",
        keys.openaiKey,
        keys.openaiModel && keys.openaiModel !== "gpt-4o-mini"
          ? keys.openaiModel
          : "DeepSeek-V4-Flash",
        SYSTEM_INSTRUCTION,
        `Process this transcript: "${transcript}"`
      );
      if (text) {
        const sanitized = text.replace(/```json\s*/g, "").replace(/```\s*$/g, "").trim();
        const parsed = JSON.parse(sanitized) as IntentOutput;
        parsed.transcript = transcript;
        return parsed;
      }
    } catch (e) {
      console.warn("OpenAI classification error:", (e as Error)?.message || e);
    }
  }

  if (keys.geminiKey) {
    try {
      const res = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(keys.geminiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: SYSTEM_INSTRUCTION + `\nProcess this transcript: "${transcript}"` }] }],
            generationConfig: { responseMimeType: "application/json" },
          }),
        },
        20000
      );
      if (res.ok) {
        const json = await res.json();
        const text = (json.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("") || "").trim();
        if (text) {
          const parsed = JSON.parse(text) as IntentOutput;
          parsed.transcript = transcript;
          return parsed;
        }
      }
    } catch (e) {
      console.warn("Gemini classification error:", (e as Error)?.message || e);
    }
  }

  return ruleBasedIntent(transcript);
}

export function ruleBasedIntent(transcript: string): IntentOutput {
  const lower = transcript.toLowerCase();
  if (/(list|show|read|recap|what are|how many).*?(task|todo|to-do|reminder)/.test(lower) || /(my tasks|my todos|my reminders)/.test(lower)) {
    return { transcript, intent: "QUERY_TASKS", extractedData: {} };
  }
  if (/(list|show|read|recap|what).*?(note|memory|memories)/.test(lower) || /(my notes)/.test(lower)) {
    return { transcript, intent: "QUERY_NOTES", extractedData: {} };
  }
  if (/(task|todo|to-do|remind|buy|shopping)/.test(lower)) {
    return {
      transcript,
      intent: "CREATE_TODO",
      extractedData: {
        todoTitle: transcript
          .replace(/^(please\s+)?(add|create|remind me to|buy)\s+/i, "")
          .replace(/\s*(to my|on my).*/i, "")
          .trim() || transcript,
        todoPriority: /urgent|asap|important|high/.test(lower) ? "high" : "medium",
        todoDueDate: lower.includes("tomorrow") ? "tomorrow" : lower.includes("today") ? "today" : undefined,
      },
    };
  }
  if (/(remember|note|save|write down)/.test(lower)) {
    return {
      transcript,
      intent: "CREATE_NOTE",
      extractedData: {
        noteTitle: "Voice Note",
        noteContent: transcript,
        noteTags: "voice",
      },
    };
  }
  if (lower.includes("weather")) {
    return { transcript, intent: "QUERY_WEATHER", extractedData: { weatherQuery: transcript } };
  }
  if (/(time|clock|date|day is)/.test(lower)) {
    return { transcript, intent: "QUERY_CLOCK", extractedData: {} };
  }
  if (/(open|navigate|go to|show)/.test(lower)) {
    let target: NonNullable<IntentOutput["extractedData"]["navigationTarget"]> = "todo";
    if (lower.includes("note")) target = "notes";
    else if (lower.includes("weather")) target = "weather";
    else if (lower.includes("clock") || lower.includes("time")) target = "clock";
    else if (lower.includes("chat") || lower.includes("assistant")) target = "ai";
    else if (lower.includes("history") || lower.includes("voice") || lower.includes("log")) target = "history";
    else if (lower.includes("setting")) target = "settings";
    else if (lower.includes("overview") || lower.includes("dashboard") || lower.includes("home")) target = "overview";
    else if (lower.includes("task") || lower.includes("todo")) target = "todo";
    return { transcript, intent: "NAVIGATION", extractedData: { navigationTarget: target } };
  }
  return { transcript, intent: "GENERAL_AI", extractedData: { generalPrompt: transcript } };
}

// ---------------------------------------------------------------------------
// Main entry: WAV bytes -> transcript -> intent. Never invents a transcript.
// ---------------------------------------------------------------------------

export async function processVoiceWav(
  audio: Uint8Array,
  keys: ApiKeys
): Promise<IntentOutput> {
  if (!audio || audio.length < 1000) {
    throw new NoSpeechError("Audio buffer empty or too small");
  }
  const analysis = analyzeWavBytes(audio);
  console.log(
    `[STT] audio ${audio.length}B dur=${analysis.durationSec.toFixed(2)}s rms=${analysis.rms} peak=${analysis.peak} voiced=${(analysis.nonSilentRatio * 100).toFixed(1)}%`
  );
  if (analysis.isSilent) {
    throw new NoSpeechError(`No speech detected (${analysis.reason})`);
  }

  const sttErrors: string[] = [];

  if (keys.groqKey) {
    try {
      const transcript = await transcribeWithGroq(audio, keys);
      console.log(`[STT] Groq transcript: "${transcript}"`);
      assertRealSpeech(transcript, "Groq");
      return await classifyIntent(transcript, keys);
    } catch (e) {
      if (e instanceof NoSpeechError) throw e;
      sttErrors.push(`groq: ${(e as Error)?.message || e}`);
    }
  }

  if (keys.geminiKey) {
    try {
      const transcript = await transcribeWithGemini(audio, keys);
      console.log(`[STT] Gemini transcript: "${transcript}"`);
      assertRealSpeech(transcript, "Gemini");
      return await classifyIntent(transcript, keys);
    } catch (e) {
      if (e instanceof NoSpeechError) throw e;
      sttErrors.push(`gemini: ${(e as Error)?.message || e}`);
    }
  }

  if (keys.openaiKey) {
    try {
      const transcript = await transcribeWithOpenAICompatible(audio, keys);
      console.log(`[STT] OpenAI-compatible transcript: "${transcript}"`);
      assertRealSpeech(transcript, "OpenAI-compatible");
      return await classifyIntent(transcript, keys);
    } catch (e) {
      if (e instanceof NoSpeechError) throw e;
      sttErrors.push(`openai-compatible: ${(e as Error)?.message || e}`);
    }
  }

  throw new TranscriptionError(
    sttErrors.length > 0
      ? `No speech-to-text provider available. ${sttErrors.join(" | ")}. ` +
        `Add a free GROQ_API_KEY (console.groq.com) or GEMINI_API_KEY in the app Settings.`
      : "No speech-to-text provider configured. Add GROQ_API_KEY or GEMINI_API_KEY in the app Settings."
  );
}

// ---------------------------------------------------------------------------
// Answers. short=true for the OLED (<=20 words, small max tokens); the app's
// own chat leaves it off for full-length replies.
// ---------------------------------------------------------------------------

async function buildAssistantContext(): Promise<string> {
  try {
    const [openTasks, recentNotes, recentVoice, device] = await Promise.all([
      listTasks(true),
      listNotes(8),
      listVoice(5),
      getActiveDevice(),
    ]);
    const lines: string[] = ["[Live Second Brain data — use this to answer. Never invent tasks or notes.]"];
    if (openTasks.length > 0) {
      lines.push(`Open tasks (${openTasks.length}):`);
      for (const t of openTasks.slice(0, 15)) {
        const due = t.dueDate
          ? `, due ${new Date(t.dueDate).toLocaleDateString()}`
          : "";
        lines.push(`- "${t.title}" [${t.priority}${due}]`);
      }
    } else {
      lines.push("Open tasks: none. The task list is empty.");
    }
    if (recentNotes.length > 0) {
      lines.push("Recent notes:");
      for (const n of recentNotes) {
        const snippet = n.content.length > 150 ? n.content.slice(0, 150) + "…" : n.content;
        lines.push(`- "${n.title}" [${n.tags || "untagged"}]: ${snippet}`);
      }
    } else {
      lines.push("Notes: none saved yet.");
    }
    if (recentVoice.length > 0) {
      lines.push("Recent voice interactions:");
      for (const v of recentVoice) {
        lines.push(`- heard "${v.transcript}" → ${v.intent}`);
      }
    }
    if (device) {
      lines.push(`Device: ${device.name} (${device.deviceId}), battery ${device.battery}%, firmware ${device.firmware}.`);
    }
    return lines.join("\n");
  } catch (e) {
    console.warn("buildAssistantContext failed:", (e as Error)?.message || e);
    return "[Live Second Brain data unavailable — say so honestly instead of inventing tasks or notes.]";
  }
}

async function geminiAnswer(
  system: string,
  userContent: string,
  keys: ApiKeys,
  maxTokens?: number
): Promise<string | null> {
  try {
    const generationConfig: Record<string, unknown> = {};
    if (maxTokens) generationConfig.maxOutputTokens = maxTokens;
    const res = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(keys.geminiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${system}\n\n${userContent}` }] }],
          generationConfig,
        }),
      },
      20000
    );
    if (!res.ok) return null;
    const json = await res.json();
    const text = (json.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("") || "").trim();
    return text || null;
  } catch (e) {
    console.warn("Gemini queryLLM error:", (e as Error)?.message || e);
    return null;
  }
}

export async function queryLLM(
  prompt: string,
  keys: ApiKeys,
  opts?: { context?: boolean; short?: boolean }
): Promise<string> {
  const ENGLISH_SYSTEM =
    "You are a helpful assistant. Always respond in English (never Chinese or any other language), no matter what language the user writes in.";
  const system = opts?.short
    ? `${DEVICE_IDENTITY} ${OLED_SHORT_INSTRUCTION} ${ENGLISH_SYSTEM}`
    : ENGLISH_SYSTEM;
  const CONTEXT_INSTRUCTION = opts?.short
    ? "Use the live data below when the question is about tasks, notes, or history. For capability or general questions, answer directly in at most 20 words. Never invent tasks, notes, or events."
    : "Answer using the live data below. If the answer is not in the data, say so honestly — never invent tasks, notes, or events.";

  let userContent = prompt;
  if (opts?.context) {
    const ctx = await buildAssistantContext();
    userContent = `${CONTEXT_INSTRUCTION}\n\n${ctx}\n\nUser question: ${prompt}`;
  }

  const groqBase = "https://api.groq.com/openai/v1";
  const oaiBase = (keys.openaiBase || "https://api.hcnsec.cn/v1").replace(/\/+$/, "");
  const oaiModel =
    keys.openaiModel && keys.openaiModel !== "gpt-4o-mini"
      ? keys.openaiModel
      : "DeepSeek-V4-Flash";

  // Device path goes Groq-first (fast); app chat keeps proxy-first (quality).
  const attempts: (() => Promise<string | null>)[] = [];
  const groqAttempt = async () => {
    if (!keys.groqKey) return null;
    // gpt-oss is a reasoning model: keep the cap generous on Groq because
    // thinking tokens share the budget — a tight cap yields empty content.
    // (No reasoning_effort param here; plain REST stays engine-agnostic.)
    return await chatCompletions(groqBase, keys.groqKey, "openai/gpt-oss-20b", system, userContent, {
      maxTokens: opts?.short ? 300 : undefined,
    });
  };
  const openaiAttempt = async () => {
    if (!keys.openaiKey) return null;
    const models = oaiModel === "DeepSeek-V4-Flash" ? [oaiModel] : [oaiModel, "DeepSeek-V4-Flash"];
    for (const m of models) {
      const text = await chatCompletions(oaiBase, keys.openaiKey, m, system, userContent, {
        maxTokens: opts?.short ? 60 : undefined,
      });
      if (text) return text;
    }
    return null;
  };
  const geminiAttempt = async () => {
    if (!keys.geminiKey) return null;
    return await geminiAnswer(system, userContent, keys, opts?.short ? 60 : undefined);
  };
  if (opts?.short) attempts.push(groqAttempt, openaiAttempt, geminiAttempt);
  else attempts.push(openaiAttempt, geminiAttempt, groqAttempt);

  for (const attempt of attempts) {
    const text = await attempt();
    if (text) return text;
  }
  return "AI briefly unavailable. Check API keys in Settings and try again.";
}
