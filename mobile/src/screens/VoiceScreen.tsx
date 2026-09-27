import React, { useEffect, useState } from "react";
import { FlatList, Text, View } from "react-native";
import { useApp } from "../store";
import { Btn, C, Field, Tag, s, Spacer } from "../ui";
import { clearVoice, listVoice, logVoice, type VoiceRow } from "../db";
import { loadKeys } from "../keys";
import { queryLLM } from "../ai";

export default function VoiceScreen() {
  const { refreshKey, refresh } = useApp();
  const [items, setItems] = useState<VoiceRow[]>([]);
  const [prompt, setPrompt] = useState("");
  const [asking, setAsking] = useState(false);

  const reload = async () => setItems(await listVoice());
  useEffect(() => {
    void reload();
  }, [refreshKey]);

  const ask = async () => {
    const q = prompt.trim();
    if (!q || asking) return;
    setAsking(true);
    try {
      const keys = await loadKeys();
      const reply = await queryLLM(q, keys, { context: true });
      await logVoice("app-chat", q, reply, "GENERAL_AI");
      setPrompt("");
      await reload();
      refresh();
    } finally {
      setAsking(false);
    }
  };

  return (
    <View style={s.screen}>
      <Text style={s.h1}>Voice & AI</Text>
      <View style={s.card}>
        <Field label="ASK AI (FULL-LENGTH, APP ONLY)" value={prompt} onChangeText={setPrompt} placeholder="Ask anything…" />
        <Btn title={asking ? "Thinking…" : "Ask"} onPress={ask} disabled={asking} />
      </View>
      <Btn
        title="Clear history"
        onPress={() => clearVoice().then(() => { void reload(); refresh(); })}
        color={C.red}
        style={{ marginTop: 0, marginBottom: 12 }}
      />
      <FlatList
        data={items}
        keyExtractor={(v) => v.id}
        ItemSeparatorComponent={() => <Spacer h={8} />}
        renderItem={({ item }) => (
          <View style={[s.card, { marginBottom: 0 }]}>
            <View style={[s.row, { justifyContent: "space-between", marginBottom: 4 }]}>
              <Tag text={item.intent} color={C.accent} />
              <Text style={[s.body, { fontSize: 11 }]}>
                {new Date(item.createdAt).toLocaleString()}
              </Text>
            </View>
            <Text style={s.mono}>T: {item.transcript}</Text>
            <Text style={s.body}>{item.response}</Text>
          </View>
        )}
        ListEmptyComponent={<Text style={s.body}>No interactions yet.</Text>}
      />
    </View>
  );
}
