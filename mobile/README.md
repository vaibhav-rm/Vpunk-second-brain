# Second Brain Server (phone app)

React Native (Expo) replacement for the laptop Next.js backend. The phone hosts
the same device API the ESP32 already speaks, so the wearable works with no
laptop on the network.

## What it replaces

| Website route | Phone equivalent |
|---|---|
| `POST /api/device/register` | `src/routes.ts → handleRegister` |
| `POST /api/device/heartbeat` | `handleHeartbeat` (settings sync, command queue, clock) |
| `GET /api/device/snapshot` | `handleSnapshot` (tasks, notes, weather, time) |
| `POST /api/device/voice` | `handleVoice` (Groq STT → intent → DB → ≤20-word reply) |
| Prisma + SQLite (`dev.db`) | `expo-sqlite` (`second-brain.db` on-device) |
| `.env` API keys | Settings tab → SecureStore (never in code) |
| Dashboard (tasks/notes/voice/settings) | Tasks / Notes / Voice / Settings tabs |

Response JSON shapes match the website byte-for-byte where the firmware parses
fixed fields (`response`, `transcript`, `success`, `page`, `tasks[].title`,
`notes[].{title,snippet}`, `weather.*`, `time`, `date`, `settings.*`).

## How the server works on a phone

iOS/Android forbid nothing here, but there is no hosted runtime — so the app
runs a minimal HTTP/1.1 server over TCP sockets (`react-native-tcp-socket`,
`src/http.ts`: one request per connection, `Content-Length` framing, always
`Connection: close`, which is exactly what the ESP32's HTTPClient sends).
No extra native HTTP module needed.

## Run it (Android-first)

Needs a dev-client build — `react-native-tcp-socket` is native code, so this
does **not** run in Expo Go.

```bash
cd mobile
npx expo run:android   # builds + installs the dev client, starts Metro
```

iOS: `npx expo run:ios` builds, but iOS cannot share a hotspot while serving
reliably and background sockets get suspended — treat Android as the real
target, iOS as UI preview only.

## Point the ESP32 at the phone

1. Phone: enable the WiFi hotspot. Android's hotspot gateway is usually
   `192.168.43.1` (confirm in your hotspot settings).
2. App → Settings → Server address: set that IP (default already
   `192.168.43.1`) and port `3000`. Start the server.
3. ESP32: join the hotspot SSID, then set the agent host to the phone IP —
   either on the website dashboard before switching over, or `DEFAULT_AGENT_HOST`
   in `firmware/config.h` + reflash. No firmware logic changes needed: the
   phone speaks the same four routes.
4. App → Settings: paste at least a Groq key (free, console.groq.com) for
   speech-to-text. Proxy/Gemini keys optional, same roles as the website.
5. Keep the app in the foreground while using voice (OS may suspend sockets
   in background).

## Notes / limits

- Voice answers are capped at ~20 words for the 128×64 OLED, same as the
  website. The Voice tab's Ask box returns full-length replies.
- The first snapshot fetch per page shows "Loading…" then fills in — same
  on-demand policy as the firmware expects.
- `dev.db` does not migrate — the phone DB starts empty; add tasks/notes in
  the app or by talking to the device.
