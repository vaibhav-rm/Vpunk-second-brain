// Shared app state: HTTP server lifecycle, log ring, settings, and a
// refresh counter screens bump to reload SQLite data after mutations.

import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import NetInfo from "@react-native-community/netinfo";
import { startHttpServer, type RunningServer } from "./http";
import { handleDeviceRequest } from "./routes";
import { ensureAppDevice, kvGet, kvSet, type DeviceRow } from "./db";

interface AppState {
  running: boolean;
  starting: boolean;
  port: number;
  setPort: (p: number) => void;
  serverIp: string;
  setServerIp: (ip: string) => void;
  wifiIpHint: string;
  logs: string[];
  device: DeviceRow | null;
  refreshKey: number;
  startServer: () => Promise<void>;
  stopServer: () => void;
  refresh: () => void;
  log: (line: string) => void;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useApp outside provider");
  return ctx;
}

const stamp = () => {
  const d = new Date();
  const p = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [port, setPortState] = useState(3000);
  const [serverIp, setServerIpState] = useState("192.168.43.1");
  const [wifiIpHint, setWifiIpHint] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [device, setDevice] = useState<DeviceRow | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const serverRef = useRef<RunningServer | null>(null);

  const log = useCallback((line: string) => {
    const stamped = `[${stamp()}] ${line}`;
    console.log(stamped);
    setLogs((prev) => [...prev.slice(-199), stamped]);
  }, []);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const setPort = useCallback(
    (p: number) => {
      setPortState(p);
      void kvSet("server.port", String(p));
    },
    []
  );

  const setServerIp = useCallback(
    (ip: string) => {
      setServerIpState(ip);
      void kvSet("server.ip", ip);
    },
    []
  );

  const startServer = useCallback(async () => {
    if (serverRef.current || starting) return;
    setStarting(true);
    try {
      const [savedPort, savedIp, dev] = await Promise.all([
        kvGet("server.port", "3000"),
        kvGet("server.ip", "192.168.43.1"),
        ensureAppDevice(),
      ]);
      const p = parseInt(savedPort, 10) || 3000;
      setPortState(p);
      setServerIpState(savedIp);
      setDevice(dev);
      try {
        const net = await NetInfo.fetch();
        const details: any = net.details;
        setWifiIpHint(details?.ipAddress || "");
      } catch {
        setWifiIpHint("");
      }
      const pushLog = (line: string) => {
        const stamped = `[${stamp()}] ${line}`;
        console.log(stamped);
        setLogs((prev) => [...prev.slice(-199), stamped]);
      };
      serverRef.current = startHttpServer(
        p,
        handleDeviceRequest,
        pushLog,
        pushLog
      );
      setRunning(true);
      pushLog(`[APP] Second Brain server up — point the device at ${savedIp}:${p}`);
    } catch (e) {
      log(`[APP] start failed: ${(e as Error)?.message || e}`);
    } finally {
      setStarting(false);
    }
  }, [starting, log]);

  const stopServer = useCallback(() => {
    serverRef.current?.stop();
    serverRef.current = null;
    setRunning(false);
  }, []);

  const value = useMemo<AppState>(
    () => ({
      running, starting, port, setPort, serverIp, setServerIp, wifiIpHint,
      logs, device, refreshKey, startServer, stopServer, refresh, log,
    }),
    [running, starting, port, setPort, serverIp, setServerIp, wifiIpHint,
      logs, device, refreshKey, startServer, stopServer, refresh, log]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
