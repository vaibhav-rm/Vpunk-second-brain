import React, { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useApp } from "../store";
import { Btn, C, Tag, s, Spacer } from "../ui";
import { countNotes, countOpenTasks, getActiveDevice, listVoice } from "../db";

export default function ServerScreen() {
  const { running, starting, port, serverIp, wifiIpHint, logs, startServer, stopServer, refreshKey } =
    useApp();
  const [stats, setStats] = useState({ tasks: 0, notes: 0, voice: 0, online: false });

  useEffect(() => {
    let live = true;
    (async () => {
      const [tasks, notes, voice, dev] = await Promise.all([
        countOpenTasks(),
        countNotes(),
        listVoice(1000).then((v) => v.length),
        getActiveDevice(),
      ]);
      if (!live) return;
      const online = dev ? Date.now() - dev.lastHeartbeat < 45000 && dev.status === "online" : false;
      setStats({ tasks, notes, voice, online });
    })();
    return () => {
      live = false;
    };
  }, [refreshKey, running, logs.length]);

  return (
    <ScrollView style={s.screen}>
      <Text style={s.h1}>Second Brain Server</Text>
      <Text style={s.body}>
        Phone-hosted replacement for the laptop backend. Turn on your hotspot, point the device at the
        IP below, keep this app in the foreground.
      </Text>
      <Spacer />
      <View style={s.card}>
        <View style={[s.row, { justifyContent: "space-between" }]}>
          <Text style={s.h2}>Status</Text>
          <Tag text={running ? "RUNNING" : "STOPPED"} color={running ? C.green : C.faint} />
        </View>
        <Text style={s.mono}>
          {serverIp}:{port}
        </Text>
        {wifiIpHint ? <Text style={s.body}>Phone WiFi IP (station mode): {wifiIpHint}</Text> : null}
        <Text style={s.body}>
          Device: {stats.online ? "online" : "offline"} · {stats.tasks} open tasks ·{" "}
          {stats.notes} notes · {stats.voice} voice logs
        </Text>
        {running ? (
          <Btn title="Stop server" onPress={stopServer} color={C.red} />
        ) : (
          <Btn title={starting ? "Starting…" : "Start server"} onPress={startServer} disabled={starting} />
        )}
      </View>
      <View style={s.card}>
        <Text style={s.h2}>Request log</Text>
        {logs.length === 0 ? (
          <Text style={s.body}>No traffic yet. Start the server and press a device button.</Text>
        ) : (
          logs.slice(-30).reverse().map((l, i) => (
            <Text key={`${i}-${l}`} style={s.mono}>
              {l}
            </Text>
          ))
        )}
      </View>
    </ScrollView>
  );
}
