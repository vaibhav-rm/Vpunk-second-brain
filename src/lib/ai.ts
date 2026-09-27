import { GoogleGenAI } from "@google/genai";
import OpenAI, { toFile } from "openai";
import { buildAssistantContext } from "@/lib/context";

export interface IntentOutput {
  transcript: string;
  intent: "CREATE_TODO" | "CREATE_NOTE" | "QUERY_WEATHER" | "QUERY_CLOCK" | "QUERY_TASKS" | "QUERY_NOTES" | "GENERAL_AI" | "NAVIGATION";
  extractedData: {
    todoTitle?: string;
    todoPriority?: "low" | "medium" | "high";
    todoDueDate?: string; // ISO or human readable
    noteTitle?: string;
    noteContent?: string;
    noteTags?: string;
    weatherQuery?: string;
    generalPrompt?: string;
    navigationTarget?: "todo" | "notes" | "weather" | "clock" | "ai" | "history" | "settings" | "overview";
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

// ---------------------------------------------------------------------------
// WAV silence / energy analysis
// The ESP32 sends 16-bit mono PCM WAV (16kHz). Silence (mic idle, button
// pressed with no speech) has near-zero sample energy. Transcribing it with
// Whisper hallucinates ("thank you", "you", ...) — so reject it locally.
// ---------------------------------------------------------------------------
export interface AudioAnalysis {
  durationSec: number;
  rms: number;
  peak: number;
  nonSilentRatio: number;
  isSilent: boolean;
  reason?: string;
}

export function analyzeWavBuffer(audioBuffer: Buffer): AudioAnalysis {
  // Default: assume 16kHz mono 16-bit if header unparseable
  let dataStart = 44;
  let sampleRate = 16000;
  let bitsPerSample = 16;

  try {
    if (
      audioBuffer.length > 44 &&
      audioBuffer.toString("ascii", 0, 4) === "RIFF" &&
      audioBuffer.toString("ascii", 8, 12) === "WAVE"
    ) {
      // Walk chunks to find "fmt " and "data"
      let offset = 12;
      while (offset + 8 <= audioBuffer.length) {
        const chunkId = audioBuffer.toString("ascii", offset, offset + 4);
        const chunkSize = audioBuffer.readUInt32LE(offset + 4);
        if (chunkId === "fmt " && chunkSize >= 16) {
          sampleRate = audioBuffer.readUInt32LE(offset + 12);
          bitsPerSample = audioBuffer.readUInt16LE(offset + 22);
        }
        if (chunkId === "data") {
          dataStart = offset + 8;
          break;
        }
        offset += 8 + chunkSize;
        if (offset > 512) break; // header shouldn't be huge
      }
    }
  } catch {
    // fall through to defaults
  }

  const pcm = audioBuffer.subarray(Math.min(dataStart, audioBuffer.length));
  const bytesPerSample = Math.max(1, Math.floor(bitsPerSample / 8));

  // Only 16-bit PCM is expected from firmware; handle 8-bit gracefully
  const sampleCount = Math.floor(pcm.length / bytesPerSample);
  if (sampleCount < sampleRate * 0.4) {
    return {
      durationSec: sampleCount / Math.max(1, sampleRate),
      rms: 0,
      peak: 0,
      nonSilentRatio: 0,
      isSilent: true,
      reason: "audio too short (<0.4s of samples)",
    };
  }

  let sumSq = 0;
  let peak = 0;
  let nonSilent = 0;
  const SILENCE_SAMPLE_THRESHOLD = 500; // ~1.5% of full scale; mic noise floor is well below this
  const step = Math.max(1, Math.floor(sampleCount / 8000)); // sample up to 8k points
  let evaluated = 0;

  for (let i = 0; i < sampleCount; i += step) {
    let s = 0;
    if (bytesPerSample >= 2) {
      s = pcm.readInt16LE(i * bytesPerSample);
    } else {
      s = (pcm[i] - 128) * 256;
    }
    const abs = Math.abs(s);
    if (abs > peak) peak = abs;
    sumSq += s * s;
    if (abs > SILENCE_SAMPLE_THRESHOLD) nonSilent++;
    evaluated++;
  }

  const trueRms = Math.sqrt(sumSq / Math.max(1, evaluated));
  const nonSilentRatio = nonSilent / Math.max(1, evaluated);
  const durationSec = sampleCount / Math.max(1, sampleRate);

  // Speech at 16kHz mono from INMP441 at normal volume: RMS typically > 300,
  // peak > 2000, non-silent ratio > 5%. Silence: RMS < 100, peak < 800.
  const isSilent =
    trueRms < 150 || peak < 800 || nonSilentRatio < 0.02 || durationSec < 0.5;

  return {
    durationSec,
    rms: Math.round(trueRms),
    peak,
    nonSilentRatio,
    isSilent,
    reason: isSilent
      ? `rms=${Math.round(trueRms)} peak=${peak} voiced=${(nonSilentRatio * 100).toFixed(1)}% dur=${durationSec.toFixed(2)}s`
      : undefined,
  };
}

// Whisper-family models hallucinate short phrases ("you", "thank you", ".")
// on noise/non-speech that passes the energy gate. Treat those as no-speech
// instead of creating bogus tasks/chat replies from them.
const HALLUCINATION_DENYLIST = new Set([
  "you",
  "thank you",
  "thanks",
  "thank you for watching",
  "thanks for watching",
  "thanks for watching this video",
  "subtitles",
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
// Device-OLED answer budget: the 128x64 screen fits ~4 lines x 21 chars, so
// device voice answers are capped at ~20 words. Requesting short output from
// the model (plus a small max_tokens) saves output tokens on every press.
// Web chat/simulator leave `short` off and keep full-length replies.
// ---------------------------------------------------------------------------
export const OLED_SHORT_INSTRUCTION =
  "Reply in at most 20 words. Plain short phrases, no markdown, no lists. English only.";

export const DEVICE_IDENTITY =
  "You are Second Brain, a wearable ESP32 voice companion. You can: create tasks, save notes, report weather, tell time, list tasks and notes, and chat.";

export function capWords(text: string, maxWords = 20): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length > maxWords ? words.slice(0, maxWords).join(" ") : words.join(" ");
}

// Fail-fast wrapper: provider SDKs without a native timeout must never hold
// a voice POST open. Rejects after ms so the device gets TRY AGAIN, not -11.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

// ---------------------------------------------------------------------------
// Transcription providers (each returns real transcript or throws)
// Priority: Groq (free whisper-large-v3-turbo) > Gemini (native audio) >
// OpenAI-compatible (only if the endpoint actually serves STT).
// NOTE: the default hcnsec proxy (https://api.hcnsec.cn/v1) exposes NO
// working /audio/transcriptions model (whisper-1 -> model_not_found), so it
// is tried LAST and never fakes a transcript on failure.
// Single-model attempts with tight timeouts: sequential model retries turned
// one slow provider into 60-90s+ and tripped the device's 90s POST timeout.
// ---------------------------------------------------------------------------

async function transcribeWithGroq(audioBuffer: Buffer): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY not configured");
  const groq = new OpenAI({ apiKey, baseURL: "https://api.groq.com/openai/v1", timeout: 15000, maxRetries: 0 });
  // turbo only: the v3 fallback doubled worst-case STT latency for no gain
  // on short voice-command clips.
  try {
    const file = await toFile(audioBuffer, "speech.wav", { type: "audio/wav" });
    const res = await groq.audio.transcriptions.create({
      file,
      model: "whisper-large-v3-turbo",
      language: "en",
      response_format: "json",
    });
    const text = (res.text || "").trim();
    if (text) return text;
    throw new Error("Groq model whisper-large-v3-turbo returned empty transcript");
  } catch (e) {
    console.warn("Groq STT 'whisper-large-v3-turbo' failed:", (e as Error)?.message || e);
    throw e instanceof Error ? e : new Error(String(e));
  }
}

async function transcribeWithGemini(audioBuffer: Buffer): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured");
  const ai = new GoogleGenAI({ apiKey });
  const response = await withTimeout(
    ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [
        {
          inlineData: {
            data: audioBuffer.toString("base64"),
            mimeType: "audio/wav",
          },
        },
        "Transcribe this audio exactly. If there is no intelligible speech, respond with exactly: NO_SPEECH. Otherwise respond with ONLY the transcription text, no commentary.",
      ],
    }),
    20000,
    "Gemini STT"
  );
  const text = (response.text || "").trim();
  if (!text || text === "NO_SPEECH") {
    throw new NoSpeechError("Gemini detected no intelligible speech");
  }
  return text;
}

