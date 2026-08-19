"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { queryLLM } from "@/lib/ai";

// ----------------------------------------------------
// DASHBOARD & DEVICE ACTIONS
// ----------------------------------------------------

export async function getDashboardData() {
  try {
    const device = await prisma.device.findFirst({
      orderBy: { lastHeartbeat: "desc" },
    });

    const activeDevice = device || {
      deviceId: "sb-001",
      name: "Second Brain Demo",
      battery: 72,
      firmware: "0.1.0",
      status: "online",
      lastHeartbeat: new Date(),
      brightness: 100,
      ledBehavior: "rainbow",
      recordingDuration: 5,
      wifiSsid: "VAIBHAV_WIFI",
      wifiPassword: "••••••••",
    };

    // Calculate online/offline status based on last heartbeat (within last 45 seconds)
    let isOnline = false;
    if (device) {
      const secondsAgo = (Date.now() - new Date(device.lastHeartbeat).getTime()) / 1000;
      isOnline = secondsAgo < 45 && device.status === "online";
    } else {
      isOnline = true; // demo mode
    }

    const taskCount = await prisma.task.count({ where: { completed: false } });
    const noteCount = await prisma.note.count();
    const interactionCount = await prisma.voiceInteraction.count();

    const recentInteractions = await prisma.voiceInteraction.findMany({
      orderBy: { createdAt: "desc" },
      take: 5,
    });

    return {
      device: {
        ...activeDevice,
        isOnline,
      },
      stats: {
        pendingTasks: taskCount,
        totalNotes: noteCount,
        interactions: interactionCount,
      },
      recentInteractions,
    };
  } catch (error) {
    console.error("Failed to get dashboard data:", error);
    return {
      device: {
        deviceId: "sb-001",
        name: "Second Brain Demo",
        battery: 72,
        firmware: "0.1.0",
        status: "offline",
        lastHeartbeat: new Date(),
        brightness: 100,
        ledBehavior: "rainbow",
        recordingDuration: 5,
        wifiSsid: "VAIBHAV_WIFI",
        wifiPassword: "",
        isOnline: false,
      },
      stats: {
        pendingTasks: 0,
        totalNotes: 0,
        interactions: 0,
      },
      recentInteractions: [],
    };
  }
}

export async function updateDeviceSettings(
  deviceId: string,
  settings: {
    name?: string;
    brightness?: number;
    ledBehavior?: string;
    recordingDuration?: number;
    wifiSsid?: string;
    wifiPassword?: string;
  }
) {
  try {
    await prisma.device.upsert({
      where: { deviceId },
      update: settings,
      create: {
        deviceId,
        name: settings.name || "Second Brain Wearable",
        token: Math.random().toString(36).substring(2),
        brightness: settings.brightness ?? 100,
        ledBehavior: settings.ledBehavior ?? "rainbow",
        recordingDuration: settings.recordingDuration ?? 5,
        wifiSsid: settings.wifiSsid ?? "",
        wifiPassword: settings.wifiPassword ?? "",
        status: "online",
      },
    });

    revalidatePath("/");
    revalidatePath("/dashboard");
    return { success: true };
  } catch (error) {
    console.error("Failed to update device settings:", error);
    return { success: false, error: "Database error" };
  }
}

export async function queueDeviceCommand(
  deviceId: string,
  command: string,
  payload: any
) {
  try {
    await prisma.commandQueue.create({
      data: {
        deviceId,
        command,
        payload: JSON.stringify(payload),
        processed: false,
      },
    });
    return { success: true };
  } catch (error) {
    console.error("Failed to queue device command:", error);
    return { success: false, error: "Database error" };
  }
}

// ----------------------------------------------------
// TO-DO ACTIONS
// ----------------------------------------------------

export async function getTasks() {
  return prisma.task.findMany({
    orderBy: [
      { completed: "asc" },
      { createdAt: "desc" },
    ],
  });
}

export async function createTask(title: string, priority: string, dueDate: Date | null) {
  try {
    const task = await prisma.task.create({
      data: {
        title,
        priority,
        dueDate,
      },
    });
    revalidatePath("/");
    revalidatePath("/dashboard");
    return { success: true, task };
  } catch (e) {
    return { success: false, error: "Failed to create task" };
  }
}

export async function toggleTask(id: string, completed: boolean) {
  try {
    await prisma.task.update({
      where: { id },
      data: { completed },
    });
    revalidatePath("/");
    revalidatePath("/dashboard");
    return { success: true };
  } catch (e) {
    return { success: false };
  }
}

