import React, { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useApp } from "../store";
import { Btn, Field, s, Spacer } from "../ui";
import { loadKeys, saveKeys, type ApiKeys } from "../keys";
import {
  ensureAppDevice,
  queueCommand,
  updateDeviceSettings,
  type DeviceRow,
} from "../db";

const LED_MODES = ["rainbow", "pulse_blue", "pulse_yellow", "solid_green", "off"];

export default function SettingsScreen() {
  const { refresh, log, serverIp, setServerIp, port, setPort } = useApp();
  const [keys, setKeys] = useState<ApiKeys>({
    groqKey: "", openaiKey: "", openaiBase: "", openaiModel: "", geminiKey: "",
  });
  const [dev, setDev] = useState<DeviceRow | null>(null);
  const [name, setName] = useState("");
  const [brightness, setBrightness] = useState("100");
  const [led, setLed] = useState("rainbow");
  const [recDur, setRecDur] = useState("3");
  const [ssid, setSsid] = useState("");
  const [pass, setPass] = useState("");
  const [ip, setIp] = useState(serverIp);
  const [portStr, setPortStr] = useState(String(port));

  useEffect(() => {
    (async () => {
      setKeys(await loadKeys());
      const d = await ensureAppDevice();
      setDev(d);
      setName(d.name);
      setBrightness(String(d.brightness));
      setLed(d.ledBehavior);
      setRecDur(String(d.recordingDuration));
      setSsid(d.wifiSsid);
      setPass(d.wifiPassword);
    })();
  }, []);

  const saveApiKeys = async () => {
    await saveKeys(keys);
    log("[APP] API keys saved");
  };

  const saveDevice = async () => {
    if (!dev) return;
    const rec = Math.max(2, Math.min(30, parseInt(recDur, 10) || 3));
    const br = Math.max(0, Math.min(100, parseInt(brightness, 10) || 100));
    const updated = await updateDeviceSettings(dev.deviceId, {
      name: name.trim() || dev.name,
      brightness: br,
      ledBehavior: LED_MODES.includes(led) ? led : "rainbow",
      recordingDuration: rec,
      wifiSsid: ssid,
      wifiPassword: pass,
    });
    if (updated) setDev(updated);
    // Nudge a live device to re-read settings on next heartbeat
    await queueCommand(dev.deviceId, "settings_updated", {});
    log("[APP] device settings saved (sync on next heartbeat)");
    refresh();
  };

  const saveServer = () => {
    setServerIp(ip.trim() || "192.168.43.1");
    const p = parseInt(portStr, 10);
    if (p > 0 && p < 65536) setPort(p);
    log("[APP] server address saved — restart server to apply");
  };

  const set = (k: keyof ApiKeys) => (v: string) =>
    setKeys((prev) => ({ ...prev, [k]: v }));

  return (
    <ScrollView style={s.screen}>
      <Text style={s.h1}>Settings</Text>

      <View style={s.card}>
        <Text style={s.h2}>Server address</Text>
        <Text style={s.body}>
          The IP the device connects to. Android hotspot is usually 192.168.43.1. Restart the server
          after changing.
        </Text>
        <Field label="SERVER IP" value={ip} onChangeText={setIp} placeholder="192.168.43.1" />
        <Field label="PORT" value={portStr} onChangeText={setPortStr} placeholder="3000" numeric />
        <Btn title="Save server address" onPress={saveServer} />
      </View>

      <View style={s.card}>
        <Text style={s.h2}>AI providers (stored securely on-device)</Text>
        <Text style={s.body}>Groq = speech-to-text + fast answers. At least one STT key is required.</Text>
        <Field label="GROQ_API_KEY (STT, free)" value={keys.groqKey} onChangeText={set("groqKey")} secure placeholder="gsk_…" />
        <Field label="OPENAI_API_KEY (proxy)" value={keys.openaiKey} onChangeText={set("openaiKey")} secure placeholder="sk-…" />
        <Field label="OPENAI_BASE_URL" value={keys.openaiBase} onChangeText={set("openaiBase")} placeholder="https://api.hcnsec.cn/v1" />
        <Field label="OPENAI_MODEL" value={keys.openaiModel} onChangeText={set("openaiModel")} placeholder="DeepSeek-V4-Flash" />
        <Field label="GEMINI_API_KEY (fallback)" value={keys.geminiKey} onChangeText={set("geminiKey")} secure placeholder="AIza…" />
        <Btn title="Save API keys" onPress={saveApiKeys} />
      </View>

      <View style={s.card}>
        <Text style={s.h2}>Device</Text>
        <Field label="NAME" value={name} onChangeText={setName} />
        <Field label="BRIGHTNESS (0-100)" value={brightness} onChangeText={setBrightness} numeric />
        <Field label="LED MODE (rainbow, pulse_blue, pulse_yellow, solid_green, off)" value={led} onChangeText={setLed} />
        <Field label="RECORD SECONDS (2-30)" value={recDur} onChangeText={setRecDur} numeric />
        <Field label="WIFI SSID (pushed on heartbeat)" value={ssid} onChangeText={setSsid} />
        <Field label="WIFI PASSWORD" value={pass} onChangeText={setPass} secure />
        <Btn title="Save device settings" onPress={saveDevice} />
      </View>
      <Spacer h={24} />
    </ScrollView>
  );
}