async function transcribeWithOpenAICompatible(audioBuffer: Buffer): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");
  const baseURL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const openai = new OpenAI({ apiKey, baseURL, timeout: 15000, maxRetries: 0 });
  // Single attempt: hcnsec-style proxies serve no working STT model, so
  // retrying ids only stacks timeouts onto the device's 90s POST budget.
  try {
    const file = await toFile(audioBuffer, "speech.wav", { type: "audio/wav" });
    const res = await openai.audio.transcriptions.create({ file, model: "whisper-1" });
    const text = (res.text || "").trim();
    if (text) return text;
    throw new Error("Model whisper-1 returned empty transcript");
  } catch (e) {
    console.warn("OpenAI-compatible STT 'whisper-1' failed:", (e as Error)?.message || e);
    throw e instanceof Error ? e : new Error(String(e));
  }
}

// ---------------------------------------------------------------------------
// Intent classification (text-only LLM, separate from STT)
// ---------------------------------------------------------------------------
async function classifyIntent(transcript: string): Promise<IntentOutput> {
  // Fast path: obvious read-only commands skip the LLM entirely (saves a full
  // round-trip + tokens). CREATE_* still goes through the LLM so a stray
  // keyword ("what should I buy?") can never auto-create a junk task/note.
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

  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasGemini = !!process.env.GEMINI_API_KEY;
  const hasGroq = !!process.env.GROQ_API_KEY;

  // Groq first: gpt-oss-20b with enforced JSON answers in ~seconds, while the
  // proxy path often takes 10-30s per call. Falls through on any failure.
  if (hasGroq) {
    try {
      const openai = new OpenAI({
        apiKey: process.env.GROQ_API_KEY,
        baseURL: "https://api.groq.com/openai/v1",
        timeout: 20000,
        maxRetries: 0,
      });
      const completion = await openai.chat.completions.create({
        model: "openai/gpt-oss-20b",
        messages: [
          { role: "system", content: SYSTEM_INSTRUCTION },
          { role: "user", content: `Process this transcript: "${transcript}"` },
        ],
        response_format: { type: "json_object" },
      });
      const resultText = completion.choices[0]?.message?.content || "{}";
      const parsed = JSON.parse(resultText) as IntentOutput;
      parsed.transcript = transcript;
      return parsed;
    } catch (error) {
      console.error("Groq classification error:", error);
    }
  }

  if (hasOpenAI) {
    try {
      const apiKey = process.env.OPENAI_API_KEY!;
      const baseURL = process.env.OPENAI_BASE_URL || "https://api.hcnsec.cn/v1";
      const primaryModel =
        process.env.OPENAI_MODEL && process.env.OPENAI_MODEL !== "gpt-4o-mini"
          ? process.env.OPENAI_MODEL
          : "DeepSeek-V4-Flash";
      const openai = new OpenAI({ apiKey, baseURL, timeout: 20000, maxRetries: 0 });
      // Single primary-model attempt: the 3-model fallback loop turned one
      // slow proxy into 60s+ and tripped the device's 90s POST timeout.
      try {
        const completion = await openai.chat.completions.create({
          model: primaryModel,
          messages: [
            { role: "system", content: SYSTEM_INSTRUCTION },
            { role: "user", content: `Process this transcript: "${transcript}"` },
          ],
        });
        const text = completion.choices[0]?.message?.content || "";
        if (text.trim()) {
          const sanitized = text.replace(/```json\s*/g, "").replace(/```\s*$/g, "").trim();
          const parsed = JSON.parse(sanitized) as IntentOutput;
          parsed.transcript = transcript;
          return parsed;
        }
      } catch (modelErr) {
        console.warn(
          `Model '${primaryModel}' failed on intent classification:`,
          (modelErr as Error)?.message || modelErr
        );
      }
    } catch (error) {
      console.error("OpenAI classification error:", error);
    }
  }

  if (hasGemini) {
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const response = await withTimeout(
        ai.models.generateContent({
          model: "gemini-2.0-flash",
          contents: [SYSTEM_INSTRUCTION + `\nProcess this transcript: "${transcript}"`],
          config: { responseMimeType: "application/json" },
        }),
        20000,
        "Gemini classify"
      );
      const text = response.text || "{}";
      const parsed = JSON.parse(text) as IntentOutput;
      parsed.transcript = transcript;
      return parsed;
    } catch (error) {
      console.error("Gemini classification error:", error);
    }
  }

  // No LLM available — rule-based fallback so text simulator still works.
  return ruleBasedIntent(transcript);
}

