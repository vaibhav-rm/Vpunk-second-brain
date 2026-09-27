// SQLite store mirroring prisma/schema.prisma (Device, Task, Note,
// VoiceInteraction, CommandQueue) plus a tiny kv table for app settings
// (server IP/port, wifi defaults). Uses expo-sqlite (no native-query dep).

import * as SQLite from "expo-sqlite";

export interface DeviceRow {
  id: string;
  deviceId: string;
  name: string;
  token: string;
  battery: number;
  firmware: string;
  lastHeartbeat: number; // epoch ms
  status: string;
  brightness: number;
  ledBehavior: string;
  recordingDuration: number;
  wifiSsid: string;
  wifiPassword: string;
}

export interface TaskRow {
  id: string;
  title: string;
  completed: number; // 0/1
  dueDate: number | null;
  priority: string;
  createdAt: number;
}

export interface NoteRow {
  id: string;
  title: string;
  content: string;
  tags: string;
  createdAt: number;
}

export interface VoiceRow {
  id: string;
  deviceId: string;
  transcript: string;
  response: string;
  intent: string;
  createdAt: number;
}

export interface CommandRow {
  id: string;
  deviceId: string;
  command: string;
  payload: string;
  processed: number; // 0/1
  createdAt: number;
}

import { uuid } from "./fmt";

let db: SQLite.SQLiteDatabase | null = null;

