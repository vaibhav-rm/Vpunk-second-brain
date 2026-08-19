# Second Brain: Wearable Companion & Local AI Assistant

Second Brain is an open-source hardware wearable and cognitive intelligence server. Powered by the **ESP32-C6 SoC (RISC-V)**, the physical pendant captures digital voice dictation via an I2S microphone, classifies user intent (creating tasks, logging memories, querying weather, or conversing with AI), and synchronizes settings over HTTP heartbeats with a Next.js local server.

---

## System Architecture

The following block diagram outlines the flow of data from the hardware sensor to the Next.js cognitive server and persistent memory bank:

```
+------------------+                   +--------------------+
|  INMP441 I2S Mic | ---> [Mono PCM] ->|                    |
+------------------+                   |      ESP32-C6      |
|  SSD1306 OLED    | <--- [I2C Frame] -| (RISC-V Wearable)  |
+------------------+                   |                    |
|  Tactile Buttons | ---> [GPIO Pull] -|                    |
+------------------+                   +---------+----------+
                                                 |
                                     (WiFi HTTP POST / JSON)
                                                 v
+------------------+                   +---------+----------+
|  Gemini / OpenAI | <--- (LLM/Whisper)|   Next.js Server   |
|   AI Endpoints   | ---> (Structured) |   (Local Host)     |
+------------------+                   +---------+----------+
                                                 |
                                        (Prisma Client / SQL)
                                                 v
                                       +---------+----------+
                                       | SQLite Persistence |
                                       |   (Second Brain)   |
                                       +--------------------+
```

---

## Key Features

1. **Precision Voice Dictation**: Directly captures 16kHz 16-bit Mono PCM audio streams bypassing noisy analog ADC converters using the INMP441 digital microphone.
2. **Dynamic Intent Parsing**: Server-side LLM processing extracts transcription intent and performs immediate database side-effects (e.g. inserting tasks, notes, or triggering custom alerts).
3. **NVS Stash & Heartbeats**: The ESP32-C6 device queries the Next.js server every 10 seconds. Device configuration properties (LED states, OLED brightness, WiFi credentials) are cached in the Non-Volatile Storage (NVS) flash partition.
4. **Interactive Hardware Simulator**: Built into the Next.js landing page (`/`), allowing full testing of the database actions, intent parsing, and OLED visual states without physical hardware.
5. **Obsidian Web Dashboard**: A premium, responsive dashboard (`/dashboard`) to manage task lists, browse the memory log with hashtag filters, read system stats, and converse with the memory bank.

---

## Directory Structure

```
.
├── docs/                      # Static Documentation Center (GitHub Pages)
│   └── index.html             # High-fidelity single-page docs
├── firmware/                  # ESP32-C6 Arduino/C++ Firmware
│   ├── firmware.ino           # Main setup, heartbeat, and audio capture loops
│   ├── config.h               # Default WiFi, host, and pin configuration settings
│   └── upload.sh              # Bash script to build and flash the ESP32 automatically
├── prisma/                    # SQLite Database Schema
│   ├── schema.prisma          # Prisma schema defining tasks, notes, logs, and queue
│   └── seed.ts                # Default seed script for mock data
├── src/
│   └── app/                   # Next.js App Router Structure
│       ├── actions.ts         # Server actions for task, note, and chat updates
│       ├── page.tsx           # Premium marketing landing page & simulator
│       ├── dashboard/         # Web dashboard route
│       └── api/device/        # IoT device endpoints (register, heartbeat, voice)
└── package.json               # Next.js and Prisma dependency configurations
```

---

## Hardware BOM & Schematic Pinout

The Second Brain wearable uses the following BOM and connection pinout:

| Peripheral | Signal | ESP32-C6 Pin | Connection Type |
| :--- | :--- | :--- | :--- |
| **INMP441 Microphone** | SCK (Serial Clock) | **GPIO 4** | I2S Clock Line |
| **INMP441 Microphone** | WS (Word Select) | **GPIO 5** | I2S Word Select Clock |
| **INMP441 Microphone** | SD (Serial Data) | **GPIO 20** | I2S Audio Data Out |
| **INMP441 Microphone** | VCC / GND / L/R | **3.3V / GND / GND** | L/R tied to Ground for Left Channel |
| **SSD1306 OLED (I2C)** | SDA (Serial Data) | **GPIO 6** | I2C Data Line |
| **SSD1306 OLED (I2C)** | SCL (Serial Clock) | **GPIO 7** | I2C Clock Line |
| **WS2812B RGB NeoPixel**| DI (Data Input) | **GPIO 8** | Onboard Addressable RGB LED |
| **Tactile Button** | ACTION | **GPIO 1** | Ground-Triggered Recording Input |
| **Tactile Button** | UP | **GPIO 0** | Selection Input |
| **Tactile Button** | DOWN | **GPIO 2** | Selection Input |

---

## Web Server Setup

### 1. Requirements
* Node.js v18+
* SQLite3
* Gemini, OpenAI, or Groq API Key (optional; fallbacks to mock intent processing if absent)

### 2. Installation
Clone the repository and install the dependencies:
```bash
npm install
```

Create a `.env` file in the root directory and configure your AI model keys:
```env
# Add one or more keys to activate real-time AI transcription/intents
GEMINI_API_KEY="your-gemini-key"
OPENAI_API_KEY="your-openai-key"
GROQ_API_KEY="your-groq-key"

# Database connection
DATABASE_URL="file:./dev.db"
```

### 3. Database Initialization
Prepare the SQLite database and seed the default entries:
```bash
npx prisma migrate dev --name init
npx prisma db seed
```

### 4. Running the App
Start the local development server:
```bash
npm run dev
```
Navigate to:
* `http://localhost:3000` — Marketing Landing Page & Device Simulator
* `http://localhost:3000/dashboard` — Web Console & Memory Bank
* `http://localhost:3000/docs/index.html` — Static Documentation Center

---

## Firmware Compilation & Upload

1. Open `firmware/config.h` and customize your local network settings:
   ```cpp
   #define DEFAULT_WIFI_SSID "Your-WiFi-Name"
   #define DEFAULT_WIFI_PASS "Your-WiFi-Password"
   #define DEFAULT_AGENT_HOST "192.168.x.x"  // Next.js server local IP address
   #define DEFAULT_AGENT_PORT 3000           // Port running Next.js
   ```
2. Connect your ESP32-C6 via USB.
3. Flash using the automated script:
   ```bash
   cd firmware
   chmod +x upload.sh
   ./upload.sh
   ```
   *Note: If compilation fails, verify that you have `arduino-cli` installed and that the `esp32` board manager URL is added.*

---

## License & Credits
Developed by **Vaibhav Rathod**. Open-source under the MIT License.
