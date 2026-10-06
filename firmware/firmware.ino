/**
 * Second Brain Wearable Companion Firmware
 * Target Hardware: ESP32-C6 Super Mini / C6 Dev Kit
 * 
 * Dependencies:
 * - ArduinoJson (v6.x or v7.x)
 * - Adafruit SSD1306
 * - Adafruit GFX Library
 * - Adafruit NeoPixel
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Adafruit_NeoPixel.h>
#include <ESP_I2S.h>
#include <math.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>
#include "config.h"

// Active configuration state (loaded from NVS or config.h)
String wifiSsid;
String wifiIdentity; // EAP outer identity (PEAP) — usually same as username
String wifiUser;     // EAP username (empty = WPA2-Personal PSK mode)
String wifiPassword;
String agentHost;
int agentPort;
String ledBehavior;
int brightness;
int recordingDuration;

// NVS Preferences helper
Preferences preferences;

// Timer variables
unsigned long lastHeartbeatTime = 0;
// 30s: the dashboard treats the device as online within 45s of the last
// heartbeat, so 30s keeps status green with 3x less radio chatter than 10s.
// Less time on air = less single-core contention with the button path.
const unsigned long heartbeatInterval = 30000; // 30 seconds

// Server reachability: while false, network calls fail fast (4s) instead of
// stalling the loop for 12-15s and making buttons feel dead.
bool serverOnline = true;

// ---------------------------------------------------------------------------
// Concurrency: loop() owns buttons + OLED and must NEVER block on the network.
// All slow I/O (heartbeat, snapshot, wifi retry) runs in networkTask (prio 1)
// while loop() runs at prio 2, so a press redraws the screen instantly even
// mid-download. netMutex guards every global both tasks touch. Rule: never
// hold the mutex across network I/O — only around quick memory copies.
// ---------------------------------------------------------------------------
TaskHandle_t netTaskHandle = NULL;
SemaphoreHandle_t netMutex = NULL;
// Loop wakeup: every button ISR gives this, loop blocks on it with a 2ms
// timeout for housekeeping. Event-driven instead of poll-sleeping, so a
// press wakes the loop in one context switch instead of at the next poll
// boundary. Counts live in upQueue/downQueue/actionPressed — a collapsed
// wake is harmless because the queues preserve every tap.
SemaphoreHandle_t btnSem = NULL;
volatile bool wantHeartbeat = false;
volatile bool wantSnapshot = false;
volatile bool snapshotForce = false;
// Dashboard-pushed UI events, consumed (drawn) by loop()
volatile bool alertPending = false;
String alertTitle = "";
String alertMsg = "";
volatile bool navPending = false;
String navTarget = "notes";

// Button state variables
bool isRecording = false;
// Last physical interaction (flip or ACTION press), loop-owned. networkTask
// reads it to defer routine radio work while fingers are on the buttons.
volatile unsigned long lastUserActivity = 0;

// Dynamic Audio buffer setup
char* wavBuffer = nullptr;
size_t wavBufferSize = 0;

// OLED Display instance
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);

// NeoPixel LED instance
Adafruit_NeoPixel rgbLed(1, STATUS_LED_PIN, NEO_GRB + NEO_KHZ800);

// I2S Microphone class instance
I2SClass I2S;

// Display state
String displayStatus = "BOOTING";
String displayLine2 = "";
String displayLine3 = "";
String displayLine4 = "";
unsigned long notificationUntil = 0;
// Non-blocking alert blink: the old code sat in delay(100)x8 (~800ms) with
// buttons blind. Now the trigger arms this state and each loop advances one
// 100ms step; updateLED() yields while alertBlink is active (see loop).
bool alertBlink = false;
int alertBlinkStep = 0;
unsigned long alertBlinkAt = 0;
int alertBlinkMax = 0;

// Track the SSID that recently failed connection to avoid server-driven reboot loops
String lastFailedSsid = "";

// Setup functions
void updateDisplay(String status, String l2 = "", String l3 = "", String l4 = "") {
  displayStatus = status;
  displayLine2 = l2;
  displayLine3 = l3;
  displayLine4 = l4;

  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);

  // Header
  display.setCursor(0, 0);
  display.println("SECOND BRAIN // OS");
  display.drawLine(0, 9, 127, 9, SSD1306_WHITE);

  // Status
  display.setCursor(0, 13);
  display.print("STATUS: ");
  display.println(displayStatus);

  // Lines
  display.setCursor(0, 26);
  display.println(displayLine2);
  display.setCursor(0, 39);
  display.println(displayLine3);
  display.setCursor(0, 52);
  display.println(displayLine4);

  display.display();
}

void initOLED() {
  Wire.setPins(OLED_SDA, OLED_SCL);
  Wire.begin();
  // 100kHz default = ~100ms per full redraw; 400kHz = ~25ms; 800kHz =~13ms.
  // Every button press pays for a redraw, so this is pure responsiveness.
  // Most SSD1306 modules tolerate 800kHz fine — if the screen garbles,
  // drop back to 400000.
  Wire.setClock(800000);

  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    if (Serial) Serial.println("OLED initialization failed!");
  } else {
    if (Serial) Serial.println("OLED Initialized.");
    display.clearDisplay();
    display.display();
  }
}

// ---------------------------------------------------------------------------
// OLED multi-page UI — 128x64, default 5x7 font = 21 chars x 8px per line.
// Every message is word-wrapped here so nothing is ever cut mid-word.
// Pages: STATUS / TASKS / NOTES / WEATHER / CLOCK / AI (UP/DN to flip).
// ---------------------------------------------------------------------------
#define OLED_CHARS_PER_LINE 21
#define OLED_BODY_LINES 4

// OledPage enum lives in config.h (see note there).

const char* PAGE_NAMES[PAGE_COUNT] = {"CLOCK", "STATUS", "TASKS", "NOTES", "WEATHER", "AI"};
OledPage currentPage = PAGE_CLOCK;
volatile bool pageDirty = true;
unsigned long lastPageRender = 0;

// Snapshot cache from GET /api/device/snapshot (tiny: 5+5 short strings)
String snapTasks[5];
int snapTaskCount = 0;
int snapTaskTotal = 0;
String snapNotes[5];
String snapNoteSnip[5];
int snapNoteCount = 0;
int snapNoteTotal = 0;
String snapWxNow = "";
String snapWxTomor = "";
String snapTime = "--:--";
String snapDate = "";
unsigned long snapAt = 0;
// Cached net info, refreshed by networkTask every ~5s so the STATUS page
// never queries the WiFi driver on the button path (driver calls can stall
// under weak signal, and the driver outranks all of our tasks).
String cachedIp = "";
long cachedRssi = 0;

// Last voice exchange, shown on the AI page
String lastTranscript = "";
String lastAgentResp = "";

// Auto-scroll state: TASKS/AI scroll line-by-line, NOTES flips one note/screen
int taskScroll = 0;
int noteIdx = 0;
int aiScroll = 0;

// Button events via GPIO interrupts — presses are latched as queue counts the
// moment they happen, so rapid taps can NEVER be missed or merged, even if
// the loop is inside a render or a slow network call. The loop atomically
// drains each queue per iteration and renders only the final page once.
// ISRs do nothing but count (with a time guard for bounce); all work is loop().
volatile uint8_t upQueue = 0;
volatile uint8_t downQueue = 0;
volatile bool actionPressed = false;
volatile unsigned long lastUpIsr = 0;
volatile unsigned long lastDownIsr = 0;
volatile unsigned long lastActionIsr = 0;
// Diagnostic: first-press timestamps, so loop can report exact press-to-
// screen latency even when several taps queue behind one render. Stamped on
// the 0->1 transition only; loop clears the matching stamp with its queue.
volatile unsigned long upIsrStamp = 0;
volatile unsigned long downIsrStamp = 0;
// Release arming: an ISR counts only while its button is armed; loop()
// re-arms after the pin reads HIGH continuously for 20ms (30ms ACTION).
// Time guards alone can't fix edge chatter — press bounce AND release bounce
// both re-cross FALLING, so without arming one physical tap counts twice.
// A second deliberate tap still lands ~50ms later; human fast-tapping is
// 80ms+, so nothing real is lost.
volatile bool upArmed = true;
volatile bool downArmed = true;
volatile bool actionArmed = true;
unsigned long upHighSince = 0; // loop-owned release-stability timers
unsigned long downHighSince = 0;
unsigned long actionHighSince = 0;
// Measured cost of the last button flip in ms, shown in every page footer
// (loop-owned; ISRs never touch it)
unsigned long lastFlipMs = 0;
// Flip-path instrumentation (loop-owned; written by renderCurrentPage /
// timedPush, read by the [UI] serial line right after gotoPage). Splits the
// lump "draw" number into copy (mutex critical section), build
// (String/wrapLines work) and push (display.display() I2C transfer) so a
// slow flip can be attributed instead of guessed at.
unsigned long uiCopyMs = 0;
unsigned long uiBuildMs = 0;
unsigned long uiPushMs = 0;
bool uiPushSlow = false; // any single display.display() took >20ms (retry storm?)
uint32_t uiFreeHeap = 0;
uint32_t uiMaxAlloc = 0;

void IRAM_ATTR onUpButton() {
  unsigned long now = millis();
  // 30ms press-bounce guard + release arming: press chatter is inside the
  // guard window, release chatter finds the button disarmed. Either edge
  // alone can no longer double-count a tap.
  if (upArmed && now - lastUpIsr > 30) {
    lastUpIsr = now;
    upArmed = false;
    if (upQueue == 0) upIsrStamp = now;
    if (upQueue < 255) upQueue++;
    if (btnSem != NULL) { BaseType_t hpw = pdFALSE; xSemaphoreGiveFromISR(btnSem, &hpw); if (hpw) portYIELD_FROM_ISR(); }
  }
}

void IRAM_ATTR onDownButton() {
  unsigned long now = millis();
  if (downArmed && now - lastDownIsr > 30) {
    lastDownIsr = now;
    downArmed = false;
    if (downQueue == 0) downIsrStamp = now;
    if (downQueue < 255) downQueue++;
    if (btnSem != NULL) { BaseType_t hpw = pdFALSE; xSemaphoreGiveFromISR(btnSem, &hpw); if (hpw) portYIELD_FROM_ISR(); }
  }
}

void IRAM_ATTR onActionButton() {
  unsigned long now = millis();
  if (actionArmed && now - lastActionIsr > 200) {
    lastActionIsr = now;
    actionArmed = false;
    actionPressed = true;
    if (btnSem != NULL) { BaseType_t hpw = pdFALSE; xSemaphoreGiveFromISR(btnSem, &hpw); if (hpw) portYIELD_FROM_ISR(); }
  }
}

// Release arming: re-arm each button only after its pin has read HIGH
// continuously (20ms UP/DOWN, 30ms ACTION). Called every loop; three
// digitalReads per ~2ms iteration is negligible. Chatter on release keeps
// resetting the stability timer, so only a genuine let-go re-arms.
void rearmButtons() {
  unsigned long now = millis();
  if (digitalRead(BUTTON_UP) == HIGH) {
    if (upHighSince == 0) upHighSince = now;
    else if (!upArmed && now - upHighSince >= 20) { upArmed = true; upHighSince = 0; }
  } else {
    upHighSince = 0;
  }
  if (digitalRead(BUTTON_DOWN) == HIGH) {
    if (downHighSince == 0) downHighSince = now;
    else if (!downArmed && now - downHighSince >= 20) { downArmed = true; downHighSince = 0; }
  } else {
    downHighSince = 0;
  }
  if (digitalRead(BUTTON_ACTION) == HIGH) {
    if (actionHighSince == 0) actionHighSince = now;
    else if (!actionArmed && now - actionHighSince >= 30) { actionArmed = true; actionHighSince = 0; }
  } else {
    actionHighSince = 0;
  }
}

// True while recording/uploading (intentionally blocking) — stall watchdog skips it
bool inVoiceFlow = false;

// LED cache: updateLED runs every loop, so it never waits on the mutex —
// it reuses the last seen values when the network task is mid-publish.
String cachedLedBehavior = "rainbow";
int cachedBrightness = 100;

// Word-wrap body text into fixed-width lines. Returns line count (capped).
int wrapLines(const String& body, String* lines, int maxLines) {
  int row = 0;
  int start = 0;
  int len = body.length();
  while (row < maxLines && start < len) {
    while (start < len && (body[start] == ' ' || body[start] == '\n' || body[start] == '\r')) start++;
    if (start >= len) break;
    int end = start + OLED_CHARS_PER_LINE;
    int nl = body.indexOf('\n', start);
    if (nl >= 0 && nl < end) {
      end = nl;
    } else if (end < len) {
      int sp = body.lastIndexOf(' ', end);
      if (sp > start) end = sp;
    }
    lines[row++] = body.substring(start, end);
    start = end;
  }
  return row;
}

// display.display() wrapper that times the I2C push. A healthy full-frame
// push is ~13ms at 800kHz (~25ms at 400kHz). Clones that NACK at 800kHz
// trigger silent Wire-library retries — those show up here as intermittent
// >20ms pushes, not a steady cost. (Adafruit's display() swallows
// Wire.endTransmission()'s return code, so push duration is our retry
// detector; uiPushMs accumulates because a render does exactly one push.)
void timedPush() {
  unsigned long t0 = millis();
  display.display();
  unsigned long dt = millis() - t0;
  uiPushMs += dt;
  if (dt > 20) uiPushSlow = true;
}

// Word-wrap any text into the body area (4 lines x 21 chars) + footer.
void drawPage(const String& title, const String& body, const String& footer) {
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println(title.substring(0, OLED_CHARS_PER_LINE));
  display.drawLine(0, 9, 127, 9, SSD1306_WHITE);

  String lines[OLED_BODY_LINES];
  int n = wrapLines(body, lines, OLED_BODY_LINES);
  for (int i = 0; i < n; i++) {
    display.setCursor(0, 13 + i * 10);
    display.println(lines[i]);
  }

  if (footer.length() > 0) {
    display.setCursor(0, 54);
    display.println(footer.substring(0, OLED_CHARS_PER_LINE));
  }
  timedPush();
}

String pageFooter(const char* name, int idx) {
  // Trailing ms = measured cost of the last button flip, drawn on-device so
  // latency is visible without a serial monitor (also proves which build blinked).
  String f = "< ";
  f += name;
  f += " ";
  f += String(idx + 1);
  f += "/6 ";
  f += String((unsigned long)lastFlipMs);
  f += "ms>";
  return f;
}

OledPage pageForName(const String& name) {
  if (name == "tasks") return PAGE_TASKS;
  if (name == "notes") return PAGE_NOTES;
  if (name == "weather") return PAGE_WEATHER;
  if (name == "clock") return PAGE_CLOCK;
  if (name == "ai") return PAGE_AI;
  return PAGE_STATUS;
}

// Dashboard command targets (todo/notes/weather/...) -> OLED pages.
OledPage pageForTarget(const String& target) {
  if (target == "todo") return PAGE_TASKS;
  if (target == "notes") return PAGE_NOTES;
  if (target == "weather") return PAGE_WEATHER;
  if (target == "clock") return PAGE_CLOCK;
  if (target == "ai" || target == "history") return PAGE_AI;
  return PAGE_STATUS;
}

// Loop side: ask the network task for fresh data. Returns instantly — the
// page renders from cache NOW and refreshes when the fetch lands.
void requestSnapshot(bool force = false) {
  if (force) snapshotForce = true;
  wantSnapshot = true;
}

static bool snapshotStale() {
  return snapAt == 0 || millis() - snapAt >= 30000;
}

// Network-task side: the actual GET. Never called from loop().
void doSnapshotFetch(bool force) {
  if (WiFi.status() != WL_CONNECTED) return;
  if (!serverOnline) return; // fail fast; heartbeat re-probes
  // Attempt throttle: a dead/slow server must not be re-hit every 50ms poll.
  static unsigned long lastTry = 0;
  if (!force && millis() - lastTry < 15000) return;
  lastTry = millis();
  if (!force && !snapshotStale()) return;

  String url;
  xSemaphoreTake(netMutex, portMAX_DELAY);
  url = "http://" + agentHost + ":" + String(agentPort) + "/api/device/snapshot";
  xSemaphoreGive(netMutex);

  WiFiClient client;
  HTTPClient http;
  http.begin(client, url);
  http.setTimeout(6000);
  http.addHeader("X-Device-ID", DEVICE_ID);
  int code = http.GET();
  if (code != 200) {
    if (Serial) Serial.printf("[Snap] GET failed: %d\n", code);
    http.end();
    if (code < 0) {
      xSemaphoreTake(netMutex, portMAX_DELAY);
      serverOnline = false; // transport error: fail fast from now on
      xSemaphoreGive(netMutex);
    }
    return;
  }
  String payload = http.getString();
  http.end();

  DynamicJsonDocument doc(2048);
  if (deserializeJson(doc, payload)) {
    if (Serial) Serial.println("[Snap] JSON parse failed");
    return;
  }

  // Publish to the shared cache (short critical section, no I/O inside)
  xSemaphoreTake(netMutex, portMAX_DELAY);
  snapTaskCount = 0;
  snapTaskTotal = doc["taskCount"] | 0;
  if (!doc["tasks"].isNull()) {
    for (JsonObject t : doc["tasks"].as<JsonArray>()) {
      if (snapTaskCount >= 5) break;
      snapTasks[snapTaskCount++] = t["title"].as<String>();
    }
  }
  snapNoteCount = 0;
  snapNoteTotal = doc["noteCount"] | 0;
  if (!doc["notes"].isNull()) {
    for (JsonObject n : doc["notes"].as<JsonArray>()) {
      if (snapNoteCount >= 5) break;
      snapNotes[snapNoteCount] = n["title"].as<String>();
      snapNoteSnip[snapNoteCount] = n["snippet"] | "";
      snapNoteCount++;
    }
  }
  if (!doc["weather"].isNull()) {
    JsonObject w = doc["weather"].as<JsonObject>();
    float temp = w["temp"] | 0;
    String cond = w["condition"] | "";
    float tMin = w["tomorrowMin"] | 0;
    float tMax = w["tomorrowMax"] | 0;
    snapWxNow = String(temp, 0) + "C " + cond;
    snapWxTomor = "Tmrw " + String(tMin, 0) + "-" + String(tMax, 0) + "C";
  } else {
    snapWxNow = "";
    snapWxTomor = "";
  }
  snapTime = doc["time"] | "--:--";
  snapDate = doc["date"] | "";
  snapAt = millis();
  serverOnline = true;
  xSemaphoreGive(netMutex);
  pageDirty = true; // re-render with fresh data
  if (Serial) Serial.println("[Snap] Snapshot cached");
}

bool renderCurrentPage() {
  // Copy-then-draw: snapshot shared state under a microsecond-scale lock,
  // release it, then do the slow work (String building + ~25ms I2C push)
  // unlocked. The old version held netMutex across display.display(), which
  // stalled every flip against heartbeat/snapshot publishes and vice versa.
  // Returns false when the mutex is momentarily busy so callers keep dirty.
  String cTasks[5]; int cTaskCount = 0; int cTaskTotal = 0;
  String cNotes[5]; String cNoteSnip[5]; int cNoteCount = 0; int cNoteTotal = 0;
  String cWxNow, cWxTomor, cTime, cDate, cTranscript, cAgentResp, cAgentHost, cIp;
  int cAgentPort = 0; long cRssi = 0; unsigned long cSnapAt = 0;
  bool wifiUp = (WiFi.status() == WL_CONNECTED);
  unsigned long tStart = millis();
  uiPushMs = 0;
  uiPushSlow = false;
  if (xSemaphoreTake(netMutex, 0) != pdTRUE) return false;
  for (int i = 0; i < 5; i++) { cTasks[i] = snapTasks[i]; cNotes[i] = snapNotes[i]; cNoteSnip[i] = snapNoteSnip[i]; }
  cTaskCount = snapTaskCount; cTaskTotal = snapTaskTotal;
  cNoteCount = snapNoteCount; cNoteTotal = snapNoteTotal;
  cWxNow = snapWxNow; cWxTomor = snapWxTomor; cTime = snapTime; cDate = snapDate;
  cSnapAt = snapAt;
  cTranscript = lastTranscript; cAgentResp = lastAgentResp;
  cAgentHost = agentHost; cAgentPort = agentPort;
  cIp = cachedIp; cRssi = cachedRssi;
  xSemaphoreGive(netMutex);
  uiCopyMs = millis() - tStart;
  // First paint after boot, before networkTask's 5s cache tick: read live once
  if (wifiUp && cIp.length() == 0) { cIp = WiFi.localIP().toString(); cRssi = WiFi.RSSI(); }

  // Scroll-window helper: wrap up to 12 lines, show a 4-line window at *pos,
  // advance *pos when content overflows (no-op when it fits on one screen).
  auto drawScrolled = [&](const String& full, int* pos, const String& title, const String& footer) {
    String allLines[12];
    int total = wrapLines(full, allLines, 12);
    int range = total - OLED_BODY_LINES;
    if (range < 1) {
      *pos = 0;
    } else {
      *pos = *pos % (range + 1);
    }
    String body = "";
    for (int i = 0; i < OLED_BODY_LINES && *pos + i < total; i++) {
      if (i > 0) body += "\n";
      body += allLines[*pos + i];
    }
    drawPage(title, body, footer.substring(0, OLED_CHARS_PER_LINE));
    if (range >= 1) *pos = (*pos + 1) % (range + 1);
  };

  bool stale = (cSnapAt == 0 || millis() - cSnapAt >= 30000);
  switch (currentPage) {
    case PAGE_STATUS: {
      String body = "IP ";
      body += wifiUp ? cIp : "offline";
      body += "\nRSSI ";
      // Signal strength: weaker than ~-75dBm means retransmits that stall
      // even a perfect loop (WiFi driver outranks all of our tasks)
      body += wifiUp ? String(cRssi) + "dBm" : "--";
      body += "\nAGENT ";
      body += cAgentHost + ":" + String(cAgentPort);
      body += "\nUP/DN flip ACTION talk";
      drawPage("STATUS", body, pageFooter("STATUS", PAGE_STATUS));
      break;
    }
    case PAGE_TASKS: {
      // Autoscrolling list: the window slides one line every render tick so
      // every task is shown even when the list is taller than the screen.
      // Refresh is requested, never waited for — the flip stays instant.
      if (stale) requestSnapshot(false);
      if (cSnapAt == 0 && serverOnline) {
        // Never-fetched cache: say Loading, NOT "All clear" (the old fake
        // empty state made flips feel broken/slow when data popped in later)
        drawPage("TASKS", "Loading from server...", pageFooter("TASKS", PAGE_TASKS));
      } else if (cTaskCount == 0) {
        drawPage("TASKS", "All clear! No open tasks.", pageFooter("TASKS", PAGE_TASKS));
      } else {
        String full = "";
        for (int i = 0; i < cTaskCount; i++) {
          if (i > 0) full += "\n";
          full += String(i + 1) + "." + cTasks[i];
        }
        String footer = pageFooter("TASKS", PAGE_TASKS) + " tot:" + String(cTaskTotal);
        drawScrolled(full, &taskScroll, "TASKS", footer);
      }
      break;
    }
    case PAGE_NOTES: {
      // One note per screen: title + snippet, auto-advancing each tick.
      if (stale) requestSnapshot(false);
      if (cSnapAt == 0 && serverOnline) {
        drawPage("NOTES", "Loading from server...", pageFooter("NOTES", PAGE_NOTES));
      } else if (cNoteCount == 0) {
        drawPage("NOTES", "No notes saved yet.", pageFooter("NOTES", PAGE_NOTES));
      } else {
        noteIdx = noteIdx % cNoteCount;
        String body = cNotes[noteIdx] + "\n" + cNoteSnip[noteIdx];
        String footer = "< NOTE " + String(noteIdx + 1) + "/" + String(cNoteCount) + " " + String((unsigned long)lastFlipMs) + "ms>";
        drawPage("NOTES", body, footer.substring(0, OLED_CHARS_PER_LINE));
        noteIdx = (noteIdx + 1) % cNoteCount;
      }
      break;
    }
    case PAGE_WEATHER: {
      if (stale) requestSnapshot(false);
      String wbody;
      if (cWxNow.length() > 0) wbody = cWxNow + "\n" + cWxTomor;
      else if (cSnapAt == 0 && serverOnline) wbody = "Loading from server...";
      else wbody = "Weather unavailable.";
      drawPage("WEATHER", wbody, pageFooter("WEATHER", PAGE_WEATHER));
      break;
    }
    case PAGE_CLOCK: {
      if (cTime == "--:--" || stale) requestSnapshot(false);
      // Big clock digits with a greeting on top + date underneath
      display.clearDisplay();
      display.setTextColor(SSD1306_WHITE);
      display.setTextSize(1);
      display.setCursor(0, 0);
      display.println("Hey vaibhav");
      display.drawLine(0, 9, 127, 9, SSD1306_WHITE);
      display.setTextSize(3);
      int w = cTime.length() * 18;
      display.setCursor((128 - w) / 2, 20);
      display.println(cTime);
      display.setTextSize(1);
      display.setCursor(0, 54);
      display.println((cDate + " " + String((unsigned long)lastFlipMs) + "ms").substring(0, OLED_CHARS_PER_LINE));
      timedPush();
      break;
    }
    case PAGE_AI:
    default: {
      String body;
      if (cTranscript.length() == 0) {
        body = "Hold ACTION and ask anything.";
      } else {
        body = "T: " + cTranscript + "\nR: " + cAgentResp;
      }
      // Long Q&A auto-scrolls line-by-line like TASKS so nothing is cut off
      drawScrolled(body, &aiScroll, "AI", pageFooter("AI", PAGE_AI));
      break;
    }
  }
  // build = everything that is neither the mutex copy nor the I2C push
  // (String/wrapLines/footer work). Heap snapshot per render tracks
  // fragmentation over uptime: shrinking max-alloc blocks mean the String
  // churn is fragmenting and the hot path needs fixed char buffers.
  uiBuildMs = (millis() - tStart) - uiCopyMs - uiPushMs;
  uiFreeHeap = ESP.getFreeHeap();
  uiMaxAlloc = ESP.getMaxAllocHeap();
  return true;
}

void gotoPage(OledPage p) {
  currentPage = p;
  pageDirty = true;
  taskScroll = 0; // restart auto-scroll / note rotation from the top
  noteIdx = 0;
  aiScroll = 0;
  // Render immediately for instant feedback; data pages fetch-if-stale
  // inside renderCurrentPage (cached 30s, skipped while server is down).
  if (!isRecording && millis() > notificationUntil) {
    if (renderCurrentPage()) {
      pageDirty = false;
      lastPageRender = millis();
    }
  }
}

void initPreferences() {
  preferences.begin("second-brain", false);
  
  // WiFi is hardcoded: always "vivo 1933" PSK. Ignore any stale NVS
  // (e.g. RVCE Enterprise creds from earlier flashes) and heal it once.
  wifiSsid = DEFAULT_WIFI_SSID;
  wifiIdentity = DEFAULT_WIFI_IDENTITY;
  wifiUser = DEFAULT_WIFI_USER;
  wifiPassword = DEFAULT_WIFI_PASS;
  preferences.putString("wifiSsid", wifiSsid);
  preferences.putString("wifiIdent", wifiIdentity);
  preferences.putString("wifiUser", wifiUser);
  preferences.putString("wifiPassword", wifiPassword);
  agentHost = preferences.getString("agentHost", DEFAULT_AGENT_HOST);
  agentPort = preferences.getInt("agentPort", DEFAULT_AGENT_PORT);
  ledBehavior = preferences.getString("ledBehavior", "rainbow");
  brightness = preferences.getInt("brightness", 100);
  recordingDuration = preferences.getInt("recDuration", 3);

  if (Serial) Serial.println("--- Configuration Loaded ---");
  if (Serial) Serial.printf("SSID: %s\n", wifiSsid.c_str());
  if (wifiUser.length() > 0 && Serial) Serial.printf("EAP user: %s (PEAP/MSCHAPv2)\n", wifiUser.c_str());
  if (Serial) Serial.printf("Agent Host: %s:%d\n", agentHost.c_str(), agentPort);
  if (Serial) Serial.printf("LED Behavior: %s\n", ledBehavior.c_str());
  if (Serial) Serial.printf("Brightness: %d%%\n", brightness);
  if (Serial) Serial.printf("Recording Duration: %d seconds\n", recordingDuration);
  if (Serial) Serial.println("-----------------------------");
}

void savePreferences() {
  preferences.putString("wifiSsid", wifiSsid);
  preferences.putString("wifiIdent", wifiIdentity);
  preferences.putString("wifiUser", wifiUser);
  preferences.putString("wifiPassword", wifiPassword);
  preferences.putString("agentHost", agentHost);
  preferences.putInt("agentPort", agentPort);
  preferences.putString("ledBehavior", ledBehavior);
  preferences.putInt("brightness", brightness);
  preferences.putInt("recDuration", recordingDuration);
  if (Serial) Serial.println("[NVS] Configuration saved to flash memory.");
}

// Start a WiFi connection: WPA2-Enterprise PEAP/MSCHAPv2 when an EAP
// username is set, else plain WPA2-Personal PSK (current: vivo 1933 PSK).
void wifiStart(const char* ssid, const char* ident, const char* user, const char* pass) {
  WiFi.disconnect(true);
  delay(500);
  WiFi.mode(WIFI_STA);
  if (user != nullptr && user[0] != '\0') {
    const char* id = (ident != nullptr && ident[0] != '\0') ? ident : user;
    if (Serial) Serial.printf("[WiFi] Enterprise PEAP as '%s' (no CA verify)\n", user);
    WiFi.begin(ssid, WPA2_AUTH_PEAP, id, user, pass);
  } else {
    WiFi.begin(ssid, pass);
  }
}

void connectToWiFi(bool quick = false, bool silent = false) {
  if (Serial) Serial.printf("[WiFi] Connecting to SSID: %s\n", wifiSsid.c_str());
  wifiStart(wifiSsid.c_str(), wifiIdentity.c_str(), wifiUser.c_str(), wifiPassword.c_str());

  String modeTag = wifiUser.length() > 0 ? " (EAP)" : "";
  if (!silent) updateDisplay("CONNECTING WIFI", "SSID: " + wifiSsid + modeTag, "Connecting...");

  // Bounded attempts: full budget at boot, short budget on loop retries so
  // buttons stay responsive (the 15s timer calls us again if it fails).
  int budget = quick ? 6 : 20;
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < budget) {
    delay(500);
    if (Serial) Serial.print(".");
    
    // Blink NeoPixel in soft blue while connecting
    rgbLed.setPixelColor(0, (attempts % 2 == 0) ? rgbLed.Color(0, 0, 20) : rgbLed.Color(0, 0, 0));
    rgbLed.show();
    
    attempts++;
  }
  
  if (WiFi.status() == WL_CONNECTED) {
    if (Serial) Serial.println("\n[WiFi] Connected successfully!");
    if (Serial) Serial.printf("[WiFi] IP Address: %s\n", WiFi.localIP().toString().c_str());

    // Solid green temporarily for connected signal
    rgbLed.setPixelColor(0, rgbLed.Color(0, 20, 0));
    rgbLed.show();

    if (!silent) updateDisplay("WIFI ONLINE", "IP: " + WiFi.localIP().toString(), "Agent: " + agentHost);
  } else {
    if (Serial) Serial.printf("\n[WiFi] Connection to NVS SSID %s failed. Stashing fail-flag...\n", wifiSsid.c_str());
    lastFailedSsid = wifiSsid;
    
    // Fall back to config.h credentials if the current NVS one failed and is different
    if (wifiSsid != DEFAULT_WIFI_SSID) {
      if (Serial) Serial.printf("[WiFi] Triggering fallback to hardcoded default: %s\n", DEFAULT_WIFI_SSID);
      if (!silent) updateDisplay("WIFI FALLBACK", "SSID: " + String(DEFAULT_WIFI_SSID), "Trying default...");
      
      wifiStart(DEFAULT_WIFI_SSID, DEFAULT_WIFI_IDENTITY, DEFAULT_WIFI_USER, DEFAULT_WIFI_PASS);
      attempts = 0;
      while (WiFi.status() != WL_CONNECTED && attempts < budget) {
        delay(500);
        if (Serial) Serial.print(".");
        // Blink NeoPixel in amber during fallback
        rgbLed.setPixelColor(0, (attempts % 2 == 0) ? rgbLed.Color(20, 10, 0) : rgbLed.Color(0, 0, 0));
        rgbLed.show();
        attempts++;
      }
    }
    
    if (WiFi.status() == WL_CONNECTED) {
      if (Serial) Serial.println("\n[WiFi] Fallback connection succeeded!");
      
      // Save working default fallback WiFi back to NVS preferences to prevent future delays
      wifiSsid = DEFAULT_WIFI_SSID;
      wifiIdentity = DEFAULT_WIFI_IDENTITY;
      wifiUser = DEFAULT_WIFI_USER;
      wifiPassword = DEFAULT_WIFI_PASS;
      savePreferences();
      
      rgbLed.setPixelColor(0, rgbLed.Color(0, 20, 0));
      rgbLed.show();
      if (!silent) updateDisplay("WIFI ONLINE", "IP: " + WiFi.localIP().toString(), "Saved fallback SSID");
    } else {
      if (Serial) Serial.println("\n[WiFi] Fallback and custom connection both failed.");
      rgbLed.setPixelColor(0, rgbLed.Color(0, 0, 0));
      rgbLed.show();
      if (!silent) updateDisplay("WIFI OFFLINE", "Check router / pass", "SSID: " + wifiSsid);
    }
  }
  delay(1000);
}

void initI2S() {
  I2S.setPins(I2S_SCK_PIN, I2S_WS_PIN, -1, I2S_SD_PIN, -1);
  
  // INMP441 is 32-bit word, Stereo output (left channel active)
  bool i2sOK = I2S.begin(I2S_MODE_STD, 16000, I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO);
  
  if (!i2sOK) {
    if (Serial) Serial.println("[I2S] Initialization FAILED!");
    updateDisplay("I2S ERROR", "Mic failed to init");
    while (true) { delay(1000); }
  } else {
    if (Serial) Serial.println("[I2S] Initialization OK");
  }
}

// Create 44-byte standard WAV header
void writeWavHeader(char* buffer, int wavDataSize) {
  int totalDataLen = wavDataSize + 36;
  int byteRate = 16000 * 16 * 1 / 8; // 16000Hz Mono 16-bit (32000 bytes/sec)

  buffer[0] = 'R'; buffer[1] = 'I'; buffer[2] = 'F'; buffer[3] = 'F';
  buffer[4] = (totalDataLen & 0xff);
  buffer[5] = ((totalDataLen >> 8) & 0xff);
  buffer[6] = ((totalDataLen >> 16) & 0xff);
  buffer[7] = ((totalDataLen >> 24) & 0xff);
  
  buffer[8] = 'W'; buffer[9] = 'A'; buffer[10] = 'V'; buffer[11] = 'E';
  
  buffer[12] = 'f'; buffer[13] = 'm'; buffer[14] = 't'; buffer[15] = ' ';
  buffer[16] = 16;  // Subchunk1Size
  buffer[17] = 0; buffer[18] = 0; buffer[19] = 0;
  
  buffer[20] = 1;   // AudioFormat (PCM)
  buffer[21] = 0;
  
  buffer[22] = 1;   // NumChannels (Mono)
  buffer[23] = 0;
  
  buffer[24] = (16000 & 0xff);
  buffer[25] = ((16000 >> 8) & 0xff);
  buffer[26] = ((16000 >> 16) & 0xff);
  buffer[27] = ((16000 >> 24) & 0xff);
  
  buffer[28] = (byteRate & 0xff);
  buffer[29] = ((byteRate >> 8) & 0xff);
  buffer[30] = ((byteRate >> 16) & 0xff);
  buffer[31] = ((byteRate >> 24) & 0xff);
  
  buffer[32] = 2;   // BlockAlign
  buffer[33] = 0;
  buffer[34] = 16;  // BitsPerSample
  buffer[35] = 0;
  
  buffer[36] = 'd'; buffer[37] = 'a'; buffer[38] = 't'; buffer[39] = 'a';
  buffer[40] = (wavDataSize & 0xff);
  buffer[41] = ((wavDataSize >> 8) & 0xff);
  buffer[42] = ((wavDataSize >> 16) & 0xff);
  buffer[43] = ((wavDataSize >> 24) & 0xff);
}

// Auto-register on Agent Server
void registerDevice() {
  if (WiFi.status() != WL_CONNECTED) return;
  
  WiFiClient client;
  HTTPClient http;
  String url = "http://" + agentHost + ":" + String(agentPort) + "/api/device/register";
  
  if (Serial) Serial.printf("[HTTP] Registering device with: %s\n", url.c_str());
  http.begin(client, url);
  http.setTimeout(15000);
  http.addHeader("Content-Type", "application/json");
  
  StaticJsonDocument<200> doc;
  doc["deviceId"] = DEVICE_ID;
  doc["name"] = "Second Brain C6 Wearable";
  doc["token"] = DEVICE_TOKEN;
  
  String requestBody;
  serializeJson(doc, requestBody);
  
  int httpResponseCode = http.POST(requestBody);
  if (httpResponseCode > 0) {
    String response = http.getString();
    if (Serial) Serial.printf("[HTTP] Registration Response: %d - %s\n", httpResponseCode, response.c_str());
  } else {
    if (Serial) Serial.printf("[HTTP] Registration Error code: %d\n", httpResponseCode);
    if (agentHost != DEFAULT_AGENT_HOST) {
      if (Serial) Serial.printf("[HTTP] Registration failed. Falling back to default agent host: %s\n", DEFAULT_AGENT_HOST);
      agentHost = DEFAULT_AGENT_HOST;
      agentPort = DEFAULT_AGENT_PORT;
      savePreferences();
    }
  }
  http.end();
}

// Network-task side heartbeat: POST stats, sync settings/clock/commands.
// NEVER called from loop() — it blocks on HTTP. UI side-effects are queued
// as alertPending/navPending flags for loop() to draw.
void doHeartbeat() {
  if (WiFi.status() != WL_CONNECTED) return;

  String url;
  xSemaphoreTake(netMutex, portMAX_DELAY);
  url = "http://" + agentHost + ":" + String(agentPort) + "/api/device/heartbeat";
  bool knownUp = serverOnline;
  xSemaphoreGive(netMutex);

  WiFiClient client;
  HTTPClient http;
  http.begin(client, url);
  http.setTimeout(knownUp ? 8000 : 4000);
  http.addHeader("Content-Type", "application/json");

  StaticJsonDocument<200> doc;
  doc["deviceId"] = DEVICE_ID;
  doc["battery"] = 85; // Simulated battery state
  doc["firmware"] = "0.1.0";

  String requestBody;
  serializeJson(doc, requestBody);

  int httpResponseCode = http.POST(requestBody);
  String response = (httpResponseCode > 0) ? http.getString() : "";
  http.end();

  xSemaphoreTake(netMutex, portMAX_DELAY);
  serverOnline = (httpResponseCode > 0); // any HTTP reply = reachable
  xSemaphoreGive(netMutex);

  if (httpResponseCode <= 0) {
    if (Serial) Serial.printf("[Heartbeat] Error connecting to server: %d\n", httpResponseCode);
    if (Serial) Serial.printf("[Heartbeat] Tried: %s -- verify laptop IP + dev server\n", url.c_str());
    xSemaphoreTake(netMutex, portMAX_DELAY);
    if (agentHost != DEFAULT_AGENT_HOST) {
      if (Serial) Serial.printf("[Heartbeat] Heartbeat failed. Falling back to default agent host: %s\n", DEFAULT_AGENT_HOST);
      agentHost = DEFAULT_AGENT_HOST;
      agentPort = DEFAULT_AGENT_PORT;
      xSemaphoreGive(netMutex);
      savePreferences();
    } else {
      xSemaphoreGive(netMutex);
    }
    return;
  }

  if (Serial) Serial.printf("[Heartbeat] Code: %d\n", httpResponseCode);

  // Parse response configurations
  DynamicJsonDocument respDoc(1536);
  DeserializationError error = deserializeJson(respDoc, response);
  if (error) return;

  xSemaphoreTake(netMutex, portMAX_DELAY);
  // Wall-clock for the OLED CLOCK page (device has no RTC)
  if (respDoc.containsKey("time")) snapTime = respDoc["time"].as<String>();
  if (respDoc.containsKey("date")) snapDate = respDoc["date"].as<String>();
  // Sync settings
  if (respDoc.containsKey("settings")) {
    JsonObject settings = respDoc["settings"];

    bool settingsChanged = false;

    // WiFi is hardcoded to "vivo 1933" — ignore any server-pushed WiFi
    // credentials so the device can never roam to another network.

    if (settings.containsKey("ledBehavior") && settings["ledBehavior"].as<String>() != ledBehavior) {
      ledBehavior = settings["ledBehavior"].as<String>();
      settingsChanged = true;
    }
    if (settings.containsKey("brightness") && settings["brightness"].as<int>() != brightness) {
      brightness = settings["brightness"].as<int>();
      settingsChanged = true;
    }
    if (settings.containsKey("recordingDuration") && settings["recordingDuration"].as<int>() != recordingDuration) {
      recordingDuration = settings["recordingDuration"].as<int>();
      settingsChanged = true;
    }

    if (settingsChanged) {
      if (Serial) Serial.println("[Sync] Configuration updated from dashboard settings!");
      xSemaphoreGive(netMutex);
      savePreferences();
    } else {
      xSemaphoreGive(netMutex);
    }
  } else {
    xSemaphoreGive(netMutex);
  }

  // Queue incoming commands for loop() to display (never draw from here)
  if (respDoc.containsKey("command")) {
    String command = respDoc["command"].as<String>();
    if (Serial) Serial.printf("[Command] Received remote instruction: %s\n", command.c_str());

    if (command == "notification") {
      xSemaphoreTake(netMutex, portMAX_DELAY);
      alertTitle = respDoc["title"].as<String>();
      alertMsg = respDoc["message"].as<String>();
      alertPending = true;
      xSemaphoreGive(netMutex);
    } else if (command == "navigate") {
      xSemaphoreTake(netMutex, portMAX_DELAY);
      navTarget = respDoc.containsKey("target") ? respDoc["target"].as<String>() : "notes";
      navPending = true;
      xSemaphoreGive(netMutex);
    }
  }
}

// Record voice audio from I2S and send to /api/device/voice
void recordAndUploadVoice() {
  if (Serial) Serial.println("[Record] Triggered voice record. Initializing buffer...");

  // Snapshot shared settings once (network task may rewrite them mid-flow)
  int recDur;
  int bright;
  String uh;
  int up;
  xSemaphoreTake(netMutex, portMAX_DELAY);
  recDur = recordingDuration;
  bright = brightness;
  uh = agentHost;
  up = agentPort;
  xSemaphoreGive(netMutex);

  // Calculate WAV size for 16-bit Mono (16000Hz)
  size_t pcmDataSize = recDur * 16000 * sizeof(int16_t);
  wavBufferSize = pcmDataSize + 44; // 44 bytes header + PCM data
  
  wavBuffer = (char*) malloc(wavBufferSize);
  if (wavBuffer == nullptr) {
    if (Serial) Serial.println("[Record] Failed to allocate memory for recording buffer.");
    updateDisplay("OOM ERROR", "Could not allocate", "recording buffer");
    delay(2000);
    return;
  }

  // Write base WAV header
  writeWavHeader(wavBuffer, pcmDataSize);
  
  // Setup recording indicators
  isRecording = true;
  if (Serial) Serial.printf("[Record] Capturing I2S audio for %d seconds...\n", recDur);
  
  size_t bytesRecorded = 0;
  int32_t i2sSamples[512]; // Input buffer for I2S read (2KB chunks = less per-call overhead)
  char* dataOffset = wavBuffer + 44;

  unsigned long startRecTime = millis();
  unsigned long lastDisplayUpdate = 0;

  while (bytesRecorded < pcmDataSize && (millis() - startRecTime < (recDur * 1000 + 500))) {
    // Pulse indicator LED in red during recording (respecting brightness settings)
    int maxVal = map(bright, 0, 100, 0, 40);
    int pulseVal = (int)(maxVal * (0.5 + 0.5 * sin(millis() / 150.0)));
    rgbLed.setPixelColor(0, rgbLed.Color(pulseVal, 0, 0));
    rgbLed.show();

    // Read 32-bit Stereo data from I2S
    size_t bytesRead = I2S.readBytes((char*)i2sSamples, sizeof(i2sSamples));
    int count = bytesRead / sizeof(int32_t);

    // Convert Stereo 32-bit (INMP441 left channel) to Mono 16-bit signed PCM
    for (int i = 0; i < count; i += 2) {
      if (bytesRecorded < pcmDataSize) {
        int16_t sample16 = (int16_t)(i2sSamples[i] >> 16);
        memcpy(dataOffset + bytesRecorded, &sample16, sizeof(int16_t));
        bytesRecorded += sizeof(int16_t);
      }
    }

    // Draw recording state at ~4fps. display.display() pushes 1KB over I2C
    // (~25ms); doing it every loop iteration starves I2S and capture stalls
    // at ~27KB instead of the full 160KB.
    if (millis() - lastDisplayUpdate >= 250) {
      lastDisplayUpdate = millis();
      float progress = (float)bytesRecorded / pcmDataSize;
      display.clearDisplay();
      display.setTextColor(SSD1306_WHITE);
      display.setTextSize(1);
      display.setCursor(0, 0);
      display.println("RECORDING VOICE...");
      display.drawLine(0, 9, 127, 9, SSD1306_WHITE);

      display.setCursor(0, 16);
      display.printf("Capture: %.1fs / %ds", (float)(millis() - startRecTime)/1000.0, recDur);

      display.drawRect(0, 32, 128, 10, SSD1306_WHITE);
      display.fillRect(2, 34, progress * 124, 6, SSD1306_WHITE);

      display.setCursor(0, 52);
      display.println("Release btn when done");
      display.display();
    }
  }
  
  isRecording = false;
  
  if (Serial) Serial.printf("[Record] Finished capture. Recorded: %d bytes. Checking energy...\n", bytesRecorded);

  // Local silence gate: skip upload when nothing was actually spoken.
  // The server rejects silence with 422 NO_SPEECH, but catching it here
  // saves ~160KB of upload + a 30s AI round-trip on every empty press.
  {
    int16_t* samples = (int16_t*)dataOffset;
    size_t sampleCount = bytesRecorded / sizeof(int16_t);
    long peak = 0;
    int64_t sumSq = 0; // 64-bit: 32-bit long overflows and prints rms=2147483647
    long voiced = 0;
    size_t step = sampleCount / 4000;
    if (step < 1) step = 1;
    long evaluated = 0;
    for (size_t i = 0; i < sampleCount; i += step) {
      long s = samples[i];
      long a = s < 0 ? -s : s;
      if (a > peak) peak = a;
      sumSq += (int64_t)s * (int64_t)s;
      if (a > 500) voiced++;
      evaluated++;
    }
    long rms = evaluated > 0 ? (long)sqrt((double)sumSq / (double)evaluated) : 0;
    float voicedRatio = evaluated > 0 ? (float)voiced / evaluated : 0;
    if (Serial) Serial.printf("[Record] Energy: rms=%ld peak=%ld voiced=%.1f%%\n", rms, peak, voicedRatio * 100.0);
    // Raw sample dump: real speech bounces around (e.g. -500..3000..-200..);
    // a dead/floating data line shows all-0s or all-32767/-32768.
    if (sampleCount >= 8) {
      if (Serial) Serial.printf("[Record] Samples[0..7]: %d %d %d %d %d %d %d %d\n",
        samples[0], samples[1], samples[2], samples[3],
        samples[4], samples[5], samples[6], samples[7]);
    }
    if (Serial) Serial.printf("[Record] Capture stats: %u of %u bytes (%.0f%% of expected %.1fs audio)\n",
      bytesRecorded, pcmDataSize,
      pcmDataSize > 0 ? 100.0f * bytesRecorded / pcmDataSize : 0,
      pcmDataSize > 0 ? (float)bytesRecorded / 32000.0f : 0);
    if (rms < 150 || peak < 800 || voicedRatio < 0.02) {
      if (Serial) Serial.println("[Record] Silence detected. Skipping upload.");
      updateDisplay("NO SPEECH", "Nothing heard.", "Hold & speak loudly");
      delay(2000);
      free(wavBuffer);
      wavBuffer = nullptr;
      return;
    }
  }

  if (Serial) Serial.printf("[Record] Speech detected. Uploading payload...\n");
  // Trim leading/trailing near-silence (|sample| <= 500, same floor as the
  // gate above) so quiet hold-to-talk edges aren't uploaded as paid bytes.
  // A ~0.1s margin each side keeps word onsets intact.
  {
    int16_t* samples = (int16_t*)dataOffset;
    size_t sampleCount = bytesRecorded / sizeof(int16_t);
    size_t first = 0;
    while (first < sampleCount) {
      int s = samples[first];
      if (s < 0) s = -s;
      if (s > 500) break;
      first++;
    }
    size_t last = sampleCount;
    while (last > first) {
      int s = samples[last - 1];
      if (s < 0) s = -s;
      if (s > 500) break;
      last--;
    }
    const size_t margin = 1600; // ~0.1s at 16kHz
    if (first > margin) first -= margin; else first = 0;
    if (last + margin < sampleCount) last += margin; else last = sampleCount;
    // Keep at least 0.4s so the server-side silence gate never sees a sliver
    if (last > first && (last - first) >= 6400 && (last - first) < sampleCount) {
      size_t trimmedBytes = (last - first) * sizeof(int16_t);
      memmove(dataOffset, samples + first, trimmedBytes);
      if (Serial) Serial.printf("[Record] Trimmed silence: %u -> %u bytes\n", bytesRecorded, trimmedBytes);
      bytesRecorded = trimmedBytes;
    }
  }
  // Shrink the WAV to what was actually captured: the tail of the buffer is
  // zeros when I2S starved, which only confuses the server-side speech check.
  writeWavHeader(wavBuffer, bytesRecorded);
  size_t uploadSize = bytesRecorded + 44;
  if (Serial) Serial.printf("[Record] Uploading %u bytes (header + %u PCM)...\n", uploadSize, bytesRecorded);
  updateDisplay("UPLOADING...", "Transmitting wave file", "to Agent Server...");
  
  // Upload buffer to API
  if (WiFi.status() == WL_CONNECTED) {
    WiFiClient client;
    HTTPClient http;
    String url = "http://" + uh + ":" + String(up) + "/api/device/voice";
    
    http.begin(client, url);
    // AI pipeline (STT + LLM) via the hcnsec proxy can take 30-60s.
    // Must exceed worst-case server time or POST aborts with -11 (read timeout).
    http.setTimeout(90000); // 90s timeout for AI intent processing
    http.addHeader("X-Device-ID", DEVICE_ID);
    http.addHeader("Authorization", "Bearer " + String(DEVICE_TOKEN));
    http.addHeader("Content-Type", "audio/wav");

    unsigned long postStart = millis();
    int httpResponseCode = http.POST((uint8_t*)wavBuffer, uploadSize);
    unsigned long postMs = millis() - postStart;
    if (Serial) Serial.printf("[HTTP] POST total %lums (upload+server wait)\n", postMs);
    if (httpResponseCode > 0) {
      String response = http.getString();
      if (Serial) Serial.printf("[HTTP] Upload Response: %d\n", httpResponseCode);
      
      // Output response text — rendered word-wrapped, never cut mid-word.
      DynamicJsonDocument responseDoc(2048);
      DeserializationError error = deserializeJson(responseDoc, response);
      if (!error && responseDoc.containsKey("response")) {
        String agentResp = responseDoc["response"].as<String>();
        String transcript = responseDoc.containsKey("transcript") ? responseDoc["transcript"].as<String>() : "";
        bool success = !responseDoc.containsKey("success") || responseDoc["success"].as<bool>();

        if (Serial) Serial.printf("[Voice] Transcript: \"%s\"\n", transcript.c_str());
        if (Serial) Serial.printf("[Agent] Response: \"%s\"\n", agentResp.c_str());

        // Remember the exchange for the AI page, then show it as an overlay.
        // After the overlay expires the loop renders the (possibly jumped) page.
        notificationUntil = millis() + 6000;
        if (success) {
          lastTranscript = transcript;
          lastAgentResp = agentResp;
          if (responseDoc.containsKey("page")) {
            String pg = responseDoc["page"].as<String>();
            gotoPage(pageForName(pg));
            drawPage("OPENING " + String(PAGE_NAMES[currentPage]), agentResp, pageFooter(PAGE_NAMES[currentPage], currentPage));
          } else {
            currentPage = PAGE_AI;
            pageDirty = true;
            drawPage("AGENT", "T: " + transcript + "\nR: " + agentResp, pageFooter("AI", PAGE_AI));
          }
        } else {
          // Server rejected the clip (NO_SPEECH / STT offline) — no task created
          drawPage("TRY AGAIN", agentResp + "\nHold & speak clearly", "");
          delay(2000);
        }
      } else {
        if (Serial) Serial.printf("[HTTP] Raw response: %s\n", response.c_str());
        drawPage("UPLOAD DONE", "Server updated.", "");
        delay(1500);
      }
    } else {
      if (Serial) Serial.printf("[HTTP] Error sending WAV data: %d\n", httpResponseCode);
      if (httpResponseCode == -1) {
        // HTTPC_ERROR_CONNECTION_REFUSED: nothing listening at agentHost:agentPort.
        // Laptop IP may have changed (DHCP) or `npm run dev` isn't running.
        if (Serial) Serial.printf("[HTTP] Tried: %s -- verify laptop IP + dev server\n", url.c_str());
        updateDisplay("SERVER DOWN", "Check laptop IP", "Is npm run dev on?");
      } else if (httpResponseCode == -11) {
        // HTTPC_ERROR_READ_TIMEOUT: server still processing (> timeout).
        // Check `npm run dev` logs for POST /api/device/voice.
        // postMs names the total wait so upload-vs-server is never guessed.
        updateDisplay("SERVER SLOW", "Waited " + String(postMs / 1000) + "s thinking...", "Wait & retry once");
      } else {
        updateDisplay("UPLOAD ERROR", "Code: " + String(httpResponseCode), "Retry again");
      }
      delay(2000);
    }
    http.end();
  } else {
    if (Serial) Serial.println("[HTTP] Cannot upload. WiFi not connected.");
    updateDisplay("UPLOAD FAILED", "WiFi offline", "Reconnect and retry");
    delay(2000);
  }
  
  // Free buffers
  free(wavBuffer);
  wavBuffer = nullptr;
}

// LED Behavior State loop
void updateLED() {
  if (isRecording) return; // Managed by recording loop

  // Try-take: reuse cached values rather than stall the loop on the mutex
  if (xSemaphoreTake(netMutex, 0) == pdTRUE) {
    cachedLedBehavior = ledBehavior;
    cachedBrightness = brightness;
    xSemaphoreGive(netMutex);
  }
  String lb = cachedLedBehavior;
  int bright = cachedBrightness;

  // Map brightness (0 to 100) to NeoPixel scale (0 to 40) to keep it pleasant and not blinding
  int maxVal = map(bright, 0, 100, 0, 40);
  if (maxVal < 0) maxVal = 0;
  if (maxVal > 40) maxVal = 40;

  if (lb == "rainbow") {
    // Breathy rainbow/purple transition
    float angle = millis() / 1000.0;
    int r = (int)(maxVal * (0.5 + 0.5 * sin(angle)));
    int g = (int)(maxVal * (0.5 + 0.5 * sin(angle + 2.0 * PI / 3.0)));
    int b = (int)(maxVal * (0.5 + 0.5 * sin(angle + 4.0 * PI / 3.0)));
    rgbLed.setPixelColor(0, rgbLed.Color(r, g, b));
  } 
  else if (lb == "pulse_blue") {
    // Pulse Blue
    int pulseVal = (int)(maxVal * (0.5 + 0.5 * sin(millis() / 400.0)));
    rgbLed.setPixelColor(0, rgbLed.Color(0, 0, pulseVal));
  } 
  else if (lb == "pulse_yellow") {
    // Pulse Yellow
    int pulseVal = (int)(maxVal * (0.5 + 0.5 * sin(millis() / 300.0)));
    rgbLed.setPixelColor(0, rgbLed.Color(pulseVal, (int)(pulseVal * 0.8), 0));
  } 
  else if (lb == "solid_green") {
    rgbLed.setPixelColor(0, rgbLed.Color(0, maxVal, 0));
  } 
  else { // "off" or default
    rgbLed.setPixelColor(0, rgbLed.Color(0, 0, 0));
  }
  rgbLed.show();
}

// Background worker: owns ALL slow network I/O (heartbeat, snapshot fetch,
// wifi retries) so loop() — buttons + screen — never blocks on the network.
// Runs at lower priority than loop(), so any button press preempts it.
void networkTask(void* arg) {
  (void)arg;
  unsigned long lastWifiRetry = 0;
  unsigned long lastNetCache = 0;
  unsigned long lastHeartbeatSent = 0;
  bool heartbeatSentOnce = false;
  for (;;) {
    if (WiFi.status() != WL_CONNECTED) {
      if (millis() - lastWifiRetry >= 15000) {
        lastWifiRetry = millis();
        if (Serial) Serial.println("[WiFi] Lost connection. Attempting reconnection...");
        connectToWiFi(true, true); // quick + silent: no screen stomping
      }
    } else {
      // Refresh the STATUS page's IP/RSSI copy every ~5s (background, never
      // on the button path — driver queries can stall under weak signal).
      if (millis() - lastNetCache >= 5000) {
        lastNetCache = millis();
        String ip = WiFi.localIP().toString();
        long rssi = WiFi.RSSI();
        xSemaphoreTake(netMutex, portMAX_DELAY);
        cachedIp = ip;
        cachedRssi = rssi;
        xSemaphoreGive(netMutex);
      }
      if (wantHeartbeat) {
        // Postpone routine heartbeats while the user is actively pressing, so
        // radio traffic never contends with the button path on this
        // single-core chip. Hard ceiling: the dashboard's online threshold is
        // 45s, so a heartbeat is never deferred past it.
        unsigned long idleMs = millis() - (unsigned long)lastUserActivity;
        if (idleMs < 3000 && heartbeatSentOnce && millis() - lastHeartbeatSent < 45000) {
          // keep the flag — next round will send it once fingers are off
        } else {
          wantHeartbeat = false;
          doHeartbeat();
          lastHeartbeatSent = millis();
          heartbeatSentOnce = true;
        }
      }
      if (wantSnapshot) {
        bool force = snapshotForce;
        snapshotForce = false;
        wantSnapshot = false;
        doSnapshotFetch(force);
      }
      // No background warming fetch here by design. Snapshots are fetched
      // strictly on demand — a visible data page went stale and asked — so
      // the radio sits idle while the user just flips around. The flip
      // itself always renders instantly from cache ("Loading..." at worst,
      // fresh data popping in a second later).
    }
    vTaskDelay(pdMS_TO_TICKS(50));
  }
}

void setup() {
  Serial.begin(115200);
  // No-host backstop: with no serial monitor draining USB-CDC, an undrained
  // TX FIFO stalls every print (up to ~1s each) — buttons feel instant with
  // the monitor open and laggy without it. Cap any single write at 10ms so
  // logging can never again hold the loop hostage; every log site below is
  // additionally gated on `if (Serial)` so nothing is even attempted unheard.
  Serial.setTxTimeoutMs(10);
  delay(2000);
  if (Serial) Serial.println("--- Starting Second Brain ESP32-C6 Node ---");

  // Must exist before any shared-state access below
  netMutex = xSemaphoreCreateMutex();
  btnSem = xSemaphoreCreateBinary(); // starts empty: loop timeout-waits on it
  pinMode(BUTTON_UP, INPUT_PULLUP);
  pinMode(BUTTON_ACTION, INPUT_PULLUP);
  pinMode(BUTTON_DOWN, INPUT_PULLUP);

  // Latch every press as an interrupt event — never missed, even mid-stall
  attachInterrupt(digitalPinToInterrupt(BUTTON_UP), onUpButton, FALLING);
  attachInterrupt(digitalPinToInterrupt(BUTTON_ACTION), onActionButton, FALLING);
  attachInterrupt(digitalPinToInterrupt(BUTTON_DOWN), onDownButton, FALLING);
  
  // Initialize onboard NeoPixel
  rgbLed.begin();
  rgbLed.setPixelColor(0, rgbLed.Color(20, 10, 0)); // Soft amber during boot
  rgbLed.show();
  
  initOLED();
  updateDisplay("BOOTING...", "Loading configuration...");
  
  initPreferences();
  connectToWiFi();
  registerDevice();
  initI2S();

  // Hand all slow network I/O to the background task; loop() keeps buttons+screen.
  xTaskCreate(networkTask, "net", 10240, NULL, 1, &netTaskHandle);
  // Loop above network: a press redraws instantly even mid-download.
  vTaskPrioritySet(NULL, 2);

  if (Serial) Serial.println("[Setup] Device is fully running and listening.");
}

void loop() {
  unsigned long loopStart = millis();
  rearmButtons(); // release-arm UP/DOWN/ACTION before consuming anything

  // WiFi retries + heartbeat + snapshot all live in networkTask now.
  // Loop only raises flags and keeps buttons + screen instant.
  if (millis() - lastHeartbeatTime >= heartbeatInterval) {
    wantHeartbeat = true;
    lastHeartbeatTime = millis();
  }
  
  // ACTION button: consume the interrupt-latched press (debounce-confirm read)
  if (actionPressed && !isRecording) {
    actionPressed = false;
    delay(50);
    if (digitalRead(BUTTON_ACTION) == LOW) {
      lastUserActivity = millis();
      // Drop any UP/DOWN presses queued earlier so we don't flip pages
      // as a surprise after talking (and drain anything that lands during
      // the blocking voice flow itself on the way out — see below)
      noInterrupts();
      upQueue = 0;
      downQueue = 0;
      interrupts();
      inVoiceFlow = true; // skip stall watchdog: recording+upload blocks by design
      recordAndUploadVoice();
      // Wait for release
      while(digitalRead(BUTTON_ACTION) == LOW) {
        delay(10);
      }
      actionPressed = false; // drop bounces that landed mid-recording
      noInterrupts();
      upQueue = 0;
      downQueue = 0;
      interrupts();
      inVoiceFlow = false;
    }
  }

  // UP/DOWN flip OLED pages (CLOCK/STATUS/TASKS/NOTES/WEATHER/AI).
  // Queues drain atomically, net displacement flips once, and only the final
  // page renders — three fast taps cost one ~13ms redraw, not three.
  // justFlipped skips the LED push below so the measured press-to-screen
  // path pays for nothing but the redraw itself.
  bool justFlipped = false;
  if (!isRecording) {
    uint8_t nUp, nDn;
    unsigned long upStamp, downStamp;
    noInterrupts();
    nUp = upQueue; upQueue = 0;
    nDn = downQueue; downQueue = 0;
    upStamp = upIsrStamp; downStamp = downIsrStamp;
    interrupts();
    int net = (int)nDn - (int)nUp;
    if (net != 0) {
      unsigned long t0 = millis();
      lastUserActivity = t0;
      // queued = age of the oldest unhandled tap in this batch
      unsigned long firstStamp = (nUp > 0 && nDn > 0)
        ? (upStamp < downStamp ? upStamp : downStamp)
        : (nUp > 0 ? upStamp : downStamp);
      unsigned long waitMs = t0 - firstStamp;
      notificationUntil = 0; // dismiss any stale overlay first so the flip draws
      int dest = ((int)currentPage + net) % PAGE_COUNT;
      if (dest < 0) dest += PAGE_COUNT;
      gotoPage((OledPage)dest);
      lastFlipMs = millis() - t0;
      justFlipped = true;
      // Gated: USB CDC can block ~1s per print when no monitor is attached —
      // never stall the button path on a debug line.
      // flips = net page displacement in this batch (|.|>1 means taps queued
      // behind one render and all landed — none eaten).
      if (Serial) Serial.printf("[UI] Page:%s queued:%lums draw:%lums flips:%d copy:%lu build:%lu push:%lu%s heap:%lu/%lu\n",
        PAGE_NAMES[currentPage], waitMs, lastFlipMs, net,
        uiCopyMs, uiBuildMs, uiPushMs, uiPushSlow ? " SLOWPUSH" : "",
        (unsigned long)uiFreeHeap, (unsigned long)uiMaxAlloc);
    }
  } else {
    // Recording owns the mic + screen; discard page flips queued mid-capture
    noInterrupts();
    upQueue = 0;
    downQueue = 0;
    interrupts();
  }

  // Dashboard-pushed events queued by the network task (loop owns the screen).
  // Bounded mutex takes: a busy network publish costs a retry next loop,
  // never an unbounded stall of the button path.
  if (alertPending && !isRecording) {
    String t, m;
    int bright;
    if (xSemaphoreTake(netMutex, pdMS_TO_TICKS(50)) != pdTRUE) {
      // busy — keep pending, retry next loop
    } else {
      t = alertTitle; m = alertMsg; alertPending = false;
      bright = brightness;
      xSemaphoreGive(netMutex);
      if (Serial) Serial.printf(">>> ALERT: %s - %s <<<\n", t.c_str(), m.c_str());
      notificationUntil = millis() + 5000;
      drawPage("ALERT", t + "\n" + m, "");
      int maxVal = map(bright, 0, 100, 0, 40);
      if (maxVal < 0) maxVal = 0;
      if (maxVal > 40) maxVal = 40;
      rgbLed.setPixelColor(0, rgbLed.Color(maxVal, maxVal, 0));
      rgbLed.show();
      alertBlink = true;
      alertBlinkStep = 0;
      alertBlinkAt = millis();
      alertBlinkMax = maxVal;
    }
  }
  // Blink pump: 4 yellow blinks, one 100ms step per loop, buttons live throughout
  if (alertBlink && !isRecording) {
    if (millis() - alertBlinkAt >= 100) {
      alertBlinkAt = millis();
      alertBlinkStep++;
      if (alertBlinkStep >= 8) {
        alertBlink = false; // next updateLED() resumes normal behavior
      } else if (alertBlinkStep % 2 == 0) {
        rgbLed.setPixelColor(0, rgbLed.Color(alertBlinkMax, alertBlinkMax, 0));
        rgbLed.show();
      } else {
        rgbLed.setPixelColor(0, rgbLed.Color(0, 0, 0));
        rgbLed.show();
      }
    }
  }
  if (navPending && !isRecording) {
    String target;
    if (xSemaphoreTake(netMutex, pdMS_TO_TICKS(50)) != pdTRUE) {
      // busy — keep pending, retry next loop
    } else {
      target = navTarget; navPending = false;
      xSemaphoreGive(netMutex);
      if (Serial) Serial.printf("[Command] Jump to page for target: %s\n", target.c_str());
      notificationUntil = millis() + 4000;
      gotoPage(pageForTarget(target));
      drawPage("OPENING", target, pageFooter(PAGE_NAMES[currentPage], currentPage));
    }
  }

  // Render the active page when no overlay is showing. Throttled: a full
  // SSD1306 redraw costs I2C time (~13ms at 800kHz), so never do it every loop.
  // TASKS/AI scroll one line per tick, NOTES flips one note per tick.
  if (!isRecording && millis() > notificationUntil) {
    unsigned long interval = 5000;
    if (currentPage == PAGE_TASKS) interval = 2500;
    else if (currentPage == PAGE_NOTES) interval = 3000;
    else if (currentPage == PAGE_AI) interval = 2500;
    if (pageDirty || millis() - lastPageRender >= interval) {
      if (renderCurrentPage()) {
        pageDirty = false;
        lastPageRender = millis();
      }
    }
  }

  // Update hardware visual indicator (skipped on flip iterations: the LED
  // push is deferred one loop so the button path stays pure redraw; and
  // while the alert blink state machine owns the LED)
  if (!justFlipped && !alertBlink) updateLED();

  // Stall watchdog: anything (outside voice flow) holding the loop >2s eats
  // button presses — this line names the culprit in the serial log.
  unsigned long loopMs = millis() - loopStart;
  if (loopMs > 2000 && !inVoiceFlow) {
    if (Serial) Serial.printf("[Loop] stall %lums (buttons were blind during this)\n", loopMs);
  }

  // Event-driven cadence: sleep until a button ISR wakes us (press handled
  // in one context switch, not at the next poll boundary) or 2ms elapses
  // for housekeeping (LED breathing, scroll ticks). Same yield as delay(2),
  // strictly faster wake on press.
  xSemaphoreTake(btnSem, pdMS_TO_TICKS(2));
}
