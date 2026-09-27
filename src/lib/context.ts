import { prisma } from "@/lib/prisma";

// Builds a compact, token-budgeted snapshot of the user's Second Brain data.
// Injected into LLM prompts so answers are grounded in REAL tasks/notes
// instead of hallucinating. Keep it small: ~3k chars max.
export async function buildAssistantContext(): Promise<string> {
  try {
    const [openTasks, recentNotes, recentVoice, device] = await Promise.all([
      prisma.task.findMany({
        where: { completed: false },
        orderBy: [{ createdAt: "desc" }],
        take: 15,
      }),
      prisma.note.findMany({
        orderBy: { createdAt: "desc" },
        take: 8,
      }),
      prisma.voiceInteraction.findMany({
        orderBy: { createdAt: "desc" },
        take: 5,
      }),
      prisma.device.findFirst({ orderBy: { lastHeartbeat: "desc" } }),
    ]);

    const lines: string[] = ["[Live Second Brain data — use this to answer. Never invent tasks or notes.]"];

    if (openTasks.length > 0) {
      lines.push(`Open tasks (${openTasks.length}):`);
      for (const t of openTasks) {
        const due = t.dueDate
          ? `, due ${t.dueDate.toLocaleDateString([], { month: "short", day: "numeric" })} ${t.dueDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
          : "";
        lines.push(`- "${t.title}" [${t.priority}${due}]`);
      }
    } else {
      lines.push("Open tasks: none. The task list is empty.");
    }

    if (recentNotes.length > 0) {
      lines.push("Recent notes:");
      for (const n of recentNotes) {
        const snippet = n.content.length > 150 ? n.content.slice(0, 150) + "…" : n.content;
        lines.push(`- "${n.title}" [${n.tags || "untagged"}]: ${snippet}`);
      }
    } else {
      lines.push("Notes: none saved yet.");
    }

    if (recentVoice.length > 0) {
      lines.push("Recent voice interactions:");
      for (const v of recentVoice) {
        lines.push(`- heard "${v.transcript}" → ${v.intent}`);
      }
    }

    if (device) {
      lines.push(
        `Device: ${device.name} (${device.deviceId}), battery ${device.battery}%, firmware ${device.firmware}.`
      );
    }

    return lines.join("\n");
  } catch (e) {
    console.error("Failed to build assistant context:", e);
    return "[Live Second Brain data unavailable — say so honestly instead of inventing tasks or notes.]";
  }
}