export async function deleteTask(id: string) {
  try {
    await prisma.task.delete({
      where: { id },
    });
    revalidatePath("/");
    revalidatePath("/dashboard");
    return { success: true };
  } catch (e) {
    return { success: false };
  }
}

// ----------------------------------------------------
// NOTES ACTIONS
// ----------------------------------------------------

export async function getNotes() {
  return prisma.note.findMany({
    orderBy: { createdAt: "desc" },
  });
}

export async function createNote(title: string, content: string, tags: string) {
  try {
    const note = await prisma.note.create({
      data: {
        title,
        content,
        tags,
      },
    });
    revalidatePath("/");
    revalidatePath("/dashboard");
    return { success: true, note };
  } catch (e) {
    return { success: false, error: "Failed to create note" };
  }
}

export async function deleteNote(id: string) {
  try {
    await prisma.note.delete({
      where: { id },
    });
    revalidatePath("/");
    revalidatePath("/dashboard");
    return { success: true };
  } catch (e) {
    return { success: false };
  }
}

// ----------------------------------------------------
// VOICE HISTORY & CHAT ACTIONS
// ----------------------------------------------------

export async function getVoiceHistory() {
  return prisma.voiceInteraction.findMany({
    orderBy: { createdAt: "desc" },
  });
}

export async function sendChatMessage(prompt: string) {
  try {
    const reply = await queryLLM(prompt);

    // Also log this web-chat interaction as a voice-like log for unified display
    await prisma.voiceInteraction.create({
      data: {
        deviceId: "web-client",
        transcript: prompt,
        response: reply,
        intent: "GENERAL_AI",
      },
    });

    revalidatePath("/");
    revalidatePath("/dashboard");
    return { success: true, reply };
  } catch (error) {
    console.error("Chat error:", error);
    return { success: false, error: "Failed to get AI reply" };
  }
}

export async function clearVoiceLogs() {
  try {
    await prisma.voiceInteraction.deleteMany({});
    revalidatePath("/");
    revalidatePath("/dashboard");
    return { success: true };
  } catch (e) {
    return { success: false };
  }
}

// ----------------------------------------------------
// SIMULATOR ACTIONS
// ----------------------------------------------------

import { fetchWeather } from "@/lib/weather";

