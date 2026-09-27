import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { deviceId, battery, firmware } = body;

    if (!deviceId) {
      return NextResponse.json(
        { error: "deviceId is required" },
        { status: 400 }
      );
    }

    // Update device stats
    const device = await prisma.device.upsert({
      where: { deviceId },
      update: {
        battery: battery !== undefined ? battery : -1,
        firmware: firmware || "0.1.0",
        status: "online",
        lastHeartbeat: new Date(),
      },
      create: {
        deviceId,
        name: `Second Brain #${deviceId.slice(-4)}`,
        token: Math.random().toString(36).substring(2),
        battery: battery !== undefined ? battery : -1,
        firmware: firmware || "0.1.0",
        status: "online",
        lastHeartbeat: new Date(),
      },
    });

    // Check for pending command queue items for this device
    const pendingCommand = await prisma.commandQueue.findFirst({
      where: {
        deviceId,
        processed: false,
      },
      orderBy: {
        createdAt: "asc",
      },
    });

    if (pendingCommand) {
      // Mark command as processed
      await prisma.commandQueue.update({
        where: { id: pendingCommand.id },
        data: { processed: true },
      });

      // Parse payload if present
      let parsedPayload = {};
      try {
        parsedPayload = JSON.parse(pendingCommand.payload);
      } catch (e) {
        parsedPayload = { raw: pendingCommand.payload };
      }

      return NextResponse.json({
        success: true,
        command: pendingCommand.command,
        time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }),
        date: new Date().toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }),
        settings: {
          name: device.name,
          brightness: device.brightness,
          ledBehavior: device.ledBehavior,
          recordingDuration: device.recordingDuration,
          wifiSsid: device.wifiSsid,
          wifiPassword: device.wifiPassword,
        },
        ...parsedPayload,
      });
    }

    const now = new Date();
    return NextResponse.json({
      success: true,
      status: "online",
      // Wall-clock for the OLED CLOCK page (device has no RTC).
      time: now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }),
      date: now.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }),
      settings: {
        name: device.name,
        brightness: device.brightness,
        ledBehavior: device.ledBehavior,
        recordingDuration: device.recordingDuration,
        wifiSsid: device.wifiSsid,
        wifiPassword: device.wifiPassword,
      },
    });
  } catch (error: any) {
    console.error("Heartbeat error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
