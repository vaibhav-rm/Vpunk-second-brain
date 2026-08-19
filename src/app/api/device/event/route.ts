import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { deviceId, event, details } = body;

    if (!deviceId || !event) {
      return NextResponse.json(
        { error: "deviceId and event are required" },
        { status: 400 }
      );
    }

    console.log(`Device Event [${deviceId}]: ${event}`, details || "");

    // We can save this to database or trigger WebSocket notifications.
    // For now we just log it and return success.
    await prisma.device.updateMany({
      where: { deviceId },
      data: {
        lastHeartbeat: new Date(),
        status: "online",
      },
    });

    return NextResponse.json({
      success: true,
      message: "Event logged successfully",
    });
  } catch (error: any) {
    console.error("Device event error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