export async function simulateTextCommand(transcript: string) {
  try {
    const deviceId = "web-simulator";
    
    const systemPrompt = `
You are the AI engine for "Second Brain", a wearable companion.
You will process the user's transcription and classify their intent.
Provide a clean JSON output matching this structure:
{
  "intent": "CREATE_TODO" | "CREATE_NOTE" | "QUERY_WEATHER" | "QUERY_CLOCK" | "GENERAL_AI" | "NAVIGATION",
  "extractedData": {
    "todoTitle": "Title of the task",
    "todoPriority": "low" | "medium" | "high",
    "todoDueDate": "YYYY-MM-DD or time representation if mentioned",
    "noteTitle": "Title for the note",
    "noteContent": "Detailed note content",
    "noteTags": "comma,separated,tags",
    "weatherQuery": "location or tomorrow/today query",
    "generalPrompt": "the question for general AI",
    "navigationTarget": "todo" | "notes" | "weather" | "clock" | "ai"
  }
}

Guidelines:
- If they want to add a task, to-do, reminder, or item to buy, set intent to CREATE_TODO.
- If they want to remember something, write down a note, or save information, set intent to CREATE_NOTE.
- If they ask about the weather, set intent to QUERY_WEATHER.
- If they ask about time or clock, set intent to QUERY_CLOCK.
- If they want to navigate/open an app on the screen, set intent to NAVIGATION.
- For general questions/queries (e.g. "how does a transistor work"), set intent to GENERAL_AI.
- Output ONLY valid JSON. No markdown backticks. Do not wrap in \`\`\`json.
`;
    
    const classificationPrompt = `${systemPrompt}\n\nProcess this transcript: "${transcript}"`;
    const aiText = await queryLLM(classificationPrompt);
    
    let intent = "GENERAL_AI";
    let extractedData: any = {};
    
    try {
      let cleanJson = aiText.trim();
      if (cleanJson.startsWith("```")) {
        cleanJson = cleanJson.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
      }
      const parsed = JSON.parse(cleanJson);
      intent = parsed.intent;
      extractedData = parsed.extractedData || {};
    } catch (e) {
      const lower = transcript.toLowerCase();
      if (lower.includes("task") || lower.includes("todo") || lower.includes("remind") || lower.includes("buy")) {
        intent = "CREATE_TODO";
        extractedData.todoTitle = transcript.replace(/add task|todo|remind me to|buy/gi, "").trim();
        extractedData.todoPriority = lower.includes("urgent") || lower.includes("high") ? "high" : "medium";
        if (lower.includes("tomorrow")) extractedData.todoDueDate = "tomorrow";
      } else if (lower.includes("note") || lower.includes("remember") || lower.includes("save")) {
        intent = "CREATE_NOTE";
        extractedData.noteTitle = "Simulated Note";
        extractedData.noteContent = transcript.replace(/create note|remember that|save/gi, "").trim();
        extractedData.noteTags = "simulation,voice";
      } else if (lower.includes("weather")) {
        intent = "QUERY_WEATHER";
      } else if (lower.includes("time") || lower.includes("clock") || lower.includes("date")) {
        intent = "QUERY_CLOCK";
      } else if (lower.includes("open") || lower.includes("navigate") || lower.includes("go to")) {
        intent = "NAVIGATION";
        extractedData.navigationTarget = lower.includes("note") ? "notes" : "todo";
      } else {
        intent = "GENERAL_AI";
        extractedData.generalPrompt = transcript;
      }
    }
    
    let responseMessage = "Done";
    
    switch (intent) {
      case "CREATE_TODO": {
        const title = extractedData.todoTitle || "Simulated Task";
        const priority = extractedData.todoPriority || "medium";
        let dueDate: Date | null = null;
        if (extractedData.todoDueDate) {
          const lowerDate = extractedData.todoDueDate.toLowerCase();
          if (lowerDate.includes("tomorrow")) {
            dueDate = new Date();
            dueDate.setDate(dueDate.getDate() + 1);
            dueDate.setHours(10, 0, 0, 0);
          } else if (lowerDate.includes("today")) {
            dueDate = new Date();
            dueDate.setHours(18, 0, 0, 0);
          }
        }
        await prisma.task.create({
          data: { title, priority, dueDate, completed: false }
        });
        const timeStr = dueDate ? `\n${dueDate.toLocaleDateString()} • ${dueDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : "";
        responseMessage = `✓ TASK CREATED\n\n${title}${timeStr}`;
        break;
      }
      case "CREATE_NOTE": {
        const title = extractedData.noteTitle || "Simulated Note";
        const content = extractedData.noteContent || transcript;
        const tags = extractedData.noteTags || "simulator";
        await prisma.note.create({
          data: { title, content, tags }
        });
        responseMessage = `✓ NOTE SAVED\n\n${title}`;
        break;
      }
      case "QUERY_WEATHER": {
        const weather = await fetchWeather();
        responseMessage = `WEATHER INFO\n\nNow: ${weather.temp}°C\n${weather.condition}\nTomor: ${weather.tomorrowMin}-${weather.tomorrowMax}°C`;
        break;
      }
      case "QUERY_CLOCK": {
        const now = new Date();
        const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
        const dateStr = now.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
        responseMessage = `CLOCK\n\n${timeStr}\n\n${dateStr}`;
        break;
      }
      case "NAVIGATION": {
        const target = extractedData.navigationTarget || "notes";
        await prisma.commandQueue.create({
          data: {
            deviceId,
            command: "navigate",
            payload: JSON.stringify({ target }),
            processed: false
          }
        });
        responseMessage = `NAVIGATING...\n\nOpening ${target}`;
        break;
      }
      case "GENERAL_AI":
      default: {
        const prompt = extractedData.generalPrompt || transcript;
        const reply = await queryLLM(prompt);
        const maxLen = 70;
        const truncated = reply.length > maxLen ? reply.substring(0, maxLen) + "..." : reply;
        responseMessage = `AI RESPONSE\n\n${truncated}`;
        break;
      }
    }
    
    await prisma.voiceInteraction.create({
      data: {
        deviceId,
        transcript,
        response: responseMessage,
        intent
      }
    });
    
    revalidatePath("/");
    revalidatePath("/dashboard");
    return { success: true, transcript, response: responseMessage, intent };
  } catch (error) {
    console.error("Simulator text command error:", error);
    return { success: false, error: "Failed to process simulation command" };
  }
}

