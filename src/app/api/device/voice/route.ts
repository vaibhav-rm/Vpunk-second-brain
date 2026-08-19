import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { processVoiceWav, queryLLM } from "@/lib/ai";
import { fetchWeather } from "@/lib/weather";

export async function POST(req: NextRequest) {
  try {
    const deviceId = req.headers.get("x-device-id") || req.headers.get("X-Device-ID");
    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");

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

    if (audioBuffer.length === 0) {
      return NextResponse.json(
        { error: "Audio buffer is empty" },
        { status: 400 }
      );
    }

    // Send to AI layer for transcription & intent extraction
    const aiResult = await processVoiceWav(audioBuffer, deviceId);
    const { transcript, intent, extractedData } = aiResult;

    let responseMessage = "Done";

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
        break;
      }

      case "GENERAL_AI": {
        const prompt = extractedData.generalPrompt || transcript;
        
        // Fetch full reply
        const fullReply = await queryLLM(prompt);
        
        // Make a shortened version for the 128x64 screen
        // In a real application, we might run a summarization or truncate it
        const maxLen = 70;
        const truncated = fullReply.length > maxLen 
          ? fullReply.substring(0, maxLen) + "..." 
          : fullReply;

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

    return NextResponse.json({
      success: true,
      transcript,
      response: responseMessage,
    });
  } catch (error: any) {
    console.error("Voice upload processing error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
