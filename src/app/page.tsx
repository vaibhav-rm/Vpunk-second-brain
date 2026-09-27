"use client";

import React, { useState, useEffect, useRef } from "react";
import Link from "next/link";
import {
  Brain,
  Cpu,
  Layers,
  Wifi,
  Battery,
  Terminal,
  CheckSquare,
  FileText,
  History,
  Sparkles,
  ArrowRight,
  ArrowUpRight,
  ChevronRight,
  Database,
  Mic,
  Play,
  Activity,
  Sliders,
  Check,
  RefreshCw,
  Bell,
  Code
} from "lucide-react";
import { simulateTextCommand } from "./actions";

type SimState = "idle" | "listening" | "processing" | "success" | "error";

export default function LandingPage() {
  // Simulator State
  const [simState, setSimState] = useState<SimState>("idle");
  const [oledLine1, setOledLine1] = useState("WIFI ONLINE");
  const [oledLine2, setOledLine2] = useState("IP: 192.168.0.114");
  const [oledLine3, setOledLine3] = useState("Agent: 192.168.0.114:3000");
  const [oledLine4, setOledLine4] = useState("Press ACTION to record");
  const [inputText, setInputText] = useState("");
  const [consoleLogs, setConsoleLogs] = useState<string[]>([
    "[SYS] Second Brain OS v0.1.0 loaded.",
    "[WIFI] Auto-connecting to Sri Krishna Pg 41 SSID...",
    "[WIFI] Connected successfully. IP: 192.168.0.114",
    "[HTTP] Registered device 'second-brain-001' on Next.js server.",
    "[I2S] INMP441 Microphone initialized. 16kHz 16-bit Mono Mono-PCM.",
    "[SYS] System idle. Press ACTION button on device to stream."
  ]);
  const [recProgress, setRecProgress] = useState(0);
  const [recTime, setRecTime] = useState(0);
  const [activePreset, setActivePreset] = useState<string>("");
  const [notification, setNotification] = useState<string | null>(null);

  const consoleEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll simulator logs
  useEffect(() => {
    if (consoleEndRef.current) {
      consoleEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [consoleLogs]);

  const addLog = (log: string) => {
    setConsoleLogs((prev) => [...prev, log]);
  };

  // Preset prompts
  const presets = [
    { label: "Create Task", text: "Add task finish schematic documentation for next week" },
    { label: "Save Note", text: "Remember that status LED is connected to ESP32 Pin 8" },
    { label: "Query Weather", text: "What is the weather today?" },
    { label: "Query Clock", text: "What time is it?" },
    { label: "General AI Ask", text: "Explain how I2S digital audio differs from analog ADC microphone" }
  ];

  // Simulator Main Logic
  const startRecording = () => {
    if (simState !== "idle") return;
    
    setSimState("listening");
    setRecProgress(0);
    setRecTime(0);
    addLog(`[I2S] ACTION button pressed. Allocated voice buffer (160KB).`);
    addLog(`[RECORD] Capture stream started. Capturing Mono-PCM...`);
    
    setOledLine1("RECORDING VOICE...");
    setOledLine2("Capture: 0.0s / 5s");
    setOledLine3("");
    setOledLine4("Release / Type below");
  };

  // Simulate progress of recording
  useEffect(() => {
    let interval: any;
    if (simState === "listening") {
      const start = Date.now();
      interval = setInterval(() => {
        const elapsed = (Date.now() - start) / 1000;
        const percent = Math.min((elapsed / 5) * 100, 100);
        setRecProgress(percent);
        setRecTime(elapsed);
        
        setOledLine2(`Capture: ${elapsed.toFixed(1)}s / 5s`);
        
        if (elapsed >= 5) {
          clearInterval(interval);
          submitRecording();
        }
      }, 100);
    }
    return () => clearInterval(interval);
  }, [simState]);

  const submitRecording = async (customPrompt?: string) => {
    const promptToSubmit = customPrompt || inputText.trim() || "Add task Calibrate analog I2S sensors";
    
    setSimState("processing");
    setInputText("");
    addLog(`[RECORD] Stopped. Captured 160000 bytes.`);
    addLog(`[UPLOAD] Transmitting 160KB WAV stream to HTTP POST /api/device/voice...`);
    
    setOledLine1("UPLOADING...");
    setOledLine2("Transmitting wave file");
    setOledLine3("to Agent Server...");
    setOledLine4("");

    try {
      addLog(`[API] Processing payload on Next.js server...`);
      const response = await simulateTextCommand(promptToSubmit);
      
      if (response.success && response.response !== undefined && response.transcript !== undefined) {
        setSimState("success");
        addLog(`[API] Success! Intent: ${response.intent}`);
        addLog(`[DB] Database side-effects synced.`);
        addLog(`[SYS] Server response: "${response.response.replace(/\n/g, " | ")}"`);
        
        // Show structured response on virtual screen
        setOledLine1("AGENT RESPONSE");
        // Truncate transcript to fit virtual OLED width
        const truncTranscript = response.transcript.length > 18 
          ? response.transcript.substring(0, 15) + "..."
          : response.transcript;
        setOledLine2(`T: "${truncTranscript}"`);
        
        // Render response line
        const respLines = response.response.split("\n").filter(Boolean);
        setOledLine3(respLines[0] || "");
        setOledLine4(respLines[1] || "✓ Action Complete");

        // Trigger landing page notification badge
        let typeBadge = "Interaction";
        if (response.intent === "CREATE_TODO") typeBadge = "Task added to Dashboard";
        if (response.intent === "CREATE_NOTE") typeBadge = "Note saved to Memory Bank";
        setNotification(`✓ ${typeBadge}`);
        setTimeout(() => setNotification(null), 5000);

        // Reset to idle after 5 seconds
        setTimeout(() => {
          resetSimulator();
        }, 5000);

      } else {
        throw new Error(response.error || "Unknown api error");
      }
    } catch (err: any) {
      setSimState("error");
      addLog(`[HTTP] Error sending WAV data: 500 Internal Error`);
      setOledLine1("UPLOAD ERROR");
      setOledLine2("Server error 500");
      setOledLine3("Retry again");
      setOledLine4("");
      
      setTimeout(() => {
        resetSimulator();
      }, 4000);
    }
  };

  const resetSimulator = () => {
    setSimState("idle");
    setOledLine1("WIFI ONLINE");
    setOledLine2("IP: 192.168.29.8");
    setOledLine3("Agent: 192.168.29.8:3000");
    setOledLine4("Press ACTION to record");
    addLog(`[SYS] Idle. Ready for next command.`);
  };

  const handleSelectPreset = (presetText: string) => {
    setInputText(presetText);
    setActivePreset(presetText);
    addLog(`[SYS] Preset loaded: "${presetText}"`);
  };

  return (
    <div className="min-h-screen bg-black text-zinc-100 flex flex-col font-sans selection:bg-zinc-800 selection:text-white">
      {/* Background Gradient Orbs */}
      <div className="absolute top-0 left-1/4 w-[500px] h-[500px] bg-purple-950/20 rounded-full blur-[120px] pointer-events-none -z-10" />
      <div className="absolute top-[20%] right-1/4 w-[600px] h-[600px] bg-cyan-950/15 rounded-full blur-[140px] pointer-events-none -z-10" />

      {/* Header */}
      <header className="max-w-7xl mx-auto w-full px-6 py-6 flex items-center justify-between border-b border-zinc-900 bg-black/50 backdrop-blur-md sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-zinc-900 rounded-xl border border-zinc-800">
            <Brain className="w-5 h-5 text-white" />
          </div>
          <div>
            <span className="font-semibold text-sm tracking-tight text-white block">SECOND BRAIN</span>
            <span className="text-[10px] text-zinc-500 font-mono tracking-widest uppercase block">ESP32-C6 Companion</span>
          </div>
        </div>
        <nav className="hidden md:flex items-center gap-8 text-xs font-medium text-zinc-400">
          <a href="#simulator" className="hover:text-white transition-colors">Interactive Simulator</a>
          <a href="#features" className="hover:text-white transition-colors">Features</a>
          <a href="#hardware" className="hover:text-white transition-colors">Hardware Specs</a>
          <a href="/docs/index.html" target="_blank" className="hover:text-white transition-colors flex items-center gap-1">
            Documentation <ArrowUpRight className="w-3 h-3" />
          </a>
        </nav>
        <div className="flex items-center gap-3">
          <Link href="/dashboard" className="px-4 py-2 bg-white text-black hover:bg-zinc-200 transition-all font-semibold rounded-lg text-xs flex items-center gap-1.5 shadow-sm">
            <span>Enter Dashboard</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </header>

      {/* Hero Section */}
      <section className="max-w-7xl mx-auto w-full px-6 pt-16 md:pt-28 pb-20 grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
        <div className="lg:col-span-7 space-y-6 text-left">
          <div className="inline-flex items-center gap-2 px-3 py-1 bg-zinc-900/80 rounded-full border border-zinc-800 text-[10px] font-semibold text-zinc-300 uppercase tracking-widest">
            <Sparkles className="w-3.5 h-3.5 text-yellow-500" />
            <span>AI Wearable IoT Project</span>
          </div>
          <h1 className="text-4xl sm:text-6xl font-bold tracking-tight text-white leading-[1.1] max-w-2xl">
            Wearable intelligence that lives in your loop.
          </h1>
          <p className="text-sm sm:text-base text-zinc-400 max-w-xl leading-relaxed">
            Second Brain is a hardware wearable powered by the ESP32-C6. Record tasks, dictate notes, query real-time weather details, and chat with your memory log seamlessly through a Next.js local cognitive server.
          </p>
          <div className="flex flex-wrap gap-4 pt-4">
            <a href="#simulator" className="px-5 py-3 bg-zinc-900 border border-zinc-800 hover:border-zinc-700 transition-all font-semibold rounded-lg text-xs text-white flex items-center gap-2">
              <Play className="w-3.5 h-3.5 text-zinc-400" />
              <span>Launch Simulator</span>
            </a>
            <a href="/docs/index.html" target="_blank" className="px-5 py-3 border border-zinc-900 hover:bg-zinc-950 transition-all font-semibold rounded-lg text-xs text-zinc-400 hover:text-white flex items-center gap-1.5">
              <span>Read Flashing Guide</span>
              <ArrowUpRight className="w-3.5 h-3.5" />
            </a>
          </div>

          {/* Stats Bar */}
          <div className="grid grid-cols-3 gap-6 pt-10 border-t border-zinc-900 max-w-lg">
            <div>
              <span className="text-2xl font-semibold text-white font-mono">16 kHz</span>
              <span className="text-[10px] text-zinc-500 block uppercase tracking-wider mt-1">Audio Sampling</span>
            </div>
            <div>
              <span className="text-2xl font-semibold text-white font-mono">10s</span>
              <span className="text-[10px] text-zinc-500 block uppercase tracking-wider mt-1">Sync Heartbeat</span>
            </div>
            <div>
              <span className="text-2xl font-semibold text-white font-mono">85%</span>
              <span className="text-[10px] text-zinc-500 block uppercase tracking-wider mt-1">Less CPU Overhead</span>
            </div>
          </div>
        </div>

        {/* Hero Visual Card (Device Close-up Mockup) */}
        <div className="lg:col-span-5 flex justify-center">
          <div className="relative group w-full max-w-[340px]">
            {/* Ambient Backlight */}
            <div className="absolute -inset-1 bg-gradient-to-r from-purple-600 to-cyan-500 rounded-3xl blur opacity-25 group-hover:opacity-40 transition duration-1000" />
            <div className="relative bg-[#09090b] border border-zinc-850 p-6 rounded-2xl shadow-2xl flex flex-col items-center">
              <div className="w-full flex justify-between items-center mb-6">
                <span className="text-[10px] font-mono text-zinc-500">SB-001 // UNIT DEPLOYED</span>
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              </div>
              
              {/* Virtual OLED Display Frame */}
              <div className="w-full aspect-[2/1] bg-black border-2 border-zinc-800 p-2.5 rounded-lg flex flex-col font-mono text-[9px] text-cyan-400 select-none shadow-inner mb-6">
                <div className="flex justify-between border-b border-cyan-900 pb-1 mb-1 text-[8px] text-cyan-500">
                  <span>SECOND BRAIN</span>
                  <div className="flex gap-1 items-center">
                    <Wifi className="w-2.5 h-2.5" />
                    <Battery className="w-2.5 h-2.5" />
                  </div>
                </div>
                <div>STATUS: ONLINE</div>
                <div>IP: 192.168.29.8</div>
                <div className="text-zinc-500 mt-2">&gt; Press ACTION to stream</div>
              </div>

              {/* NeoPixel LED Indicator */}
              <div className="w-4 h-4 rounded-full bg-purple-500 shadow-[0_0_12px_rgba(168,85,247,0.7)] animate-pulse mb-8" />

              {/* Hardware tactile grid */}
              <div className="w-full grid grid-cols-3 gap-3">
                <div className="py-2.5 bg-zinc-900 border border-zinc-800 rounded-lg text-center text-[10px] text-zinc-400 font-mono select-none">UP</div>
                <div className="py-2.5 bg-zinc-800 border border-zinc-700 text-white font-semibold rounded-lg text-center text-[10px] font-mono select-none shadow-sm cursor-pointer hover:bg-zinc-750 active:scale-95 transition-all">ACTION</div>
                <div className="py-2.5 bg-zinc-900 border border-zinc-800 rounded-lg text-center text-[10px] text-zinc-400 font-mono select-none">DOWN</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Interactive Simulator Section */}
      <section id="simulator" className="border-t border-zinc-900 bg-zinc-950/20 py-20">
        <div className="max-w-7xl mx-auto px-6">
          <div className="text-center max-w-2xl mx-auto space-y-3 mb-16">
            <h2 className="text-2xl sm:text-4xl font-bold tracking-tight text-white">Interactive Device Simulator</h2>
            <p className="text-xs sm:text-sm text-zinc-400 leading-relaxed">
              Don't have the hardware assembled yet? Test the entire intent pipeline here. Interact with the virtual ESP32 device to create tasks, save notes, and run AI queries in your local database.
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
            {/* Column 1: The Virtual Device */}
            <div className="lg:col-span-5 flex justify-center items-center">
              <div className="relative w-full max-w-[340px] aspect-[4/6] bg-[#0c0c0e] border-2 border-zinc-850 p-6 rounded-[32px] flex flex-col items-center justify-between shadow-2xl">
                
                {/* Metallic Case Accents */}
                <div className="absolute top-4 left-6 right-6 h-0.5 bg-zinc-800/40 rounded-full" />
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 w-16 h-1 bg-zinc-800/60 rounded-full" />
                
                {/* Shell Header */}
                <div className="w-full flex justify-between items-center text-[9px] font-mono text-zinc-600 mt-2">
                  <span>ESP32-C6 COMPANION</span>
                  <span className="flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-zinc-700" />
                    <span>LORA ACTIVE</span>
                  </span>
                </div>

                {/* virtual OLED Screen */}
                <div className="w-full aspect-[128/64] bg-black border-[3px] border-zinc-800 p-3 rounded-xl flex flex-col justify-between font-mono text-[9.5px] text-sky-400 select-none shadow-inner leading-tight relative overflow-hidden">
                  {/* Screen Glare Overlay */}
                  <div className="absolute inset-0 bg-gradient-to-tr from-transparent via-white/5 to-white/10 pointer-events-none" />
                  
                  {/* Screen Header */}
                  <div className="flex justify-between border-b border-sky-900/60 pb-1 mb-1 text-[8.5px] text-sky-500 font-bold">
                    <span>SECOND BRAIN // OS</span>
                    <div className="flex gap-1.5 items-center">
                      <Wifi className="w-2.5 h-2.5" />
                      <Battery className="w-2.5 h-2.5" />
                    </div>
                  </div>

                  {/* Dynamic OLED lines */}
                  <div className="flex-1 flex flex-col justify-center space-y-1">
                    <div className="flex items-center gap-1">
                      <span className="text-sky-500 font-bold">STATUS:</span>
                      <span className="text-white truncate">{oledLine1}</span>
                    </div>
                    <div className="text-sky-300/90 truncate">{oledLine2}</div>
                    <div className="text-sky-300/90 truncate">{oledLine3}</div>
                    <div className="text-zinc-500/80 truncate text-[9px]">{oledLine4}</div>
                  </div>

                  {/* Simulated screen progress bar (only during recording) */}
                  {simState === "listening" && (
                    <div className="w-full h-1 bg-zinc-900 rounded-full overflow-hidden mt-1.5">
                      <div className="bg-sky-400 h-full rounded-full transition-all duration-100" style={{ width: `${recProgress}%` }} />
                    </div>
                  )}
                </div>

                {/* Status Indicator LED (NeoPixel RGB) */}
                <div className="flex flex-col items-center gap-1.5">
                  <div className={`w-3.5 h-3.5 rounded-full transition-all duration-300 ${
                    simState === "idle" ? "bg-purple-500 shadow-[0_0_14px_rgba(168,85,247,0.8)] animate-pulse" :
                    simState === "listening" ? "bg-red-500 shadow-[0_0_14px_rgba(239,68,68,0.9)] animate-ping" :
                    simState === "processing" ? "bg-amber-400 shadow-[0_0_14px_rgba(251,191,36,0.9)] animate-pulse" :
                    simState === "success" ? "bg-emerald-500 shadow-[0_0_14px_rgba(16,185,129,0.95)]" :
                    "bg-red-600 shadow-[0_0_14px_rgba(220,38,38,0.95)]"
                  }`} />
                  <span className="text-[7.5px] font-mono text-zinc-500 uppercase tracking-widest">RGB STATUS</span>
                </div>

                {/* Tactile Controls Grid */}
                <div className="w-full space-y-3 mb-2">
                  <div className="w-full grid grid-cols-3 gap-3">
                    <button 
                      disabled={simState !== "idle"} 
                      onClick={() => addLog(`[SYS] Button UP pressed.`)}
                      className="py-3 bg-zinc-900 border border-zinc-800 text-zinc-500 font-mono text-[9px] rounded-xl hover:bg-zinc-850 active:scale-95 transition-all select-none disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      UP
                    </button>
                    <button 
                      onClick={startRecording}
                      disabled={simState !== "idle"}
                      className={`col-span-1 py-3 font-mono text-[9.5px] rounded-xl font-bold transition-all select-none shadow-md ${
                        simState === "idle" 
                          ? "bg-zinc-100 text-black hover:bg-zinc-200 active:scale-95 cursor-pointer" 
                          : "bg-zinc-850 text-zinc-500 cursor-not-allowed opacity-50"
                      }`}
                    >
                      ACTION
                    </button>
                    <button 
                      disabled={simState !== "idle"}
                      onClick={() => addLog(`[SYS] Button DOWN pressed.`)}
                      className="py-3 bg-zinc-900 border border-zinc-800 text-zinc-500 font-mono text-[9px] rounded-xl hover:bg-zinc-850 active:scale-95 transition-all select-none disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      DOWN
                    </button>
                  </div>
                  <div className="text-center">
                    <span className="text-[9px] text-zinc-500 font-mono">
                      {simState === "idle" && "Click ACTION to simulate dictation"}
                      {simState === "listening" && "Capturing simulated audio..."}
                      {simState === "processing" && "Processing neural intent..."}
                      {simState === "success" && "Command completed successfully!"}
                      {simState === "error" && "Error processing request."}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Column 2: Terminal Control Panel */}
            <div className="lg:col-span-7 flex flex-col justify-between cyber-card rounded-2xl p-6 relative">
              
              {/* Floating Notification Badge */}
              {notification && (
                <div className="absolute top-4 right-4 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 animate-bounce shadow-md">
                  <Check className="w-3.5 h-3.5" />
                  <span>{notification}</span>
                </div>
              )}

              <div className="space-y-6">
                <div>
                  <h3 className="text-sm font-semibold text-zinc-200 mb-1 flex items-center gap-2">
                    <Terminal className="w-4 h-4 text-zinc-400" />
                    Tactile Input Console
                  </h3>
                  <p className="text-[11px] text-zinc-500 leading-relaxed">
                    Type a message that simulates a voice command sent from the INMP441 microphone module.
                  </p>
                </div>

                {/* Preset Suggestions */}
                <div className="space-y-2">
                  <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold block">Presets (Click to load)</span>
                  <div className="flex flex-wrap gap-2">
                    {presets.map((preset, i) => (
                      <button
                        key={i}
                        disabled={simState !== "idle"}
                        onClick={() => handleSelectPreset(preset.text)}
                        className={`text-[10px] px-3 py-1.5 rounded-lg border transition-all cursor-pointer ${
                          inputText === preset.text 
                            ? "bg-white text-black border-white font-medium"
                            : "border-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-900"
                        } disabled:opacity-50`}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Input Text Box */}
                <form 
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (simState === "idle" && inputText.trim()) {
                      startRecording();
                      // Auto trigger submission in 1 sec
                      setTimeout(() => {
                        submitRecording(inputText);
                      }, 1000);
                    }
                  }} 
                  className="space-y-3"
                >
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="e.g., Add task calibrate analog sensors tomorrow at 10am"
                      value={inputText}
                      onChange={(e) => setInputText(e.target.value)}
                      disabled={simState !== "idle"}
                      className="flex-1 cyber-input px-4 py-2.5 text-xs font-mono disabled:opacity-50"
                    />
                    <button
                      type="submit"
                      disabled={simState !== "idle" || !inputText.trim()}
                      className="cyber-btn-cyan px-4 py-2.5 text-xs font-semibold flex items-center gap-1.5 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Mic className="w-3.5 h-3.5" />
                      <span>Transmit</span>
                    </button>
                  </div>
                </form>

                {/* Debug Logger Console */}
                <div className="space-y-2">
                  <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold block">Hardware Diagnostic Logs</span>
                  <div className="w-full h-44 bg-black border border-zinc-900 rounded-xl p-3.5 font-mono text-[10px] text-zinc-400 overflow-y-auto space-y-1.5 leading-normal">
                    {consoleLogs.map((log, index) => (
                      <div key={index} className="flex gap-2">
                        <span className="text-zinc-600 select-none">[{index}]</span>
                        <span className={
                          log.includes("[SYS]") ? "text-purple-400" :
                          log.includes("[WIFI]") ? "text-sky-400" :
                          log.includes("[RECORD]") ? "text-red-400" :
                          log.includes("[UPLOAD]") ? "text-amber-400" :
                          log.includes("[API]") ? "text-emerald-400" : "text-zinc-300"
                        }>
                          {log}
                        </span>
                      </div>
                    ))}
                    <div ref={consoleEndRef} />
                  </div>
                </div>
              </div>

              {/* Simulator Action Helper Footer */}
              <div className="border-t border-zinc-900 pt-4 mt-6 flex justify-between items-center text-[10px] text-zinc-500">
                <div className="flex items-center gap-1.5">
                  <Sliders className="w-3.5 h-3.5 text-zinc-400" />
                  <span>Target Simulator Endpoint: <code className="font-mono text-zinc-300">simulateTextCommand()</code></span>
                </div>
                <Link href="/dashboard" className="text-white font-medium hover:underline flex items-center gap-1">
                  View Database Dashboard <ArrowRight className="w-3 h-3" />
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features Tour */}
      <section id="features" className="max-w-7xl mx-auto px-6 py-24 space-y-20">
        <div className="text-center max-w-2xl mx-auto space-y-3">
          <h2 className="text-2xl sm:text-4xl font-bold tracking-tight text-white">System Capabilities</h2>
          <p className="text-xs sm:text-sm text-zinc-400 leading-relaxed">
            Second Brain integrates advanced signal capture, hardware optimizations, and local AI agent reasoning.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {[
            {
              title: "I2S Audio Pipeline",
              desc: "Digital audio capture bypassing noisy analog ADCs. Streams 16000Hz 16-bit Mono Mono-PCM WAV streams directly via HTTP packets.",
              icon: Mic,
              color: "text-red-400"
            },
            {
              title: "Structured Side-effects",
              desc: "Automated intent extraction classifies commands to create Tasks (to-do queues), write Notes (memory banks), display Weather reports, or trigger AI conversations.",
              icon: Database,
              color: "text-purple-400"
            },
            {
              title: "NVS Parameters & Heartbeats",
              desc: "Synchronizes device properties such as LED behaviors, display brightness, and WiFi SSIDs through automated 10-second heartbeat check-ins.",
              icon: Activity,
              color: "text-sky-400"
            }
          ].map((feat, i) => {
            const Icon = feat.icon;
            return (
              <div key={i} className="cyber-card p-6 rounded-2xl space-y-4 hover:border-zinc-800">
                <div className="p-3 bg-zinc-900 rounded-xl w-fit border border-zinc-850">
                  <Icon className={`w-5 h-5 ${feat.color}`} />
                </div>
                <h3 className="text-sm font-semibold text-white">{feat.title}</h3>
                <p className="text-xs text-zinc-400 leading-relaxed">{feat.desc}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* Hardware BOM Specifications Section */}
      <section id="hardware" className="border-t border-zinc-900 bg-zinc-950/10 py-24">
        <div className="max-w-7xl mx-auto px-6 grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
          <div className="lg:col-span-5 space-y-6">
            <h2 className="text-2xl sm:text-4xl font-bold tracking-tight text-white leading-tight">Hardware Specification & BOM</h2>
            <p className="text-xs sm:text-sm text-zinc-400 leading-relaxed">
              Designed around the ultra-small ESP32-C6 RISC-V SoC. Low power footprint, onboard RGB LED, and small enough to wear as a pendant or clip.
            </p>
            <div className="space-y-4 pt-2">
              {[
                "ESP32-C6 Super Mini Dev Board",
                "INMP441 Omnidirectional I2S Mic",
                "SSD1306 0.96\" 128x64 I2C OLED Display",
                "Tactile Buttons (Up, Action, Down)",
                "WS2812B Status NeoPixel LED"
              ].map((item, i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="w-5 h-5 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center text-[10px] font-mono text-zinc-400">
                    {i + 1}
                  </div>
                  <span className="text-xs text-zinc-300 font-medium">{item}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="lg:col-span-7 cyber-card rounded-2xl p-6 bg-zinc-950/20">
            <h3 className="text-sm font-semibold text-zinc-200 mb-4 flex items-center gap-2 border-b border-zinc-900 pb-3">
              <Cpu className="w-4 h-4 text-zinc-400" />
              ESP32-C6 GPIO Pin Mappings
            </h3>
            
            <div className="overflow-x-auto">
              <table className="w-full text-left font-mono text-xs border-collapse">
                <thead>
                  <tr className="border-b border-zinc-900 text-zinc-500">
                    <th className="py-2.5 px-3">Peripheral</th>
                    <th className="py-2.5 px-3">Signal</th>
                    <th className="py-2.5 px-3">GPIO Pin</th>
                    <th className="py-2.5 px-3">Type</th>
                  </tr>
                </thead>
                <tbody className="text-zinc-300 divide-y divide-zinc-900/60">
                  {[
                    { component: "OLED SSD1306", signal: "SDA", pin: "GPIO 6", type: "I2C Data" },
                    { component: "OLED SSD1306", signal: "SCL", pin: "GPIO 7", type: "I2C Clock" },
                    { component: "INMP441 Microphone", signal: "SCK", pin: "GPIO 4", type: "I2S Serial Clock" },
                    { component: "INMP441 Microphone", signal: "WS", pin: "GPIO 5", type: "I2S Word Select" },
                    { component: "INMP441 Microphone", signal: "SD", pin: "GPIO 20", type: "I2S Serial Data" },
                    { component: "WS2812B RGB LED", signal: "DI", pin: "GPIO 8", type: "NeoPixel Signal" },
                    { component: "Control Button", signal: "UP", pin: "GPIO 0", type: "Tactile Input (PULLUP)" },
                    { component: "Control Button", signal: "ACTION", pin: "GPIO 1", type: "Tactile Input (PULLUP)" },
                    { component: "Control Button", signal: "DOWN", pin: "GPIO 2", type: "Tactile Input (PULLUP)" }
                  ].map((row, idx) => (
                    <tr key={idx} className="hover:bg-zinc-900/20">
                      <td className="py-2.5 px-3 text-zinc-400 font-semibold">{row.component}</td>
                      <td className="py-2.5 px-3 text-sky-400">{row.signal}</td>
                      <td className="py-2.5 px-3 text-white font-bold">{row.pin}</td>
                      <td className="py-2.5 px-3 text-zinc-500">{row.type}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="max-w-7xl mx-auto w-full px-6 py-12 border-t border-zinc-900 mt-auto flex flex-col md:flex-row justify-between items-center gap-6 text-xs text-zinc-500">
        <div className="flex items-center gap-2">
          <Brain className="w-4 h-4 text-zinc-400" />
          <span>Second Brain Wearable Suite • Developed by Vaibhav Rathod</span>
        </div>
        <div className="flex items-center gap-6">
          <Link href="/dashboard" className="hover:text-white transition-colors">Dashboard</Link>
          <a href="/docs/index.html" target="_blank" className="hover:text-white transition-colors">Documentation</a>
          <span className="text-zinc-700">|</span>
          <span className="text-[10px] font-mono bg-zinc-900 px-2 py-0.5 rounded border border-zinc-800 text-zinc-400">Firmware v0.1.0</span>
        </div>
      </footer>
    </div>
  );
}
