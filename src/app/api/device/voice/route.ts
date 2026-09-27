import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { processVoiceWav, queryLLM, capWords, NoSpeechError, TranscriptionError } from "@/lib/ai";
import { fetchWeather } from "@/lib/weather";

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  try {
    const deviceId = req.headers.get("x-device-id") || req.headers.get("X-Device-ID");

    if (!deviceId) {
      return NextResponse.json(
        { error: "X-Device-ID header is required" },
        { status: 400 }
      );
    }

    // Verify device exists (in a real app we'd verify the Bearer token as well)
    const device = await prisma.device.findUnique({
      where: { deviceId },
    });

    if (!device) {
      return NextResponse.json(
        { error: "Device not registered" },
        { status: 401 }
      );
    }

    // Retrieve raw binary WAV buffer
    const arrayBuffer = await req.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);
    console.log(`[Voice] body ${audioBuffer.length}B in ${Date.now() - t0}ms`);

    if (audioBuffer.length < 1000) {
      return NextResponse.json(
        {
          success: false,
          error: "NO_SPEECH",
          transcript: "",
          response: "NO AUDIO\n\nNothing received",
        },
        { status: 422 }
      );
    }

    // Send to AI layer for transcription & intent extraction.
    // NOTE: processVoiceWav now throws NoSpeechError (silence) or
    // TranscriptionError (no working STT provider) instead of inventing
    // a transcript. Both are handled below WITHOUT creating tasks/notes.
    let aiResult;
    try {
      const t1 = Date.now();
      aiResult = await processVoiceWav(audioBuffer, deviceId);
      console.log(`[Voice] STT+classify ${Date.now() - t1}ms intent=${aiResult.intent}`);
    } catch (sttError) {
      if (sttError instanceof NoSpeechError) {
        await prisma.voiceInteraction.create({
          data: {
            deviceId,
            transcript: "(silence — no speech detected)",
            response: "NO SPEECH\n\nSay again...",
            intent: "NO_SPEECH",
          },
        });
        return NextResponse.json(
          {
            success: false,
            error: "NO_SPEECH",
            transcript: "",
            response: "NO SPEECH\n\nSay again...",
          },
          { status: 422 }
        );
      }
      if (sttError instanceof TranscriptionError) {
        await prisma.voiceInteraction.create({
          data: {
            deviceId,
            transcript: "(transcription unavailable)",
            response: "STT OFFLINE\n\nAdd GROQ_API_KEY",
            intent: "STT_FAILED",
          },
        });
        return NextResponse.json(
          {
            success: false,
            error: "STT_UNAVAILABLE",
            details: (sttError as Error).message,
            transcript: "",
            response: "STT OFFLINE\n\nAdd GROQ_API_KEY",
          },
          { status: 503 }
        );
      }
      throw sttError;
    }

    const { transcript, intent, extractedData } = aiResult;

    let responseMessage = "Done";
    // Tells the OLED which page to jump to after a NAVIGATION command.
    let responsePage: string | undefined;

    // Perform database side-effects based on intent
    switch (intent) {
      case "CREATE_TODO": {
        const title = extractedData.todoTitle || "New Task";
        const priority = extractedData.todoPriority || "medium";

        let dueDate: Date | null = null;
        if (extractedData.todoDueDate) {
          const lowerDate = extractedData.todoDueDate.toLowerCase();
          if (lowerDate.includes("tomorrow")) {
            dueDate = new Date();
            dueDate.setDate(dueDate.getDate() + 1);
            dueDate.setHours(10, 0, 0, 0); // Default to 10 AM tomorrow
          } else if (lowerDate.includes("today")) {
            dueDate = new Date();
            dueDate.setHours(18, 0, 0, 0); // Default to 6 PM today
          } else {
            const parsed = Date.parse(extractedData.todoDueDate);
            if (!isNaN(parsed)) {
              dueDate = new Date(parsed);
            }
          }
        }

        await prisma.task.create({
          data: {
            title,
            priority,
            dueDate,
            completed: false,
          },
        });

        const timeStr = dueDate
          ? `\n${dueDate.toLocaleDateString([], { month: 'short', day: 'numeric' })} • ${dueDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
          : "";

        responseMessage = `✓ TASK CREATED\n\n${title}${timeStr}`;
        break;
      }

      case "CREATE_NOTE": {
        const title = extractedData.noteTitle || "Voice Note";
        const content = extractedData.noteContent || transcript || "Saved voice note.";
        const tags = extractedData.noteTags || "voice";

        await prisma.note.create({
          data: {
            title,
            content,
            tags,
          },
        });

        responseMessage = `✓ NOTE SAVED\n\n${title}`;
        break;
      }

      case "QUERY_WEATHER": {
        // Fetch real weather using Open-Meteo
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

      case "QUERY_TASKS": {
        // Deterministic answer straight from the DB — never hallucinated.
        const openTasks = await prisma.task.findMany({
          where: { completed: false },
          orderBy: { createdAt: "desc" },
          take: 5,
        });
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
        const notes = await prisma.note.findMany({
          orderBy: { createdAt: "desc" },
          take: 5,
        });
        if (notes.length === 0) {
          responseMessage = `NOTES\n\nNo notes saved yet.`;
        } else {
          const lines = notes.slice(0, 4).map((n, i) => `${i + 1}. ${n.title}`);
          const more = notes.length > 4 ? `\n+${notes.length - 4} more` : "";
          responseMessage = `NOTES (${notes.length})\n\n${lines.join("\n")}${more}`;
        }
        responsePage = "notes";
        break;
      }

      case "NAVIGATION": {
        const target = extractedData.navigationTarget || "notes";

        // Queue command for device (if OLED wants to react)
        await prisma.commandQueue.create({
          data: {
            deviceId,
            command: "navigate",
            payload: JSON.stringify({ target }),
            processed: false,
          },
        });

        responseMessage = `NAVIGATING...\n\nOpening ${target}`;
        // OLED page hint so the device jumps straight to the right screen.
        const pageMap: Record<string, string> = {
          todo: "tasks",
          notes: "notes",
          weather: "weather",
          clock: "clock",
          ai: "ai",
          history: "ai",
          settings: "status",
          overview: "status",
        };
        responsePage = pageMap[target] || "status";
        break;
      }

      case "GENERAL_AI": {
        const prompt = extractedData.generalPrompt || transcript;

        // Context-aware: the model sees live tasks/notes. Short mode: the
        // 128x64 OLED fits ~20 words, and short generation saves output
        // tokens on every press. Web chat keeps full-length replies.
        const fullReply = await queryLLM(prompt, { context: true, short: true });

        // Word-boundary cap (never cut mid-word for the tiny screen)
        const truncated = capWords(fullReply, 20);

        responseMessage = `AI RESPONSE\n\n${truncated}`;
        break;
      }

      default: {
        responseMessage = `UNRECOGNIZED\n\nSay again...`;
        break;
      }
    }

    // Save to interaction log
    await prisma.voiceInteraction.create({
      data: {
        deviceId,
        transcript: transcript || "(unintelligible)",
        response: responseMessage,
        intent: intent || "UNKNOWN",
      },
    });

    console.log(`[Voice] total ${Date.now() - t0}ms intent=${aiResult.intent}`);
    return NextResponse.json({
      success: true,
      transcript,
      response: responseMessage,
      ...(responsePage ? { page: responsePage } : {}),
    });
  } catch (error: unknown) {
    console.error("Voice upload processing error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
