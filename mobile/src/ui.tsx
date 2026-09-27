// Shared dark-theme primitives (same vibe as the web dashboard).

import React from "react";
import {
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";

export const C = {
  bg: "#09090b",
  card: "#131316",
  border: "#27272a",
  text: "#f4f4f5",
  dim: "#a1a1aa",
  faint: "#71717a",
  accent: "#22d3ee",
  green: "#34d399",
  red: "#f87171",
  amber: "#fbbf24",
};

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg, padding: 16 },
  card: {
    backgroundColor: C.card,
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  },
  h1: { color: C.text, fontSize: 20, fontWeight: "700", marginBottom: 4 },
  h2: { color: C.text, fontSize: 14, fontWeight: "700", marginBottom: 8 },
  body: { color: C.dim, fontSize: 13, lineHeight: 18 },
  mono: { color: C.accent, fontFamily: "monospace", fontSize: 12 },
  input: {
    backgroundColor: C.bg,
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 8,
    color: C.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
  },
  label: { color: C.faint, fontSize: 11, marginBottom: 4, marginTop: 10 },
  row: { flexDirection: "row", alignItems: "center" },
});

export function Btn({
  title,
  onPress,
  disabled,
  color,
  style,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  color?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={[
        {
          backgroundColor: disabled ? "#3f3f46" : color || C.text,
          borderRadius: 8,
          paddingVertical: 12,
          paddingHorizontal: 16,
          alignItems: "center",
          marginTop: 12,
        },
        style,
      ]}
    >
      <Text
        style={{ color: disabled ? C.faint : color ? "#fff" : "#000", fontWeight: "700", fontSize: 13 }}
      >
        {title}
      </Text>
    </TouchableOpacity>
  );
}

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  secure,
  numeric,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  secure?: boolean;
  numeric?: boolean;
}) {
  return (
    <View>
      <Text style={s.label}>{label}</Text>
      <TextInput
        style={s.mono}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={C.faint}
        secureTextEntry={secure}
        keyboardType={numeric ? "numeric" : "default"}
        autoCapitalize="none"
        autoCorrect={false}
      />
    </View>
  );
}

export function Tag({ text, color }: { text: string; color?: string }) {
  return (
    <View
      style={{
        borderColor: color || C.border,
        borderWidth: 1,
        borderRadius: 6,
        paddingHorizontal: 8,
        paddingVertical: 3,
      }}
    >
      <Text style={{ color: color || C.dim, fontSize: 11, fontWeight: "700" }}>{text}</Text>
    </View>
  );
}

export function Spacer({ h = 12 }: { h?: number }) {
  return <View style={{ height: h }} />;
}
