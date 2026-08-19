import { GoogleGenAI } from "@google/genai";
import OpenAI, { toFile } from "openai";

interface IntentOutput {
  transcript: string;
  intent: "CREATE_TODO" | "CREATE_NOTE" | "QUERY_WEATHER" | "QUERY_CLOCK" | "GENERAL_AI" | "NAVIGATION";
  extractedData: {
    todoTitle?: string;
    todoPriority?: "low" | "medium" | "high";
    todoDueDate?: string; // ISO or human readable
    noteTitle?: string;
    noteContent?: string;
    noteTags?: string;
    weatherQuery?: string;
    generalPrompt?: string;
    navigationTarget?: string;
  };
}

const SYSTEM_INSTRUCTION = `
You are the AI engine for "Second Brain", a wearable companion.
You will process the user's spoken audio transcription and classify their intent.
Provide a clean JSON output matching this structure:
{
  "transcript": "what the user said",
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
- Output ONLY valid JSON. No markdown backticks.
`;

export async function processVoiceWav(
  audioBuffer: Buffer,
  deviceId: string
): Promise<IntentOutput> {
  const hasGemini = !!process.env.GEMINI_API_KEY;
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasGroq = !!process.env.GROQ_API_KEY;

  if (hasGemini) {
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      // With @google/genai, we pass base64 audio and prompts to generateContent
      const response = await ai.models.generateContent({
        model: "gemini-2.0-flash", // or "gemini-1.5-flash"
        contents: [
          {
            inlineData: {
              data: audioBuffer.toString("base64"),
              mimeType: "audio/wav",
            },
          },
          SYSTEM_INSTRUCTION + "\nTranscribe this audio, extract the intent and return the JSON structure."
        ],
        config: {
          responseMimeType: "application/json",
        }
      });

      const text = response.text || "";
      return JSON.parse(text) as IntentOutput;
    } catch (error) {
      console.error("Gemini processing error:", error);
    }
  }

  if (hasOpenAI) {
    try {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      
      // Convert buffer to file-like object for OpenAI Whisper
      const file = await toFile(audioBuffer, "speech.wav", { type: "audio/wav" });
      const transcription = await openai.audio.transcriptions.create({
        file: file,
        model: "whisper-1",
      });

      const transcript = transcription.text;
      
      // Query LLM for intent
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SYSTEM_INSTRUCTION },
          { role: "user", content: `Process this transcript: "${transcript}"` }
        ],
        response_format: { type: "json_object" }
      });

      const resultText = completion.choices[0].message.content || "{}";
      const parsed = JSON.parse(resultText) as IntentOutput;
      parsed.transcript = transcript;
      return parsed;
    } catch (error) {
      console.error("OpenAI processing error:", error);
    }
  }

  if (hasGroq) {
    try {
      const openai = new OpenAI({
        apiKey: process.env.GROQ_API_KEY,
        baseURL: "https://api.groq.com/openai/v1",
      });

      const file = await toFile(audioBuffer, "speech.wav", { type: "audio/wav" });
      const transcription = await openai.audio.transcriptions.create({
        file: file,
        model: "whisper-large-v3",
      });

      const transcript = transcription.text;

      const completion = await openai.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: SYSTEM_INSTRUCTION },
          { role: "user", content: `Process this transcript: "${transcript}"` }
        ],
        response_format: { type: "json_object" }
      });

      const resultText = completion.choices[0].message.content || "{}";
      const parsed = JSON.parse(resultText) as IntentOutput;
      parsed.transcript = transcript;
      return parsed;
    } catch (error) {
      console.error("Groq processing error:", error);
    }
  }

  // Mock Fallback Processor
  // When no API keys are present, we inspect the audio length (or generate random triggers)
  // Or simulate a voice command to demonstrate functionality
  console.log("Using Mock Voice Processor...");
  
  // We simulate some transcripts depending on a simple hash or just return a default
  const mockOptions: IntentOutput[] = [
    {
      transcript: "Add finish research paper to my to-do list.",
      intent: "CREATE_TODO",
      extractedData: {
        todoTitle: "Finish research paper",
        todoPriority: "high",
        todoDueDate: "Tomorrow",
      }
    },
    {
      transcript: "Remember that the LoRa nodes need external antennas.",
      intent: "CREATE_NOTE",
      extractedData: {
        noteTitle: "LoRa Antenna Warning",
        noteContent: "The LoRa nodes need external antennas to function without burning the PA.",
        noteTags: "hardware,lora",
      }
    },
    {
      transcript: "What is the weather tomorrow?",
      intent: "QUERY_WEATHER",
      extractedData: {
        weatherQuery: "tomorrow"
      }
    },
    {
      transcript: "Explain how a transistor works.",
      intent: "GENERAL_AI",
      extractedData: {
        generalPrompt: "Explain how a transistor works."
      }
    },
    {
      transcript: "Open my notes.",
      intent: "NAVIGATION",
      extractedData: {
        navigationTarget: "notes"
      }
    }
  ];

  // Select one at random or default based on time to show variation in mock mode
  const index = Math.floor(Date.now() / 1000) % mockOptions.length;
  return mockOptions[index];
}

// For text chat interface
export async function queryLLM(prompt: string): Promise<string> {
  const hasGemini = !!process.env.GEMINI_API_KEY;
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasGroq = !!process.env.GROQ_API_KEY;

  if (hasGemini) {
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const response = await ai.models.generateContent({
        model: "gemini-2.0-flash",
        contents: prompt,
      });
      return response.text || "No response";
    } catch (e) {
      console.error(e);
    }
  }

  if (hasOpenAI) {
    try {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }]
      });
      return completion.choices[0].message.content || "No response";
    } catch (e) {
      console.error(e);
    }
  }

  if (hasGroq) {
    try {
      const openai = new OpenAI({
        apiKey: process.env.GROQ_API_KEY,
        baseURL: "https://api.groq.com/openai/v1",
      });
      const completion = await openai.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }]
      });
      return completion.choices[0].message.content || "No response";
    } catch (e) {
      console.error(e);
    }
  }

  return `Mock response: You asked "${prompt}". Configure GEMINI_API_KEY, OPENAI_API_KEY, or GROQ_API_KEY to receive real AI responses.`;
}
