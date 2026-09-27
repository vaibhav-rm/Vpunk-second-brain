const { PrismaClient } = require("@prisma/client");
const { PrismaBetterSqlite3 } = require("@prisma/adapter-better-sqlite3");

const adapter = new PrismaBetterSqlite3({ url: "file:dev.db" });
const prisma = new PrismaClient({ adapter });

async function main() {
  // Clear existing data
  await prisma.device.deleteMany({});
  await prisma.task.deleteMany({});
  await prisma.note.deleteMany({});
  await prisma.voiceInteraction.deleteMany({});
  await prisma.commandQueue.deleteMany({});

  // 1. Seed Device
  const device = await prisma.device.create({
    data: {
      deviceId: "second-brain-001",
      name: "Second Brain Wearable",
      token: "dev-token-xyz123",
      battery: 78,
      firmware: "0.1.0",
      status: "online",
      lastHeartbeat: new Date(),
      brightness: 100,
      ledBehavior: "rainbow",
      recordingDuration: 5,
      wifiSsid: "Sri Krishna Pg 41",
      wifiPassword: "srikrishnafour",
    },
  });

  // 2. Seed Tasks
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(10, 0, 0, 0);

  await prisma.task.createMany({
    data: [
      {
        title: "Submit OS assignment",
        completed: false,
        priority: "high",
        dueDate: tomorrow,
      },
      {
        title: "Buy replacement AA batteries",
        completed: false,
        priority: "medium",
      },
      {
        title: "Test INMP441 micro-soldering joints",
        completed: true,
        priority: "high",
      },
      {
        title: "Read up on ESP32-C6 Deep Sleep modes",
        completed: false,
        priority: "low",
      },
    ],
  });

  // 3. Seed Notes
  await prisma.note.createMany({
    data: [
      {
        title: "LoRa Antenna Warning",
        content: "The LoRa nodes need external antennas to function without burning the PA. Do not power on modules bare-board.",
        tags: "hardware,lora",
        createdAt: new Date(),
      },
      {
        title: "INMP441 Microphone Pinout",
        content: "Pin configurations for I2S capture:\nSCK -> GPIO 4\nWS -> GPIO 5\nSD -> GPIO 20\nL/R -> GND (Left channel select)",
        tags: "hardware,pinout",
        createdAt: new Date(Date.now() - 3600000), // 1 hr ago
      },
      {
        title: "Transistor Explanation Notes",
        content: "A transistor is a semiconductor device used to amplify or switch electrical signals and power. It is composed of semiconductor material usually with at least three terminals for connection to an external circuit.",
        tags: "ai,study",
        createdAt: new Date(Date.now() - 7200000), // 2 hrs ago
      },
    ],
  });

  // 4. Seed Voice Logs
  await prisma.voiceInteraction.createMany({
    data: [
      {
        deviceId: "second-brain-001",
        transcript: "Add submit OS assignment tomorrow at 10 AM",
        response: "✓ TASK CREATED\n\nSubmit OS assignment\nTomorrow • 10:00 AM",
        intent: "CREATE_TODO",
        createdAt: new Date(Date.now() - 600000), // 10m ago
      },
      {
        deviceId: "second-brain-001",
        transcript: "Remember that the LoRa nodes need external antennas",
        response: "✓ NOTE SAVED\n\nLoRa Antenna Warning",
        intent: "CREATE_NOTE",
        createdAt: new Date(Date.now() - 1200000), // 20m ago
      },
      {
        deviceId: "second-brain-001",
        transcript: "What's the weather tomorrow?",
        response: "WEATHER INFO\n\nNow: 28°C\nPartly cloudy\nTomor: 21-27°C",
        intent: "QUERY_WEATHER",
        createdAt: new Date(Date.now() - 1800000), // 30m ago
      },
    ],
  });

  console.log("Database seeded successfully!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
