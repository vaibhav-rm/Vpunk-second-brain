import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { deviceId, name } = body;

    if (!deviceId) {
      return NextResponse.json(
        { error: "deviceId is required" },
        { status: 400 }
      );
    }

    // Check if device exists
    let device = await prisma.device.findUnique({
      where: { deviceId },
    });

    if (!device) {
      // Create new device with a token
      const token = Math.random().toString(36).substring(2) + Date.now().toString(36);
      device = await prisma.device.create({
        data: {
          deviceId,
          name: name || `Second Brain #${deviceId.slice(-4)}`,
          token,
          status: "online",
          lastHeartbeat: new Date(),
        },
      });
    } else {
      // Set to online
      device = await prisma.device.update({
        where: { deviceId },
        data: {
          status: "online",
          lastHeartbeat: new Date(),
        },
      });
    }

    return NextResponse.json({
      success: true,
      deviceId: device.deviceId,
      name: device.name,
      token: device.token,
    });
  } catch (error: any) {
    console.error("Registration error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
