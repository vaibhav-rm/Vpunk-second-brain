import React, { useEffect, useState } from "react";
import { FlatList, Text, TouchableOpacity, View } from "react-native";
import { useApp } from "../store";
import { Btn, C, Field, s, Spacer } from "../ui";
import { createNote, deleteNote, listNotes, type NoteRow } from "../db";

export default function NotesScreen() {
  const { refreshKey, refresh } = useApp();
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");

  const reload = async () => setNotes(await listNotes());
  useEffect(() => {
    void reload();
  }, [refreshKey]);

  const add = async () => {
    if (!title.trim() && !content.trim()) return;
    await createNote(title.trim() || "Note", content.trim(), "app");
    setTitle("");
    setContent("");
    await reload();
    refresh();
  };

  return (
    <View style={s.screen}>
      <Text style={s.h1}>Notes</Text>
      <View style={s.card}>
        <Field label="TITLE" value={title} onChangeText={setTitle} placeholder="Note title…" />
        <Field label="CONTENT" value={content} onChangeText={setContent} placeholder="Write…" />
        <Btn title="Save note" onPress={add} />
      </View>
      <FlatList
        data={notes}
        keyExtractor={(n) => n.id}
        ItemSeparatorComponent={() => <Spacer h={8} />}
        renderItem={({ item }) => (
          <View style={[s.card, { marginBottom: 0 }]}>
            <Text style={[s.body, { color: C.text, fontWeight: "700" }]}>{item.title}</Text>
            <Text style={s.body} numberOfLines={3}>
              {item.content}
            </Text>
            <TouchableOpacity onPress={() => deleteNote(item.id).then(() => { void reload(); refresh(); })}>
              <Text style={{ color: C.red, fontSize: 13, marginTop: 6 }}>Delete</Text>
            </TouchableOpacity>
          </View>
        )}
        ListEmptyComponent={<Text style={s.body}>No notes yet.</Text>}
      />
    </View>
  );
}