export async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (db) return db;
  db = await SQLite.openDatabaseAsync("second-brain.db");
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      deviceId TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      token TEXT NOT NULL,
      battery INTEGER DEFAULT -1,
      firmware TEXT DEFAULT '0.1.0',
      lastHeartbeat INTEGER DEFAULT 0,
      status TEXT DEFAULT 'offline',
      brightness INTEGER DEFAULT 100,
      ledBehavior TEXT DEFAULT 'rainbow',
      recordingDuration INTEGER DEFAULT 3,
      wifiSsid TEXT DEFAULT '',
      wifiPassword TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      completed INTEGER DEFAULT 0,
      dueDate INTEGER,
      priority TEXT DEFAULT 'medium',
      createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT DEFAULT '',
      createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS voice_interactions (
      id TEXT PRIMARY KEY,
      deviceId TEXT NOT NULL,
      transcript TEXT NOT NULL,
      response TEXT NOT NULL,
      intent TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS command_queue (
      id TEXT PRIMARY KEY,
      deviceId TEXT NOT NULL,
      command TEXT NOT NULL,
      payload TEXT NOT NULL,
      processed INTEGER DEFAULT 0,
      createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

// ---------- kv (app settings) ----------

export async function kvGet(key: string, fallback = ""): Promise<string> {
  const d = await getDb();
  const row = await d.getFirstAsync<{ value: string }>(
    "SELECT value FROM kv WHERE key = ?",
    [key]
  );
  return row ? row.value : fallback;
}

export async function kvSet(key: string, value: string): Promise<void> {
  const d = await getDb();
  await d.runAsync(
    "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value]
  );
}

// ---------- devices ----------

const newToken = () =>
  Math.random().toString(36).substring(2) + Date.now().toString(36);

export async function registerDevice(
  deviceId: string,
  name?: string
): Promise<DeviceRow> {
  const d = await getDb();
  const now = Date.now();
  const existing = await d.getFirstAsync<DeviceRow>(
    "SELECT * FROM devices WHERE deviceId = ?",
    [deviceId]
  );
  if (existing) {
    await d.runAsync(
      "UPDATE devices SET status = 'online', lastHeartbeat = ? WHERE deviceId = ?",
      [now, deviceId]
    );
    return { ...existing, status: "online", lastHeartbeat: now };
  }
  const row: DeviceRow = {
    id: uuid(),
    deviceId,
    name: name || `Second Brain #${deviceId.slice(-4)}`,
    token: newToken(),
    battery: -1,
    firmware: "0.1.0",
    lastHeartbeat: now,
    status: "online",
    brightness: 100,
    ledBehavior: "rainbow",
    recordingDuration: 3,
    wifiSsid: "",
    wifiPassword: "",
  };
  await d.runAsync(
    `INSERT INTO devices (id, deviceId, name, token, battery, firmware,
      lastHeartbeat, status, brightness, ledBehavior, recordingDuration,
      wifiSsid, wifiPassword)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id, row.deviceId, row.name, row.token, row.battery, row.firmware,
      row.lastHeartbeat, row.status, row.brightness, row.ledBehavior,
      row.recordingDuration, row.wifiSsid, row.wifiPassword,
    ]
  );
  return row;
}

export async function getDevice(deviceId: string): Promise<DeviceRow | null> {
  const d = await getDb();
  return await d.getFirstAsync<DeviceRow>(
    "SELECT * FROM devices WHERE deviceId = ?",
    [deviceId]
  );
}

export async function getActiveDevice(): Promise<DeviceRow | null> {
  const d = await getDb();
  return await d.getFirstAsync<DeviceRow>(
    "SELECT * FROM devices ORDER BY lastHeartbeat DESC LIMIT 1"
  );
}

export async function heartbeatDevice(
  deviceId: string,
  battery?: number,
  firmware?: string
): Promise<DeviceRow> {
  const d = await getDb();
  const now = Date.now();
  let dev = await getDevice(deviceId);
  if (!dev) {
    dev = await registerDevice(deviceId);
  }
  await d.runAsync(
    "UPDATE devices SET battery = ?, firmware = ?, status = 'online', lastHeartbeat = ? WHERE deviceId = ?",
    [
      battery !== undefined ? battery : dev.battery,
      firmware || dev.firmware,
      now,
      deviceId,
    ]
  );
  return (await getDevice(deviceId)) as DeviceRow;
}

export interface DeviceSettings {
  name?: string;
  brightness?: number;
  ledBehavior?: string;
  recordingDuration?: number;
  wifiSsid?: string;
  wifiPassword?: string;
}

export async function updateDeviceSettings(
  deviceId: string,
  s: DeviceSettings
): Promise<DeviceRow | null> {
  const d = await getDb();
  const dev = await getDevice(deviceId);
  if (!dev) return null;
  await d.runAsync(
    `UPDATE devices SET
      name = ?, brightness = ?, ledBehavior = ?, recordingDuration = ?,
      wifiSsid = ?, wifiPassword = ? WHERE deviceId = ?`,
    [
      s.name ?? dev.name,
      s.brightness ?? dev.brightness,
      s.ledBehavior ?? dev.ledBehavior,
      s.recordingDuration ?? dev.recordingDuration,
      s.wifiSsid ?? dev.wifiSsid,
      s.wifiPassword ?? dev.wifiPassword,
      deviceId,
    ]
  );
  return await getDevice(deviceId);
}

export async function ensureAppDevice(): Promise<DeviceRow> {
  // The phone app edits this row in Settings; heartbeats sync it to hardware.
  const d = await getDb();
  const existing = await getActiveDevice();
  if (existing) return existing;
  return await registerDevice("second-brain-001", "Second Brain C6 Wearable");
}

// ---------- tasks ----------

export async function listTasks(openOnly = false): Promise<TaskRow[]> {
  const d = await getDb();
  return await d.getAllAsync<TaskRow>(
    openOnly
      ? "SELECT * FROM tasks WHERE completed = 0 ORDER BY createdAt DESC"
      : "SELECT * FROM tasks ORDER BY completed ASC, createdAt DESC"
  );
}

export async function countOpenTasks(): Promise<number> {
  const d = await getDb();
  const row = await d.getFirstAsync<{ n: number }>(
    "SELECT COUNT(*) AS n FROM tasks WHERE completed = 0"
  );
  return row ? row.n : 0;
}

export async function createTask(
  title: string,
  priority = "medium",
  dueDate: number | null = null
): Promise<TaskRow> {
  const d = await getDb();
  const row: TaskRow = {
    id: uuid(),
    title,
    completed: 0,
    dueDate,
    priority,
    createdAt: Date.now(),
  };
  await d.runAsync(
    "INSERT INTO tasks (id, title, completed, dueDate, priority, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
    [row.id, row.title, 0, row.dueDate, row.priority, row.createdAt]
  );
  return row;
}

export async function toggleTask(id: string, completed: boolean): Promise<void> {
  const d = await getDb();
  await d.runAsync("UPDATE tasks SET completed = ? WHERE id = ?", [
    completed ? 1 : 0,
    id,
  ]);
}

export async function deleteTask(id: string): Promise<void> {
  const d = await getDb();
  await d.runAsync("DELETE FROM tasks WHERE id = ?", [id]);
}

// ---------- notes ----------

export async function listNotes(limit = 50): Promise<NoteRow[]> {
  const d = await getDb();
  return await d.getAllAsync<NoteRow>(
    "SELECT * FROM notes ORDER BY createdAt DESC LIMIT ?",
    [limit]
  );
}

export async function countNotes(): Promise<number> {
  const d = await getDb();
  const row = await d.getFirstAsync<{ n: number }>(
    "SELECT COUNT(*) AS n FROM notes"
  );
  return row ? row.n : 0;
}

export async function createNote(
  title: string,
  content: string,
  tags = ""
): Promise<NoteRow> {
  const d = await getDb();
  const row: NoteRow = {
    id: uuid(),
    title,
    content,
    tags,
    createdAt: Date.now(),
  };
  await d.runAsync(
    "INSERT INTO notes (id, title, content, tags, createdAt) VALUES (?, ?, ?, ?, ?)",
    [row.id, row.title, row.content, row.tags, row.createdAt]
  );
  return row;
}

export async function deleteNote(id: string): Promise<void> {
  const d = await getDb();
  await d.runAsync("DELETE FROM notes WHERE id = ?", [id]);
}

// ---------- voice log ----------

export async function logVoice(
  deviceId: string,
  transcript: string,
  response: string,
  intent: string
): Promise<void> {
  const d = await getDb();
  await d.runAsync(
    "INSERT INTO voice_interactions (id, deviceId, transcript, response, intent, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
    [uuid(), deviceId, transcript, response, intent, Date.now()]
  );
}

export async function listVoice(limit = 50): Promise<VoiceRow[]> {
  const d = await getDb();
  return await d.getAllAsync<VoiceRow>(
    "SELECT * FROM voice_interactions ORDER BY createdAt DESC LIMIT ?",
    [limit]
  );
}

export async function clearVoice(): Promise<void> {
  const d = await getDb();
  await d.runAsync("DELETE FROM voice_interactions");
}

// ---------- command queue (dashboard/app -> device) ----------

export async function queueCommand(
  deviceId: string,
  command: string,
  payload: unknown
): Promise<void> {
  const d = await getDb();
  await d.runAsync(
    "INSERT INTO command_queue (id, deviceId, command, payload, processed, createdAt) VALUES (?, ?, ?, ?, 0, ?)",
    [uuid(), deviceId, command, JSON.stringify(payload), Date.now()]
  );
}

export async function takePendingCommand(
  deviceId: string
): Promise<CommandRow | null> {
  const d = await getDb();
  const row = await d.getFirstAsync<CommandRow>(
    "SELECT * FROM command_queue WHERE deviceId = ? AND processed = 0 ORDER BY createdAt ASC LIMIT 1",
    [deviceId]
  );
  if (!row) return null;
  await d.runAsync("UPDATE command_queue SET processed = 1 WHERE id = ?", [
    row.id,
  ]);
  return row;
}
