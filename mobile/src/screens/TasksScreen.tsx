import React, { useEffect, useState } from "react";
import { FlatList, Text, TouchableOpacity, View } from "react-native";
import { useApp } from "../store";
import { Btn, C, Field, Tag, s, Spacer } from "../ui";
import {
  createTask,
  deleteTask,
  listTasks,
  toggleTask,
  type TaskRow,
} from "../db";

export default function TasksScreen() {
  const { refreshKey, refresh } = useApp();
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [title, setTitle] = useState("");

  const reload = async () => setTasks(await listTasks());
  useEffect(() => {
    void reload();
  }, [refreshKey]);

  const add = async () => {
    const t = title.trim();
    if (!t) return;
    await createTask(t);
    setTitle("");
    await reload();
    refresh();
  };

  return (
    <View style={s.screen}>
      <Text style={s.h1}>Tasks</Text>
      <View style={s.card}>
        <Field label="NEW TASK" value={title} onChangeText={setTitle} placeholder="Add task…" />
        <Btn title="Add" onPress={add} />
      </View>
      <FlatList
        data={tasks}
        keyExtractor={(t) => t.id}
        ItemSeparatorComponent={() => <Spacer h={8} />}
        renderItem={({ item }) => (
          <View style={[s.card, { marginBottom: 0 }]}>
            <View style={[s.row, { justifyContent: "space-between" }]}>
              <Text style={[s.body, { color: C.text, flex: 1, textDecorationLine: item.completed ? "line-through" : "none" }]}>
                {item.title}
              </Text>
              <Tag text={item.priority} color={C.accent} />
            </View>
            <View style={[s.row, { marginTop: 8, gap: 16 }]}>
              <TouchableOpacity onPress={() => toggleTask(item.id, !item.completed).then(() => { void reload(); refresh(); })}>
                <Text style={{ color: C.green, fontSize: 13 }}>
                  {item.completed ? "Reopen" : "Done"}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => deleteTask(item.id).then(() => { void reload(); refresh(); })}>
                <Text style={{ color: C.red, fontSize: 13 }}>Delete</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
        ListEmptyComponent={<Text style={s.body}>No tasks yet.</Text>}
      />
    </View>
  );
}
