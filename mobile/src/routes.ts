// Device API handlers — JSON shapes mirror the website routes exactly,
// because the firmware parses fixed fields (response/transcript/success/
// page, taskCount/tasks/title, notes/title/snippet, weather/*, time/date).

import type { HttpRequest, HttpResponse } from "./http";
import {
  registerDevice,
  getDevice,
  heartbeatDevice,
  takePendingCommand,
  listTasks,
  countOpenTasks,
  createTask,
  listNotes,
  countNotes,
  createNote,
  logVoice,
  queueCommand,
} from "./db";
import {
  processVoiceWav,
  queryLLM,
  capWords,
  NoSpeechError,
  TranscriptionError,
  type IntentOutput,
} from "./ai";
import { fetchWeather } from "./weather";
import { fmtTime, fmtDate, clip } from "./fmt";
import { loadKeys } from "./keys";

const text = (u8: Uint8Array): string => {
  try {
    return new TextDecoder().decode(u8);
  } catch {
    return "";
  }
};

function deviceIdOf(req: HttpRequest): string {
  return (
    req.headers["x-device-id"] || req.query.deviceId || ""
  );
}

async function handleRegister(req: HttpRequest): Promise<HttpResponse> {
  let body: any = {};
  try {
    body = JSON.parse(text(req.body));
  } catch {
    // empty/invalid body — still require deviceId below
  }
  const { deviceId, name } = body;
  if (!deviceId) return { status: 400, json: { error: "deviceId is required" } };
  const dev = await registerDevice(String(deviceId), name ? String(name) : undefined);
  return {
    status: 200,
    json: { success: true, deviceId: dev.deviceId, name: dev.name, token: dev.token },
  };
}

async function handleHeartbeat(req: HttpRequest): Promise<HttpResponse> {
  let body: any = {};
  try {
    body = JSON.parse(text(req.body));
  } catch {
    return { status: 400, json: { error: "Invalid JSON" } };
  }
  const { deviceId, battery, firmware } = body;
  if (!deviceId) return { status: 400, json: { error: "deviceId is required" } };
  const dev = await heartbeatDevice(
    String(deviceId),
    battery !== undefined ? Number(battery) : undefined,
    firmware ? String(firmware) : undefined
  );

  const pending = await takePendingCommand(dev.deviceId);
  if (pending) {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(pending.payload);
    } catch {
      parsed = { raw: pending.payload };
    }
    return {
      status: 200,
      json: {
        success: true,
        command: pending.command,
        time: fmtTime(),
        date: fmtDate(),
        settings: {
          name: dev.name,
          brightness: dev.brightness,
          ledBehavior: dev.ledBehavior,
          recordingDuration: dev.recordingDuration,
          wifiSsid: dev.wifiSsid,
          wifiPassword: dev.wifiPassword,
        },
        ...parsed,
      },
    };
  }
  return {
    status: 200,
    json: {
      success: true,
      status: "online",
      time: fmtTime(),
      date: fmtDate(),
      settings: {
        name: dev.name,
        brightness: dev.brightness,
        ledBehavior: dev.ledBehavior,
        recordingDuration: dev.recordingDuration,
        wifiSsid: dev.wifiSsid,
        wifiPassword: dev.wifiPassword,
      },
    },
  };
}

async function handleSnapshot(req: HttpRequest): Promise<HttpResponse> {
  const deviceId = deviceIdOf(req);
  if (!deviceId) {
    return { status: 400, json: { error: "X-Device-ID header is required" } };
  }
  const dev = await getDevice(deviceId);
  if (!dev) {
    return { status: 401, json: { error: "Device not registered" } };
  }
  const [tasks, notes, weather] = await Promise.all([
    listTasks(true).then((t) => t.slice(0, 5)),
    listNotes(5),
    fetchWeather().catch(() => null),
  ]);
  const [taskCount, noteCount] = await Promise.all([
    countOpenTasks(),
    countNotes(),
  ]);
  return {
    status: 200,
    json: {
      tasks: tasks.map((t) => ({ title: clip(t.title, 26), priority: t.priority })),
      taskCount,
      notes: notes.map((n) => ({
        title: clip(n.title, 26),
        snippet: clip(n.content, 90),
      })),
      noteCount,
      weather,
      time: fmtTime(),
      date: fmtDate(),
      battery: dev.battery,
    },
  };
}

