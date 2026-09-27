"use client";

import React, { useState, useEffect } from "react";
import {
  Brain,
  LayoutDashboard,
  CheckSquare,
  FileText,
  MessageSquare,
  History,
  Settings,
  Battery,
  Wifi,
  Clock,
  Plus,
  Trash2,
  Search,
  Send,
  Bell,
  RefreshCw,
  Calendar,
  Sparkles,
  Cpu,
  Layers,
  Terminal,
  Sliders
} from "lucide-react";
import {
  getDashboardData,
  getTasks,
  getNotes,
  getVoiceHistory,
  createTask,
  toggleTask,
  deleteTask,
  createNote,
  deleteNote,
  sendChatMessage,
  clearVoiceLogs,
  updateDeviceSettings,
  queueDeviceCommand
} from "../actions";

type Tab = "overview" | "todo" | "notes" | "chat" | "history" | "settings";

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<any>(null);
  
  // Lists state
  const [tasks, setTasks] = useState<any[]>([]);
  const [notes, setNotes] = useState<any[]>([]);
  const [voiceLogs, setVoiceLogs] = useState<any[]>([]);

  // Task Form state
  const [taskTitle, setTaskTitle] = useState("");
  const [taskPriority, setTaskPriority] = useState("medium");
  const [taskDueDate, setTaskDueDate] = useState("");

  // Note Form state
  const [noteTitle, setNoteTitle] = useState("");
  const [noteContent, setNoteContent] = useState("");
  const [noteTags, setNoteTags] = useState("");
  const [noteSearch, setNoteSearch] = useState("");
  const [isCreatingNote, setIsCreatingNote] = useState(false);

  // Chat state
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<Array<{ sender: "user" | "ai"; text: string }>>([
    { sender: "ai", text: "Welcome to your Second Brain. Ask me anything, or review your logs." }
  ]);
  const [isChatting, setIsChatting] = useState(false);

  // Device Settings Form state
  const [deviceName, setDeviceName] = useState("");
  const [deviceBrightness, setDeviceBrightness] = useState(100);
  const [deviceLed, setDeviceLed] = useState("rainbow");
  const [deviceDuration, setDeviceDuration] = useState(3);
  const [deviceWifiSsid, setDeviceWifiSsid] = useState("");
  const [deviceWifiPassword, setDeviceWifiPassword] = useState("");

  // Notification Push Form
  const [pushTitle, setPushTitle] = useState("");
  const [pushMessage, setPushMessage] = useState("");
  const [pushSuccess, setPushSuccess] = useState(false);

  // Load all dashboard data
  const loadData = async (showLoading = true) => {
    if (showLoading) setLoading(true);
    try {
      const dbData = await getDashboardData();
      setData(dbData);
      
      const t = await getTasks();
      setTasks(t);

      const n = await getNotes();
      setNotes(n);

      const h = await getVoiceHistory();
      setVoiceLogs(h);

      // Populate settings form from DB device config
      if (dbData && dbData.device) {
        setDeviceName(dbData.device.name || "");
        setDeviceBrightness(dbData.device.brightness || 100);
        setDeviceLed(dbData.device.ledBehavior || "rainbow");
        setDeviceDuration(dbData.device.recordingDuration || 3);
        setDeviceWifiSsid(dbData.device.wifiSsid || "");
        setDeviceWifiPassword(dbData.device.wifiPassword || "");
      }
    } catch (e) {
      console.error(e);
    } finally {
      if (showLoading) setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    // Poll data every 10 seconds for real-time heartbeat/voice log sync
    const interval = setInterval(() => {
      loadData(false);
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  const handleCreateTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!taskTitle.trim()) return;
    const dueDate = taskDueDate ? new Date(taskDueDate) : null;
    const res = await createTask(taskTitle, taskPriority, dueDate);
    if (res.success) {
      setTaskTitle("");
      setTaskDueDate("");
      loadData(false);
    }
  };

  const handleToggleTask = async (id: string, completed: boolean) => {
    const res = await toggleTask(id, completed);
    if (res.success) {
      loadData(false);
    }
  };

  const handleDeleteTask = async (id: string) => {
    const res = await deleteTask(id);
    if (res.success) {
      loadData(false);
    }
  };

  const handleCreateNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!noteTitle.trim()) return;
    const res = await createNote(noteTitle, noteContent, noteTags);
    if (res.success) {
      setNoteTitle("");
      setNoteContent("");
      setNoteTags("");
      setIsCreatingNote(false);
      loadData(false);
    }
  };

  const handleDeleteNote = async (id: string) => {
    const res = await deleteNote(id);
    if (res.success) {
      loadData(false);
    }
  };

  const handleSendChatMessage = async (e?: React.FormEvent, customText?: string) => {
    if (e) e.preventDefault();
    const message = customText || chatInput;
    if (!message.trim()) return;

    setChatMessages(prev => [...prev, { sender: "user", text: message }]);
    if (!customText) setChatInput("");
    setIsChatting(true);

    try {
      const res = await sendChatMessage(message);
      if (res.success && res.reply) {
        setChatMessages(prev => [...prev, { sender: "ai", text: res.reply || "Done" }]);
      } else {
        setChatMessages(prev => [...prev, { sender: "ai", text: "Error connecting to AI." }]);
      }
    } catch (e) {
      setChatMessages(prev => [...prev, { sender: "ai", text: "Failed to generate reply." }]);
    } finally {
      setIsChatting(false);
      loadData(false);
    }
  };

  const handleClearLogs = async () => {
    if (confirm("Are you sure you want to clear all voice history?")) {
      const res = await clearVoiceLogs();
      if (res.success) {
        loadData(false);
      }
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!data?.device?.deviceId) return;
    const res = await updateDeviceSettings(data.device.deviceId, {
      name: deviceName,
      brightness: Number(deviceBrightness),
      ledBehavior: deviceLed,
      recordingDuration: Number(deviceDuration),
      wifiSsid: deviceWifiSsid,
      wifiPassword: deviceWifiPassword,
    });
    if (res.success) {
      alert("Settings saved! Device will sync on its next heartbeat.");
      loadData(false);
    }
  };

  const handlePushNotification = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!data?.device?.deviceId || !pushTitle.trim()) return;
    const res = await queueDeviceCommand(data.device.deviceId, "notification", {
      title: pushTitle,
      message: pushMessage,
    });
    if (res.success) {
      setPushTitle("");
      setPushMessage("");
      setPushSuccess(true);
      setTimeout(() => setPushSuccess(false), 3000);
      loadData(false);
    }
  };

  // Helper relative dates
  const formatDueDate = (dateStr: string) => {
    if (!dateStr) return "";
    const date = new Date(dateStr);
    return date.toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };

  // Filter notes
  const filteredNotes = notes.filter(n =>
    n.title.toLowerCase().includes(noteSearch.toLowerCase()) ||
    n.content.toLowerCase().includes(noteSearch.toLowerCase()) ||
    n.tags.toLowerCase().includes(noteSearch.toLowerCase())
  );

  return (
    <div className="flex-1 flex flex-col md:flex-row min-h-screen text-zinc-100 bg-[#000000]">
      {/* Sidebar Navigation */}
      <aside className="w-full md:w-64 flex flex-col p-6 border-b md:border-b-0 md:border-r border-zinc-800 bg-[#09090b]">
        {/* Logo */}
        <div className="flex items-center gap-3 mb-8">
          <div className="p-2 bg-zinc-800 rounded-lg">
            <Brain className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-tight text-white">
              Second Brain
            </h1>
            <span className="text-[10px] text-zinc-500 block">Agent Companion</span>
          </div>
        </div>

        {/* Navigation Items */}
        <nav className="flex-1 space-y-1">
          {[
            { id: "overview", label: "Overview", icon: LayoutDashboard },
            { id: "todo", label: "Tasks", icon: CheckSquare, badge: tasks.filter(t => !t.completed).length },
            { id: "notes", label: "Notes", icon: FileText, badge: notes.length },
            { id: "chat", label: "AI Chat Link", icon: MessageSquare },
            { id: "history", label: "Voice Index", icon: History, badge: voiceLogs.length },
            { id: "settings", label: "Settings", icon: Settings },
          ].map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id as Tab)}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-lg transition-all text-left text-xs ${
                  active
                    ? "bg-zinc-800 text-white font-medium"
                    : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900"
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <Icon className="w-4 h-4" />
                  <span>{item.label}</span>
                </div>
                {item.badge !== undefined && item.badge > 0 && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded font-medium bg-zinc-900 text-zinc-300 border border-zinc-800">
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Sidebar Footer - Device Status */}
        <div className="mt-auto pt-4 border-t border-zinc-800">
          {data?.device && (
            <div className="p-3 bg-zinc-900/60 rounded-lg border border-zinc-800 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className={`w-2 h-2 rounded-full ${data.device.isOnline ? "bg-emerald-500" : "bg-zinc-600"}`} />
                <div className="text-left">
                  <p className="text-[11px] font-medium text-zinc-200 truncate max-w-[120px]">{data.device.name}</p>
                  <p className="text-[9px] text-zinc-500">
                    {data.device.isOnline ? "Online" : "Offline"} • {data.device.battery >= 0 ? `${data.device.battery}%` : "USB"}
                  </p>
                </div>
              </div>
              <button
                onClick={() => loadData(true)}
                className="p-1 hover:bg-zinc-800 rounded text-zinc-400 hover:text-white transition-colors cursor-pointer"
                title="Refresh Status"
              >
                <RefreshCw className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Main Panel */}
      <main className="flex-1 flex flex-col p-6 md:p-8 overflow-y-auto max-h-screen">
        {/* Header */}
        <header className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-8 pb-4 border-b border-zinc-800">
          <div>
            <h2 className="text-lg font-semibold tracking-tight text-white">
              {activeTab === "overview" && "Dashboard Overview"}
              {activeTab === "todo" && "Tasks Queue"}
              {activeTab === "notes" && "Memory Bank"}
              {activeTab === "chat" && "Neural Assistant Link"}
              {activeTab === "history" && "Voice Interactions"}
              {activeTab === "settings" && "Device Settings"}
            </h2>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-zinc-400 bg-zinc-900 px-3 py-1.5 rounded-lg border border-zinc-800 font-medium">
              {new Date().toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}
            </span>
            <button
              onClick={() => loadData(true)}
              className="cyber-btn-cyan px-3.5 py-1.5 text-xs font-medium flex items-center gap-1.5 shadow-sm"
            >
              <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
              <span>Refresh</span>
            </button>
          </div>
        </header>

        {loading ? (
          <div className="flex-grow flex items-center justify-center min-h-[400px]">
            <div className="text-center space-y-3">
              <RefreshCw className="w-8 h-8 animate-spin text-zinc-400 mx-auto" />
              <p className="text-zinc-500 text-xs font-medium">Updating data...</p>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col gap-6">
            
            {/* OVERVIEW TAB */}
            {activeTab === "overview" && data && (
              <div className="space-y-6">
                {/* Stats row */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
                  {[
                    { label: "Pending Tasks", val: data.stats.pendingTasks, icon: CheckSquare, statusColor: "text-zinc-100" },
                    { label: "Saved Notes", val: data.stats.totalNotes, icon: FileText, statusColor: "text-zinc-100" },
                    { label: "Voice Records", val: data.stats.interactions, icon: Brain, statusColor: "text-zinc-100" },
                  ].map((stat, i) => (
                    <div key={i} className="cyber-card p-5 rounded-xl flex items-center justify-between">
                      <div>
                        <p className="text-xs font-medium text-zinc-400">{stat.label}</p>
                        <p className="text-3xl font-semibold mt-1.5 text-white tracking-tight">{stat.val}</p>
                      </div>
                      <div className="p-3 rounded-lg bg-zinc-800 text-white">
                        <stat.icon className="w-5 h-5" />
                      </div>
                    </div>
                  ))}
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {/* Device Status Card */}
                  <div className="cyber-card p-6 rounded-xl space-y-6">
                    <div className="flex items-center justify-between border-b border-zinc-850 pb-4">
                      <h3 className="text-xs font-semibold text-zinc-200 flex items-center gap-2">
                        <Cpu className="w-4 h-4 text-zinc-400" />
                        Hardware Status
                      </h3>
                      <span className={`px-2 py-0.5 rounded text-[10px] font-medium flex items-center gap-1.5 ${
                        data.device.isOnline
                          ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/25"
                          : "bg-zinc-800 text-zinc-400 border border-zinc-700/30"
                      }`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${data.device.isOnline ? "bg-emerald-500" : "bg-zinc-500"}`} />
                        {data.device.isOnline ? "Connected" : "Offline"}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-4 text-xs">
                      <div>
                        <span className="text-zinc-500 text-[10px] block">Name</span>
                        <p className="font-semibold text-zinc-200 mt-0.5">{data.device.name}</p>
                      </div>
                      <div>
                        <span className="text-zinc-500 text-[10px] block">Device ID</span>
                        <p className="font-mono text-zinc-300 mt-0.5 break-all">{data.device.deviceId}</p>
                      </div>
                      <div className="col-span-2">
                        <span className="text-zinc-500 text-[10px] block mb-1.5">Battery Status</span>
                        <div className="flex items-center gap-3">
                          <Battery className="w-4 h-4 text-zinc-400" />
                          <div className="flex-1 bg-zinc-800 rounded-full h-1.5 overflow-hidden">
                            <div 
                              className="bg-white h-full rounded-full transition-all duration-500" 
                              style={{ width: `${data.device.battery >= 0 ? data.device.battery : 100}%` }}
                            />
                          </div>
                          <span className="text-[10px] font-medium text-zinc-300">
                            {data.device.battery >= 0 ? `${data.device.battery}%` : "USB"}
                          </span>
                        </div>
                      </div>
                      <div>
                        <span className="text-zinc-500 text-[10px] block">Firmware</span>
                        <p className="font-medium text-zinc-300 mt-0.5">v{data.device.firmware}</p>
                      </div>
                      <div>
                        <span className="text-zinc-500 text-[10px] block">WiFi Connection</span>
                        <p className="font-medium text-zinc-300 mt-0.5 truncate" title={data.device.wifiSsid || "None"}>
                          {data.device.wifiSsid || "Disconnected"}
                        </p>
                      </div>
                    </div>

                    {/* Send Notification Command */}
                    <div className="border-t border-zinc-800 pt-5">
                      <h4 className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider mb-4 flex items-center gap-1.5">
                        <Sliders className="w-3.5 h-3.5 text-zinc-500" />
                        Quick Command Payload
                      </h4>
                      <form onSubmit={handlePushNotification} className="space-y-4">
                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-1">
                            <label className="text-[10px] text-zinc-500">Alert Title</label>
                            <input
                              type="text"
                              placeholder="e.g., Reminder"
                              value={pushTitle}
                              onChange={(e) => setPushTitle(e.target.value)}
                              className="w-full cyber-input px-3 py-1.5 text-xs"
                              required
                            />
                          </div>
                          <div className="space-y-1">
                            <label className="text-[10px] text-zinc-500">Message Body</label>
                            <input
                              type="text"
                              placeholder="e.g., Take medication"
                              value={pushMessage}
                              onChange={(e) => setPushMessage(e.target.value)}
                              className="w-full cyber-input px-3 py-1.5 text-xs"
                            />
                          </div>
                        </div>
                        <button
                          type="submit"
                          className="w-full cyber-btn-cyan py-2 text-xs font-semibold flex items-center justify-center gap-1.5"
                        >
                          <Bell className="w-3.5 h-3.5" />
                          <span>Dispatch Alert</span>
                        </button>
                        {pushSuccess && (
                          <p className="text-emerald-400 text-[10px] text-center font-medium mt-1">
                            Command queued. Sent on next heartbeat update.
                          </p>
                        )}
                      </form>
                    </div>
                  </div>

                  {/* Recent Activity */}
                  <div className="cyber-card p-6 rounded-xl flex flex-col min-h-[400px]">
                    <h3 className="text-xs font-semibold text-zinc-200 mb-5 flex items-center gap-2 pb-4 border-b border-zinc-800">
                      <Terminal className="w-4 h-4 text-zinc-400" />
                      Activity Stream
                    </h3>

                    {data.recentInteractions.length === 0 ? (
                      <div className="flex-1 flex flex-col items-center justify-center text-zinc-500">
                        <p className="text-xs">No recent interactions registered.</p>
                      </div>
                    ) : (
                      <div className="flex-1 space-y-4 overflow-y-auto max-h-[360px] pr-1">
                        {data.recentInteractions.map((log: any) => (
                          <div key={log.id} className="p-3.5 bg-zinc-900/40 rounded-lg border border-zinc-800/80 hover:border-zinc-700 transition-colors flex flex-col gap-2">
                            <div className="flex justify-between items-center text-[10px]">
                              <span className="text-zinc-500">
                                {new Date(log.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </span>
                              <span className="text-zinc-400 font-medium tracking-wide">
                                {log.intent}
                              </span>
                            </div>
                            <div className="text-xs">
                              <p className="text-zinc-400">
                                <span className="font-semibold text-zinc-300">Transcript:</span> "{log.transcript}"
                              </p>
                              {log.response && (
                                <div className="text-zinc-300 mt-1.5 bg-zinc-900/60 p-2 rounded text-[11px] leading-relaxed whitespace-pre-wrap border border-zinc-800">
                                  {log.response}
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* TO-DO TAB */}
            {activeTab === "todo" && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
                {/* Form column */}
                <div className="cyber-card p-6 rounded-xl space-y-5">
                  <h3 className="text-xs font-semibold text-zinc-200 flex items-center gap-2 border-b border-zinc-800 pb-3">
                    <Plus className="w-4 h-4" />
                    Create Task
                  </h3>
                  <form onSubmit={handleCreateTask} className="space-y-4">
                    <div className="space-y-1.5">
                      <label className="text-[10px] text-zinc-400">Task Title</label>
                      <input
                        type="text"
                        placeholder="e.g., Calibration check..."
                        value={taskTitle}
                        onChange={(e) => setTaskTitle(e.target.value)}
                        className="w-full cyber-input px-3.5 py-2 text-xs"
                        required
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[10px] text-zinc-400">Priority</label>
                      <select
                        value={taskPriority}
                        onChange={(e) => setTaskPriority(e.target.value)}
                        className="w-full cyber-input px-3 py-2 text-xs cursor-pointer"
                      >
                        <option value="low" className="bg-[#1c1c1e]">Low</option>
                        <option value="medium" className="bg-[#1c1c1e]">Medium</option>
                        <option value="high" className="bg-[#1c1c1e]">High</option>
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[10px] text-zinc-400">Due Date</label>
                      <input
                        type="datetime-local"
                        value={taskDueDate}
                        onChange={(e) => setTaskDueDate(e.target.value)}
                        className="w-full cyber-input px-3 py-2 text-xs"
                      />
                    </div>
                    <button
                      type="submit"
                      className="w-full cyber-btn-cyan py-2.5 text-xs font-semibold"
                    >
                      Save Task
                    </button>
                  </form>
                </div>

                {/* List column */}
                <div className="cyber-card p-6 rounded-xl lg:col-span-2 space-y-6">
                  {tasks.length === 0 ? (
                    <div className="py-16 text-center text-zinc-500">
                      <CheckSquare className="w-10 h-10 mx-auto opacity-30 mb-3" />
                      <p className="text-xs">No tasks queued.</p>
                    </div>
                  ) : (
                    <div className="space-y-6">
                      {/* Pending Tasks */}
                      <div>
                        <h4 className="text-xs font-semibold text-zinc-400 mb-4 flex items-center gap-1.5">
                          <Layers className="w-3.5 h-3.5" />
                          Active ({tasks.filter(t => !t.completed).length})
                        </h4>
                        <div className="space-y-3.5">
                          {tasks.filter(t => !t.completed).map((task) => (
                            <div key={task.id} className="flex items-center justify-between p-3.5 bg-zinc-900/30 rounded-lg border border-zinc-800/80 hover:border-zinc-700 transition-colors">
                              <div className="flex items-center gap-3.5">
                                <input
                                  type="checkbox"
                                  checked={task.completed}
                                  onChange={(e) => handleToggleTask(task.id, e.target.checked)}
                                  className="cyber-checkbox"
                                />
                                <div>
                                  <p className="text-xs font-medium text-zinc-100">{task.title}</p>
                                  {task.dueDate && (
                                    <p className="text-[10px] text-zinc-500 flex items-center gap-1 mt-0.5">
                                      <Calendar className="w-3 h-3 text-zinc-600" />
                                      {formatDueDate(task.dueDate)}
                                    </p>
                                  )}
                                </div>
                              </div>
                              <div className="flex items-center gap-3">
                                <span className={`text-[10px] px-2 py-0.5 rounded font-medium border uppercase tracking-wider ${
                                  task.priority === "high" ? "bg-red-500/10 text-red-400 border-red-500/20" :
                                  task.priority === "medium" ? "bg-amber-500/10 text-amber-400 border-amber-500/20" :
                                  "bg-zinc-800 text-zinc-400 border-zinc-700/20"
                                }`}>
                                  {task.priority}
                                </span>
                                <button
                                  onClick={() => handleDeleteTask(task.id)}
                                  className="p-1 hover:bg-zinc-800 rounded text-zinc-500 hover:text-red-400 transition-colors cursor-pointer"
                                  title="Delete Task"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Completed Tasks */}
                      {tasks.filter(t => t.completed).length > 0 && (
                        <div className="border-t border-zinc-850 pt-5">
                          <h4 className="text-xs font-semibold text-zinc-500 mb-4">
                            Completed
                          </h4>
                          <div className="space-y-2">
                            {tasks.filter(t => t.completed).map((task) => (
                              <div key={task.id} className="flex items-center justify-between p-3 bg-zinc-950/20 rounded-lg border border-zinc-800 opacity-60 hover:opacity-90 transition-opacity">
                                <div className="flex items-center gap-3">
                                  <input
                                    type="checkbox"
                                    checked={task.completed}
                                    onChange={(e) => handleToggleTask(task.id, e.target.checked)}
                                    className="cyber-checkbox"
                                  />
                                  <p className="text-xs text-zinc-400 line-through">{task.title}</p>
                                </div>
                                <button
                                  onClick={() => handleDeleteTask(task.id)}
                                  className="p-1 hover:bg-zinc-800 rounded text-zinc-600 hover:text-red-400 transition-colors cursor-pointer"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* NOTES TAB */}
            {activeTab === "notes" && (
              <div className="space-y-6">
                {/* Controls bar */}
                <div className="flex flex-col sm:flex-row gap-4 items-center justify-between border-b border-zinc-850 pb-5">
                  <div className="relative w-full sm:w-80">
                    <Search className="absolute left-3 top-2.5 w-3.5 h-3.5 text-zinc-500" />
                    <input
                      type="text"
                      placeholder="Search notes..."
                      value={noteSearch}
                      onChange={(e) => setNoteSearch(e.target.value)}
                      className="w-full cyber-input pl-9 pr-4 py-2 text-xs"
                    />
                  </div>
                  <button
                    onClick={() => setIsCreatingNote(!isCreatingNote)}
                    className="w-full sm:w-auto cyber-btn-purple px-4 py-2 text-xs font-semibold flex items-center justify-center gap-1.5"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Create Note</span>
                  </button>
                </div>

                {/* Create Note Card */}
                {isCreatingNote && (
                  <div className="cyber-card p-6 rounded-xl max-w-xl">
                    <h3 className="text-xs font-semibold text-zinc-200 mb-4 flex items-center gap-2 border-b border-zinc-800 pb-3">
                      <Plus className="w-4 h-4" />
                      Create New Note
                    </h3>
                    <form onSubmit={handleCreateNote} className="space-y-4">
                      <div className="space-y-1.5">
                        <label className="text-[10px] text-zinc-400">Title</label>
                        <input
                          type="text"
                          placeholder="e.g., Schematic pin definitions"
                          value={noteTitle}
                          onChange={(e) => setNoteTitle(e.target.value)}
                          className="w-full cyber-input px-3.5 py-2 text-xs"
                          required
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[10px] text-zinc-400">Content</label>
                        <textarea
                          placeholder="Note details..."
                          value={noteContent}
                          onChange={(e) => setNoteContent(e.target.value)}
                          rows={4}
                          className="w-full cyber-input px-3.5 py-2 text-xs"
                          required
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[10px] text-zinc-400">Tags (Comma-separated)</label>
                        <input
                          type="text"
                          placeholder="hardware, schematic, test"
                          value={noteTags}
                          onChange={(e) => setNoteTags(e.target.value)}
                          className="w-full cyber-input px-3.5 py-2 text-xs"
                        />
                      </div>
                      <div className="flex gap-3 justify-end pt-2">
                        <button
                          type="button"
                          onClick={() => setIsCreatingNote(false)}
                          className="cyber-btn-stealth px-3.5 py-1.5 text-xs font-semibold"
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          className="cyber-btn-purple px-4 py-1.5 text-xs font-semibold"
                        >
                          Save
                        </button>
                      </div>
                    </form>
                  </div>
                )}

                {/* Notes Grid */}
                {filteredNotes.length === 0 ? (
                  <div className="py-16 cyber-card rounded-xl text-center text-zinc-500">
                    <FileText className="w-10 h-10 mx-auto opacity-30 mb-3" />
                    <p className="text-xs">No notes found.</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                    {filteredNotes.map((note) => (
                      <div key={note.id} className="cyber-card p-5 rounded-xl flex flex-col justify-between group">
                        <div className="space-y-3">
                          <div className="flex justify-between items-start">
                            <h4 className="font-semibold text-zinc-200 text-sm group-hover:text-white transition-colors">{note.title}</h4>
                            <button
                              onClick={() => handleDeleteNote(note.id)}
                              className="p-1 text-zinc-600 hover:text-red-400 hover:bg-zinc-800 rounded transition-all opacity-0 group-hover:opacity-100 cursor-pointer"
                              title="Delete Note"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                          <p className="text-xs text-zinc-400 leading-relaxed whitespace-pre-wrap">{note.content}</p>
                        </div>
                        <div className="mt-5 pt-3.5 border-t border-zinc-850 flex flex-wrap gap-1.5 items-center justify-between text-[9px] text-zinc-500">
                          <div className="flex flex-wrap gap-1">
                            {note.tags.split(",").filter(Boolean).map((t: string, i: number) => (
                              <span key={i} className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700/30">
                                #{t.trim()}
                              </span>
                            ))}
                          </div>
                          <span>
                            {new Date(note.createdAt).toLocaleDateString([], { month: "short", day: "numeric" })}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* AI CHAT TAB */}
            {activeTab === "chat" && (
              <div className="flex-grow flex flex-col cyber-card rounded-xl overflow-hidden h-[600px] bg-zinc-950/20">
                {/* Chat header */}
                <div className="px-6 py-4 border-b border-zinc-850 bg-zinc-900/20 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-zinc-300">
                    <Sparkles className="w-4 h-4" />
                    <span className="text-xs font-semibold">Assistant Chat Link</span>
                  </div>
                  <span className="text-[10px] text-zinc-400 px-2 py-0.5 rounded border border-zinc-850 bg-zinc-900/60 font-mono">
                    Model: Gemini-2.0
                  </span>
                </div>

                {/* Messages log */}
                <div className="flex-1 overflow-y-auto p-6 space-y-4">
                  {chatMessages.map((msg, i) => (
                    <div key={i} className={`flex ${msg.sender === "user" ? "justify-end" : "justify-start"}`}>
                      <div className={`max-w-[75%] p-3.5 rounded-xl text-xs leading-relaxed ${
                        msg.sender === "user"
                          ? "bg-zinc-800 text-white rounded-tr-none border border-zinc-700/30"
                          : "bg-zinc-900/60 text-zinc-300 rounded-tl-none border border-zinc-800/80"
                      }`}>
                        {msg.sender === "ai" && (
                          <div className="text-[9px] text-zinc-500 font-bold mb-1 uppercase tracking-wider">
                            Second Brain AI
                          </div>
                        )}
                        {msg.text}
                      </div>
                    </div>
                  ))}
                  {isChatting && (
                    <div className="flex justify-start">
                      <div className="bg-zinc-900/60 text-zinc-500 border border-zinc-800 rounded-xl rounded-tl-none p-3.5 text-xs flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                        <span className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                        <span className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                        <span className="text-[10px]">Thinking...</span>
                      </div>
                    </div>
                  )}
                </div>

                {/* Prompt suggestions */}
                <div className="px-6 py-3 bg-zinc-900/20 border-t border-zinc-850 flex gap-2 overflow-x-auto select-none">
                  {[
                    "Configure ESP32 deep sleep states",
                    "Add task 'Calibrate analog sensors'",
                    "Save schematic details to my notes"
                  ].map((sug, i) => (
                    <button
                      key={i}
                      onClick={(e) => handleSendChatMessage(undefined, sug)}
                      disabled={isChatting}
                      className="text-[10px] px-3 py-1.5 rounded-lg border border-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors whitespace-nowrap cursor-pointer disabled:opacity-50"
                    >
                      {sug}
                    </button>
                  ))}
                </div>

                {/* Chat Input form */}
                <form onSubmit={handleSendChatMessage} className="p-4 border-t border-zinc-850 bg-zinc-900/20 flex gap-3">
                  <input
                    type="text"
                    placeholder={isChatting ? "Signal processing..." : "Ask your assistant..."}
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    disabled={isChatting}
                    className="flex-1 cyber-input px-4 py-2.5 text-xs"
                  />
                  <button
                    type="submit"
                    disabled={isChatting || !chatInput.trim()}
                    className="cyber-btn-cyan p-2.5 rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Send className="w-4 h-4" />
                  </button>
                </form>
              </div>
            )}

            {/* VOICE HISTORY TAB */}
            {activeTab === "history" && (
              <div className="cyber-card p-6 rounded-xl space-y-6">
                <div className="flex justify-between items-center pb-4 border-b border-zinc-850">
                  <h3 className="text-xs font-semibold text-zinc-200 flex items-center gap-2">
                    <History className="w-4 h-4 text-zinc-400" />
                    Voice Transcript logs
                  </h3>
                  {voiceLogs.length > 0 && (
                    <button
                      onClick={handleClearLogs}
                      className="px-3.5 py-1.5 border border-zinc-800 hover:bg-zinc-900 hover:text-red-400 text-zinc-400 rounded-lg text-xs font-medium transition-colors cursor-pointer"
                    >
                      Clear Registry
                    </button>
                  )}
                </div>

                {voiceLogs.length === 0 ? (
                  <div className="py-20 text-center text-zinc-500">
                    <History className="w-10 h-10 mx-auto opacity-30 mb-3" />
                    <p className="text-xs">No transcripts recorded.</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {voiceLogs.map((log) => (
                      <div key={log.id} className="p-4 bg-zinc-900/20 rounded-lg border border-zinc-800 hover:border-zinc-700 transition-colors text-xs flex flex-col gap-2">
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-850 pb-2">
                          <div className="flex items-center gap-2 text-zinc-500 text-[10px]">
                            <span>{new Date(log.createdAt).toLocaleString()}</span>
                            <span>•</span>
                            <span className="font-mono">Device: {log.deviceId}</span>
                          </div>
                          <span className="px-2 py-0.5 rounded text-[9px] font-medium border bg-zinc-800 text-zinc-300 border-zinc-700/30">
                            {log.intent}
                          </span>
                        </div>
                        <p className="text-zinc-300 font-medium">
                          &gt; "{log.transcript}"
                        </p>
                        {log.response && (
                          <div className="text-zinc-400 text-[11px] bg-zinc-900/40 p-2.5 rounded border border-zinc-850 mt-1 whitespace-pre-wrap leading-relaxed">
                            {log.response}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* SETTINGS TAB */}
            {activeTab === "settings" && (
              <div className="cyber-card p-6 rounded-xl max-w-2xl space-y-6">
                <h3 className="text-xs font-semibold text-zinc-200 mb-4 flex items-center gap-2 border-b border-zinc-800 pb-4">
                  <Settings className="w-4 h-4 text-zinc-400" />
                  Configuration Panel
                </h3>
                <form onSubmit={handleSaveSettings} className="space-y-6">
                  
                  {/* General Config */}
                  <div className="space-y-4">
                    <h4 className="text-xs font-semibold text-zinc-400">
                      [01] Device Metadata
                    </h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <label className="text-[10px] text-zinc-400">Device Name</label>
                        <input
                          type="text"
                          value={deviceName}
                          onChange={(e) => setDeviceName(e.target.value)}
                          className="w-full cyber-input px-3.5 py-2 text-xs"
                          required
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[10px] text-zinc-400">Voice Record Duration (seconds)</label>
                        <input
                          type="number"
                          value={deviceDuration}
                          onChange={(e) => setDeviceDuration(Number(e.target.value))}
                          className="w-full cyber-input px-3.5 py-2 text-xs font-mono"
                          min={2}
                          max={30}
                        />
                      </div>
                    </div>
                  </div>

                  {/* UI Settings */}
                  <div className="space-y-4 border-t border-zinc-850 pt-5">
                    <h4 className="text-xs font-semibold text-zinc-400">
                      [02] Hardware Indicator Settings
                    </h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <label className="text-[10px] text-zinc-400">Status LED Mode</label>
                        <select
                          value={deviceLed}
                          onChange={(e) => setDeviceLed(e.target.value)}
                          className="w-full cyber-input px-3 py-2 text-xs cursor-pointer"
                        >
                          <option value="rainbow" className="bg-[#1c1c1e]">Rainbow Chroma</option>
                          <option value="pulse_blue" className="bg-[#1c1c1e]">Pulse Blue (Listening)</option>
                          <option value="pulse_yellow" className="bg-[#1c1c1e]">Pulse Yellow (Processing)</option>
                          <option value="solid_green" className="bg-[#1c1c1e]">Solid Green (Active)</option>
                          <option value="off" className="bg-[#1c1c1e]">Stealth (Off)</option>
                        </select>
                      </div>
                      <div className="space-y-1.5 flex flex-col justify-center">
                        <div className="flex justify-between text-[10px] text-zinc-400 mb-1.5">
                          <span>Screen Brightness</span>
                          <span className="font-semibold text-white">{deviceBrightness}%</span>
                        </div>
                        <input
                          type="range"
                          value={deviceBrightness}
                          onChange={(e) => setDeviceBrightness(Number(e.target.value))}
                          min={10}
                          max={100}
                          className="w-full h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-white"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Network settings */}
                  <div className="space-y-4 border-t border-zinc-850 pt-5">
                    <h4 className="text-xs font-semibold text-zinc-400">
                      [03] Local WiFi Configuration
                    </h4>
                    <p className="text-[10px] text-zinc-500">
                      If these credentials are changed here, the wearable device will sync and connect to the new SSID on the next heartbeat.
                    </p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <label className="text-[10px] text-zinc-400">WiFi SSID</label>
                        <input
                          type="text"
                          value={deviceWifiSsid}
                          onChange={(e) => setDeviceWifiSsid(e.target.value)}
                          className="w-full cyber-input px-3.5 py-2 text-xs"
                          placeholder="Enter SSID"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[10px] text-zinc-400">WiFi Password</label>
                        <input
                          type="password"
                          value={deviceWifiPassword}
                          onChange={(e) => setDeviceWifiPassword(e.target.value)}
                          className="w-full cyber-input px-3.5 py-2 text-xs"
                          placeholder="Enter Passkey"
                        />
                      </div>
                    </div>
                  </div>

                  <button
                    type="submit"
                    className="w-full cyber-btn-cyan py-3 text-xs font-semibold"
                  >
                    Sync Device Parameters
                  </button>
                </form>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