function ruleBasedIntent(transcript: string): IntentOutput {
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
    let target: IntentOutput["extractedData"]["navigationTarget"] = "todo";
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
// Main entry: WAV -> transcript -> intent. NEVER invents a transcript.
// ---------------------------------------------------------------------------
export async function processVoiceWav(
  audioBuffer: Buffer,
  deviceId: string
): Promise<IntentOutput> {
  void deviceId;

  if (!audioBuffer || audioBuffer.length < 1000) {
    throw new NoSpeechError("Audio buffer empty or too small");
  }

  // 1. Local silence gate — catches "said nothing" before any API call.
  const analysis = analyzeWavBuffer(audioBuffer);
  console.log(
    `[STT] audio ${audioBuffer.length}B dur=${analysis.durationSec.toFixed(2)}s rms=${analysis.rms} peak=${analysis.peak} voiced=${(analysis.nonSilentRatio * 100).toFixed(1)}%`
  );
  if (analysis.isSilent) {
    throw new NoSpeechError(`No speech detected (${analysis.reason})`);
  }

  // 2. Transcribe with a real provider. Order matters: Groq/Gemini actually
  //    serve STT; generic OpenAI-compatible proxies (hcnsec) usually don't.
  const sttErrors: string[] = [];

  if (process.env.GROQ_API_KEY) {
    try {
      const transcript = await transcribeWithGroq(audioBuffer);
      console.log(`[STT] Groq transcript: "${transcript}"`);
      assertRealSpeech(transcript, "Groq");
      return await classifyIntent(transcript);
    } catch (e) {
      if (e instanceof NoSpeechError) throw e;
      sttErrors.push(`groq: ${(e as Error)?.message || e}`);
    }
  }

  if (process.env.GEMINI_API_KEY) {
    try {
      const transcript = await transcribeWithGemini(audioBuffer);
      console.log(`[STT] Gemini transcript: "${transcript}"`);
      assertRealSpeech(transcript, "Gemini");
      return await classifyIntent(transcript);
    } catch (e) {
      if (e instanceof NoSpeechError) throw e;
      sttErrors.push(`gemini: ${(e as Error)?.message || e}`);
    }
  }

  if (process.env.OPENAI_API_KEY) {
    try {
      const transcript = await transcribeWithOpenAICompatible(audioBuffer);
      console.log(`[STT] OpenAI-compatible transcript: "${transcript}"`);
      assertRealSpeech(transcript, "OpenAI-compatible");
      return await classifyIntent(transcript);
    } catch (e) {
      if (e instanceof NoSpeechError) throw e;
      sttErrors.push(`openai-compatible: ${(e as Error)?.message || e}`);
    }
  }

  // 3. No provider could transcribe — fail loudly instead of hallucinating
  //    a task. This is the bug that created "Finish research paper" from
  //    silence: the old code fell back to a hardcoded transcript here.
  throw new TranscriptionError(
    sttErrors.length > 0
      ? `No speech-to-text provider available. ${sttErrors.join(" | ")}. ` +
        `Fix: add a free GROQ_API_KEY (console.groq.com, whisper-large-v3-turbo) ` +
        `or GEMINI_API_KEY (aistudio.google.com) to .env. ` +
        `The default OPENAI_BASE_URL proxy has no working STT model.`
      : "No speech-to-text provider configured. Add GROQ_API_KEY or GEMINI_API_KEY to .env."
  );
}

// For text chat interface. Pass { context: true } for user-facing answers so
// the model sees live tasks/notes instead of hallucinating them. Pass
// { short: true } for device-OLED answers: capped at ~20 words with a small
// max_tokens so every press costs fewer output tokens. Web chat leaves
// `short` off and keeps full-length replies.
export async function queryLLM(prompt: string, opts?: { context?: boolean; short?: boolean }): Promise<string> {
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasGemini = !!process.env.GEMINI_API_KEY;
  const hasGroq = !!process.env.GROQ_API_KEY;
  const ENGLISH_SYSTEM = "You are a helpful assistant. Always respond in English (never Chinese or any other language), no matter what language the user writes in.";
  // Short (device-OLED) answers carry identity + capabilities: without it the
  // grounding instruction below makes the model refuse "what can you do?"
  // style questions with "cannot answer based on your data".
  const system = opts?.short ? `${DEVICE_IDENTITY} ${OLED_SHORT_INSTRUCTION} ${ENGLISH_SYSTEM}` : ENGLISH_SYSTEM;
  const CONTEXT_INSTRUCTION = opts?.short
    ? "Use the live data below when the question is about tasks, notes, or history. For capability or general questions, answer directly in at most 20 words. Never invent tasks, notes, or events."
    : "Answer using the live data below. If the answer is not in the data, say so honestly — never invent tasks, notes, or events.";

  let userContent = prompt;
  if (opts?.context) {
    const ctx = await buildAssistantContext();
    userContent = `${CONTEXT_INSTRUCTION}\n\n${ctx}\n\nUser question: ${prompt}`;
  }

  // Empty content is treated as failure (fall through), never returned: the
  // old `|| "No response"` surfaced blank provider replies on the OLED.
  const attemptOpenAI = async (): Promise<string | null> => {
    if (!hasOpenAI) return null;
    try {
      const apiKey = process.env.OPENAI_API_KEY!;
      const baseURL = process.env.OPENAI_BASE_URL || "https://api.hcnsec.cn/v1";
      const primaryModel = process.env.OPENAI_MODEL && process.env.OPENAI_MODEL !== "gpt-4o-mini"
        ? process.env.OPENAI_MODEL
        : "DeepSeek-V4-Flash";

      const openai = new OpenAI({
        apiKey,
        baseURL,
        timeout: 20000,
        maxRetries: 0,
      });

      // Primary + one fallback max: deeper chains stacked into 60s+ waits.
      const candidateModels =
        primaryModel === "DeepSeek-V4-Flash" ? [primaryModel] : [primaryModel, "DeepSeek-V4-Flash"];
      for (const modelToTry of candidateModels) {
        try {
          const completion = await openai.chat.completions.create({
            model: modelToTry,
            messages: [
              { role: "system", content: system },
              { role: "user", content: userContent },
            ],
            ...(opts?.short ? { max_tokens: 60 } : {}),
          });
          const text = (completion.choices[0]?.message?.content || "").trim();
          if (text) return text;
          console.warn(`Model '${modelToTry}' returned empty content on queryLLM`);
        } catch (modelErr) {
          console.warn(`Model '${modelToTry}' failed on queryLLM:`, (modelErr as Error)?.message || modelErr);
        }
      }
    } catch (e) {
      console.error("OpenAI queryLLM error:", e);
    }
    return null;
  };

  const attemptGemini = async (): Promise<string | null> => {
    if (!hasGemini) return null;
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const response = await withTimeout(
        ai.models.generateContent({
          model: "gemini-2.0-flash",
          contents: `${system}\n\n${userContent}`,
          ...(opts?.short ? { config: { maxOutputTokens: 60 } } : {}),
        }),
        20000,
        "Gemini queryLLM"
      );
      const text = (response.text || "").trim();
      if (text) return text;
      console.warn("Gemini returned empty content on queryLLM");
    } catch (e) {
      console.error(e);
    }
    return null;
  };

  const attemptGroq = async (): Promise<string | null> => {
    if (!hasGroq) return null;
    try {
      const openai = new OpenAI({
        apiKey: process.env.GROQ_API_KEY,
        baseURL: "https://api.groq.com/openai/v1",
        timeout: 20000,
        maxRetries: 0,
      });
      const completion = await openai.chat.completions.create({
        model: "openai/gpt-oss-20b",
        messages: [
          { role: "system", content: system },
          { role: "user", content: userContent },
        ],
        // gpt-oss is a reasoning model: low effort keeps it fast, and the cap
        // stays generous because thinking tokens share the budget — a tight
        // cap (e.g. 60) starves the answer and yields empty content.
        reasoning_effort: "low",
        ...(opts?.short ? { max_tokens: 300 } : {}),
      });
      const text = (completion.choices[0]?.message?.content || "").trim();
      if (text) return text;
      console.warn("Groq returned empty content on queryLLM");
    } catch (e) {
      console.error(e);
    }
    return null;
  };

  // Device path goes Groq-first (fast, ~seconds); web keeps proxy-first
  // (answer quality first). First non-empty answer wins.
  const ordered = opts?.short
    ? [attemptGroq, attemptOpenAI, attemptGemini]
    : [attemptOpenAI, attemptGemini, attemptGroq];
  for (const attempt of ordered) {
    const text = await attempt();
    if (text) return text;
  }

  return "AI briefly unavailable. Check server logs and try again.";
}