async function handleVoice(req: HttpRequest): Promise<HttpResponse> {
  const t0 = Date.now();
  const deviceId = deviceIdOf(req);
  if (!deviceId) {
    return { status: 400, json: { error: "X-Device-ID header is required" } };
  }
  const dev = await getDevice(deviceId);
  if (!dev) {
    return { status: 401, json: { error: "Device not registered" } };
  }
  const audio = req.body;
  console.log(`[Voice] body ${audio.length}B`);
  if (audio.length < 1000) {
    return {
      status: 422,
      json: {
        success: false,
        error: "NO_SPEECH",
        transcript: "",
        response: "NO AUDIO\n\nNothing received",
      },
    };
  }

  const keys = await loadKeys();
  let aiResult: IntentOutput;
  try {
    const t1 = Date.now();
    aiResult = await processVoiceWav(audio, keys);
    console.log(`[Voice] STT+classify ${Date.now() - t1}ms intent=${aiResult.intent}`);
  } catch (sttError) {
    if (sttError instanceof NoSpeechError) {
      await logVoice(deviceId, "(silence — no speech detected)", "NO SPEECH\n\nSay again...", "NO_SPEECH");
      return {
        status: 422,
        json: {
          success: false,
          error: "NO_SPEECH",
          transcript: "",
          response: "NO SPEECH\n\nSay again...",
        },
      };
    }
    if (sttError instanceof TranscriptionError) {
      await logVoice(deviceId, "(transcription unavailable)", "STT OFFLINE\n\nAdd key in app", "STT_FAILED");
      return {
        status: 503,
        json: {
          success: false,
          error: "STT_UNAVAILABLE",
          details: (sttError as Error).message,
          transcript: "",
          response: "STT OFFLINE\n\nAdd key in app",
        },
      };
    }
    throw sttError;
  }

  const { transcript, intent, extractedData } = aiResult;
  let responseMessage = "Done";
  let responsePage: string | undefined;

  switch (intent) {
    case "CREATE_TODO": {
      const title = extractedData.todoTitle || "New Task";
      const priority = extractedData.todoPriority || "medium";
      let dueDate: number | null = null;
      if (extractedData.todoDueDate) {
        const lowerDate = extractedData.todoDueDate.toLowerCase();
        const now = new Date();
        if (lowerDate.includes("tomorrow")) {
          const d = new Date(now);
          d.setDate(d.getDate() + 1);
          d.setHours(10, 0, 0, 0);
          dueDate = d.getTime();
        } else if (lowerDate.includes("today")) {
          const d = new Date(now);
          d.setHours(18, 0, 0, 0);
          dueDate = d.getTime();
        } else {
          const parsed = Date.parse(extractedData.todoDueDate);
          if (!isNaN(parsed)) dueDate = parsed;
        }
      }
      await createTask(title, priority, dueDate);
      const timeStr = dueDate
        ? `\n${new Date(dueDate).toLocaleDateString()} • ${fmtTime(new Date(dueDate))}`
        : "";
      responseMessage = `✓ TASK CREATED\n\n${title}${timeStr}`;
      break;
    }
    case "CREATE_NOTE": {
      const title = extractedData.noteTitle || "Voice Note";
      const content = extractedData.noteContent || transcript || "Saved voice note.";
      const tags = extractedData.noteTags || "voice";
      await createNote(title, content, tags);
      responseMessage = `✓ NOTE SAVED\n\n${title}`;
      break;
    }
    case "QUERY_WEATHER": {
      const weather = await fetchWeather();
      responseMessage = `WEATHER INFO\n\nNow: ${weather.temp}°C\n${weather.condition}\nTomor: ${weather.tomorrowMin}-${weather.tomorrowMax}°C`;
      break;
    }
    case "QUERY_CLOCK": {
      responseMessage = `CLOCK\n\n${fmtTime()}\n\n${fmtDate()}`;
      break;
    }
    case "QUERY_TASKS": {
      const openTasks = (await listTasks(true)).slice(0, 5);
      if (openTasks.length === 0) {
        responseMessage = `TASKS\n\nAll clear! No open tasks.`;
      } else {
        const lines = openTasks.slice(0, 4).map((t, i) => `${i + 1}. ${t.title}`);
        const more = openTasks.length > 4 ? `\n+${openTasks.length - 4} more` : "";
        responseMessage = `TASKS (${openTasks.length})\n\n${lines.join("\n")}${more}`;
      }
      responsePage = "tasks";
      break;
    }
    case "QUERY_NOTES": {
      const allNotes = (await listNotes(5));
      if (allNotes.length === 0) {
        responseMessage = `NOTES\n\nNo notes saved yet.`;
      } else {
        const lines = allNotes.slice(0, 4).map((n, i) => `${i + 1}. ${n.title}`);
        const more = allNotes.length > 4 ? `\n+${allNotes.length - 4} more` : "";
        responseMessage = `NOTES (${allNotes.length})\n\n${lines.join("\n")}${more}`;
      }
      responsePage = "notes";
      break;
    }
    case "NAVIGATION": {
      const target = extractedData.navigationTarget || "notes";
      await queueCommand(deviceId, "navigate", { target });
      responseMessage = `NAVIGATING...\n\nOpening ${target}`;
      const pageMap: Record<string, string> = {
        todo: "tasks", notes: "notes", weather: "weather", clock: "clock",
        ai: "ai", history: "ai", settings: "status", overview: "status",
      };
      responsePage = pageMap[target] || "status";
      break;
    }
    case "GENERAL_AI": {
      const prompt = extractedData.generalPrompt || transcript;
      const fullReply = await queryLLM(prompt, keys, { context: true, short: true });
      responseMessage = `AI RESPONSE\n\n${capWords(fullReply, 20)}`;
      break;
    }
    default: {
      responseMessage = `UNRECOGNIZED\n\nSay again...`;
      break;
    }
  }

  await logVoice(deviceId, transcript || "(unintelligible)", responseMessage, intent || "UNKNOWN");
  console.log(`[Voice] total ${Date.now() - t0}ms intent=${intent}`);
  return {
    status: 200,
    json: {
      success: true,
      transcript,
      response: responseMessage,
      ...(responsePage ? { page: responsePage } : {}),
    },
  };
}

export async function handleDeviceRequest(req: HttpRequest): Promise<HttpResponse> {
  const { method, path } = req;
  if (path === "/api/device/register" && method === "POST") return handleRegister(req);
  if (path === "/api/device/heartbeat" && method === "POST") return handleHeartbeat(req);
  if (path === "/api/device/snapshot" && method === "GET") return handleSnapshot(req);
  if (path === "/api/device/voice" && method === "POST") return handleVoice(req);
  return { status: 404, json: { error: "Not found" } };
}
