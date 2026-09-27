import React, { useState } from "react";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView, Text, TouchableOpacity, View } from "react-native";
import { AppProvider } from "./src/store";
import { C } from "./src/ui";
import ServerScreen from "./src/screens/ServerScreen";
import TasksScreen from "./src/screens/TasksScreen";
import NotesScreen from "./src/screens/NotesScreen";
import VoiceScreen from "./src/screens/VoiceScreen";
import SettingsScreen from "./src/screens/SettingsScreen";

const TABS = [
  { id: "server", label: "Server", el: <ServerScreen /> },
  { id: "tasks", label: "Tasks", el: <TasksScreen /> },
  { id: "notes", label: "Notes", el: <NotesScreen /> },
  { id: "voice", label: "Voice", el: <VoiceScreen /> },
  { id: "settings", label: "Settings", el: <SettingsScreen /> },
];

export default function App() {
  const [tab, setTab] = useState("server");
  const active = TABS.find((t) => t.id === tab) ?? TABS[0];
  return (
    <AppProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <StatusBar style="light" />
        <View style={{ flex: 1 }}>{active.el}</View>
        <View
          style={{
            flexDirection: "row",
            borderTopWidth: 1,
            borderTopColor: C.border,
            backgroundColor: C.card,
          }}
        >
          {TABS.map((t) => (
            <TouchableOpacity
              key={t.id}
              onPress={() => setTab(t.id)}
              style={{ flex: 1, paddingVertical: 14, alignItems: "center" }}
            >
              <Text
                style={{
                  color: t.id === tab ? C.accent : C.faint,
                  fontWeight: t.id === tab ? "700" : "400",
                  fontSize: 12,
                }}
              >
                {t.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </SafeAreaView>
    </AppProvider>
  );
}
