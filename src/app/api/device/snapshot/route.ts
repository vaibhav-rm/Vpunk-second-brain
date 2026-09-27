import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchWeather } from "@/lib/weather";

// Compact one-shot snapshot for the ESP32 OLED pages.
// The device has kilobytes of RAM: keep it tiny (5 tasks, 5 notes,
// short strings). Fetched when a page is opened, cached on-device ~30s.
export async function GET(req: NextRequest) {
  try {
    const deviceId =
      req.headers.get("x-device-id") ||
      req.nextUrl.searchParams.get("deviceId");

    if (!deviceId) {
      return NextResponse.json(
        { error: "X-Device-ID header is required" },
        { status: 400 }
      );
    }

    const device = await prisma.device.findUnique({ where: { deviceId } });
    if (!device) {
      return NextResponse.json({ error: "Device not registered" }, { status: 401 });
    }

    // DB + weather concurrently: snapshot latency = slowest single call,
    // and weather is usually served from the 10-min server cache (~1ms).
    const [tasks, notes, weather] = await Promise.all([
      prisma.task.findMany({
        where: { completed: false },
        orderBy: { createdAt: "desc" },
        take: 5,
      }),
      prisma.note.findMany({
        orderBy: { createdAt: "desc" },
        take: 5,
      }),
      fetchWeather().catch(() => null),
    ]);

    const now = new Date();
    const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

    return NextResponse.json({
      tasks: tasks.map((t) => ({
        title: clip(t.title, 26),
        priority: t.priority,
      })),
      taskCount: await prisma.task.count({ where: { completed: false } }),
      notes: notes.map((n) => ({ title: clip(n.title, 26), snippet: clip(n.content, 90) })),
      noteCount: await prisma.note.count(),
      weather,
      // Wall-clock for the OLED CLOCK page (device has no RTC).
      time: now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }),
      date: now.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }),
      battery: device.battery,
    });
  } catch (error) {
    console.error("Snapshot error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
