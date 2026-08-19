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
#include "config.h"

// Active configuration state (loaded from NVS or config.h)
String wifiSsid;
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
const unsigned long heartbeatInterval = 10000; // 10 seconds

// Button state variables
bool isRecording = false;
bool lastActionBtn = HIGH;

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

  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("OLED initialization failed!");
  } else {
    Serial.println("OLED Initialized.");
    display.clearDisplay();
    display.display();
  }
}

void initPreferences() {
  preferences.begin("second-brain", false);
  
  // Read saved values or fall back to config.h values
  wifiSsid = preferences.getString("wifiSsid", DEFAULT_WIFI_SSID);
  wifiPassword = preferences.getString("wifiPassword", DEFAULT_WIFI_PASS);
  agentHost = preferences.getString("agentHost", DEFAULT_AGENT_HOST);
  agentPort = preferences.getInt("agentPort", DEFAULT_AGENT_PORT);
  ledBehavior = preferences.getString("ledBehavior", "rainbow");
  brightness = preferences.getInt("brightness", 100);
  recordingDuration = preferences.getInt("recDuration", 5);

  Serial.println("--- Configuration Loaded ---");
  Serial.printf("SSID: %s\n", wifiSsid.c_str());
  Serial.printf("Agent Host: %s:%d\n", agentHost.c_str(), agentPort);
  Serial.printf("LED Behavior: %s\n", ledBehavior.c_str());
  Serial.printf("Brightness: %d%%\n", brightness);
  Serial.printf("Recording Duration: %d seconds\n", recordingDuration);
  Serial.println("-----------------------------");
}

void savePreferences() {
  preferences.putString("wifiSsid", wifiSsid);
  preferences.putString("wifiPassword", wifiPassword);
  preferences.putString("agentHost", agentHost);
  preferences.putInt("agentPort", agentPort);
  preferences.putString("ledBehavior", ledBehavior);
  preferences.putInt("brightness", brightness);
  preferences.putInt("recDuration", recordingDuration);
  Serial.println("[NVS] Configuration saved to flash memory.");
}

void connectToWiFi() {
  Serial.printf("[WiFi] Connecting to SSID: %s\n", wifiSsid.c_str());
  WiFi.disconnect(true);
  delay(500);
  WiFi.begin(wifiSsid.c_str(), wifiPassword.c_str());
  
  updateDisplay("CONNECTING WIFI", "SSID: " + wifiSsid, "Connecting...");
  
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(500);
    Serial.print(".");
    
    // Blink NeoPixel in soft blue while connecting
    rgbLed.setPixelColor(0, (attempts % 2 == 0) ? rgbLed.Color(0, 0, 20) : rgbLed.Color(0, 0, 0));
    rgbLed.show();
    
    attempts++;
  }
  
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n[WiFi] Connected successfully!");
    Serial.printf("[WiFi] IP Address: %s\n", WiFi.localIP().toString().c_str());
    
    // Solid green temporarily for connected signal
    rgbLed.setPixelColor(0, rgbLed.Color(0, 20, 0));
    rgbLed.show();
    
    updateDisplay("WIFI ONLINE", "IP: " + WiFi.localIP().toString(), "Agent: " + agentHost);
  } else {
    Serial.printf("\n[WiFi] Connection to NVS SSID %s failed. Stashing fail-flag...\n", wifiSsid.c_str());
    lastFailedSsid = wifiSsid;
    
    // Fall back to config.h credentials if the current NVS one failed and is different
    if (wifiSsid != DEFAULT_WIFI_SSID) {
      Serial.printf("[WiFi] Triggering fallback to hardcoded default: %s\n", DEFAULT_WIFI_SSID);
      updateDisplay("WIFI FALLBACK", "SSID: " + String(DEFAULT_WIFI_SSID), "Trying default...");
      
      WiFi.disconnect(true);
      delay(500);
      WiFi.begin(DEFAULT_WIFI_SSID, DEFAULT_WIFI_PASS);
      attempts = 0;
      while (WiFi.status() != WL_CONNECTED && attempts < 20) {
        delay(500);
        Serial.print(".");
        // Blink NeoPixel in amber during fallback
        rgbLed.setPixelColor(0, (attempts % 2 == 0) ? rgbLed.Color(20, 10, 0) : rgbLed.Color(0, 0, 0));
        rgbLed.show();
        attempts++;
      }
    }
    
    if (WiFi.status() == WL_CONNECTED) {
      Serial.println("\n[WiFi] Fallback connection succeeded!");
      
      // Save working default fallback WiFi back to NVS preferences to prevent future delays
      wifiSsid = DEFAULT_WIFI_SSID;
      wifiPassword = DEFAULT_WIFI_PASS;
      savePreferences();
      
      rgbLed.setPixelColor(0, rgbLed.Color(0, 20, 0));
      rgbLed.show();
      updateDisplay("WIFI ONLINE", "IP: " + WiFi.localIP().toString(), "Saved fallback SSID");
    } else {
      Serial.println("\n[WiFi] Fallback and custom connection both failed.");
      rgbLed.setPixelColor(0, rgbLed.Color(0, 0, 0));
      rgbLed.show();
      updateDisplay("WIFI OFFLINE", "Check router / pass", "SSID: " + wifiSsid);
    }
  }
  delay(1000);
}

void initI2S() {
  I2S.setPins(I2S_SCK_PIN, I2S_WS_PIN, -1, I2S_SD_PIN, -1);
  
  // INMP441 is 32-bit word, Stereo output (left channel active)
  bool i2sOK = I2S.begin(I2S_MODE_STD, 16000, I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO);
  
  if (!i2sOK) {
    Serial.println("[I2S] Initialization FAILED!");
    updateDisplay("I2S ERROR", "Mic failed to init");
    while (true) { delay(1000); }
  } else {
    Serial.println("[I2S] Initialization OK");
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
  
  Serial.printf("[HTTP] Registering device with: %s\n", url.c_str());
  http.begin(client, url);
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
    Serial.printf("[HTTP] Registration Response: %d - %s\n", httpResponseCode, response.c_str());
  } else {
    Serial.printf("[HTTP] Registration Error code: %d\n", httpResponseCode);
    if (agentHost != DEFAULT_AGENT_HOST) {
      Serial.printf("[HTTP] Registration failed. Falling back to default agent host: %s\n", DEFAULT_AGENT_HOST);
      agentHost = DEFAULT_AGENT_HOST;
      agentPort = DEFAULT_AGENT_PORT;
      savePreferences();
    }
  }
  http.end();
}

// Send periodic heartbeat & fetch updated configurations from queue
void sendHeartbeat() {
  if (WiFi.status() != WL_CONNECTED) return;
  
  WiFiClient client;
  HTTPClient http;
  String url = "http://" + agentHost + ":" + String(agentPort) + "/api/device/heartbeat";
  
  http.begin(client, url);
  http.addHeader("Content-Type", "application/json");
  
  StaticJsonDocument<200> doc;
  doc["deviceId"] = DEVICE_ID;
  doc["battery"] = 85; // Simulated battery state
  doc["firmware"] = "0.1.0";
  
  String requestBody;
  serializeJson(doc, requestBody);
  
  int httpResponseCode = http.POST(requestBody);
  if (httpResponseCode > 0) {
    String response = http.getString();
    Serial.printf("[Heartbeat] Code: %d\n", httpResponseCode);
    
    // Parse response configurations
    DynamicJsonDocument respDoc(1024);
    DeserializationError error = deserializeJson(respDoc, response);
    if (!error) {
      // Sync settings
      if (respDoc.containsKey("settings")) {
        JsonObject settings = respDoc["settings"];
        
        bool settingsChanged = false;
        
        // Only accept WiFi updates if they don't match the one that just failed to connect
        if (settings.containsKey("wifiSsid")) {
          String newSsid = settings["wifiSsid"].as<String>();
          if (newSsid != wifiSsid && newSsid != lastFailedSsid) {
            wifiSsid = newSsid;
            settingsChanged = true;
          }
        }
        if (settings.containsKey("wifiPassword") && settingsChanged) {
          wifiPassword = settings["wifiPassword"].as<String>();
        }
        
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
          Serial.println("[Sync] Configuration updated from dashboard settings!");
          savePreferences();
          
          // Re-evaluate WiFi connection if SSID changed
          if (settings.containsKey("wifiSsid") && settings["wifiSsid"].as<String>() != lastFailedSsid) {
            Serial.println("[Sync] WiFi credentials updated. Restarting device to reconnect...");
            delay(1000);
            ESP.restart();
          }
        }
      }
      
      // Sync incoming command (e.g. alert notifications)
      if (respDoc.containsKey("command")) {
        String command = respDoc["command"].as<String>();
        Serial.printf("[Command] Received remote instruction: %s\n", command.c_str());
        
        if (command == "notification") {
          String title = respDoc["title"].as<String>();
          String message = respDoc["message"].as<String>();
          Serial.printf(">>> ALERT: %s - %s <<<\n", title.c_str(), message.c_str());
          
          // Set OLED overlay timer
          notificationUntil = millis() + 5000;
          updateDisplay("ALERT PUSHED", title, message);
          
          // Flash status LED rapidly to flag visual notification
          int maxVal = map(brightness, 0, 100, 0, 40);
          for (int i = 0; i < 8; i++) {
            rgbLed.setPixelColor(0, rgbLed.Color(maxVal, maxVal, 0)); rgbLed.show(); delay(100);
            rgbLed.setPixelColor(0, rgbLed.Color(0, 0, 0)); rgbLed.show(); delay(100);
          }
        }
      }
    }
  } else {
    Serial.printf("[Heartbeat] Error connecting to server: %d\n", httpResponseCode);
    if (agentHost != DEFAULT_AGENT_HOST) {
      Serial.printf("[Heartbeat] Heartbeat failed. Falling back to default agent host: %s\n", DEFAULT_AGENT_HOST);
      agentHost = DEFAULT_AGENT_HOST;
      agentPort = DEFAULT_AGENT_PORT;
      savePreferences();
    }
  }
  http.end();
}

// Record voice audio from I2S and send to /api/device/voice
void recordAndUploadVoice() {
  Serial.println("[Record] Triggered voice record. Initializing buffer...");
  
  // Calculate WAV size for 16-bit Mono (16000Hz)
  size_t pcmDataSize = recordingDuration * 16000 * sizeof(int16_t);
  wavBufferSize = pcmDataSize + 44; // 44 bytes header + PCM data
  
  wavBuffer = (char*) malloc(wavBufferSize);
  if (wavBuffer == nullptr) {
    Serial.println("[Record] Failed to allocate memory for recording buffer.");
    updateDisplay("OOM ERROR", "Could not allocate", "recording buffer");
    delay(2000);
    return;
  }

  // Write base WAV header
  writeWavHeader(wavBuffer, pcmDataSize);
  
  // Setup recording indicators
  isRecording = true;
  Serial.printf("[Record] Capturing I2S audio for %d seconds...\n", recordingDuration);
  
  size_t bytesRecorded = 0;
  int32_t i2sSamples[128]; // Input buffer for I2S read
  char* dataOffset = wavBuffer + 44;
  
  unsigned long startRecTime = millis();
  
  while (bytesRecorded < pcmDataSize && (millis() - startRecTime < (recordingDuration * 1000 + 500))) {
    // Pulse indicator LED in red during recording (respecting brightness settings)
    int maxVal = map(brightness, 0, 100, 0, 40);
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
    
    // Draw real-time recording state on OLED
    float progress = (float)bytesRecorded / pcmDataSize;
    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
    display.setTextSize(1);
    display.setCursor(0, 0);
    display.println("RECORDING VOICE...");
    display.drawLine(0, 9, 127, 9, SSD1306_WHITE);
    
    display.setCursor(0, 16);
    display.printf("Capture: %.1fs / %ds", (float)(millis() - startRecTime)/1000.0, recordingDuration);
    
    display.drawRect(0, 32, 128, 10, SSD1306_WHITE);
    display.fillRect(2, 34, progress * 124, 6, SSD1306_WHITE);
    
    display.setCursor(0, 52);
    display.println("Release btn when done");
    display.display();
  }
  
  isRecording = false;
  
  Serial.printf("[Record] Finished capture. Recorded: %d bytes. Uploading payload...\n", bytesRecorded);
  updateDisplay("UPLOADING...", "Transmitting wave file", "to Agent Server...");
  
  // Upload buffer to API
  if (WiFi.status() == WL_CONNECTED) {
    WiFiClient client;
    HTTPClient http;
    String url = "http://" + agentHost + ":" + String(agentPort) + "/api/device/voice";
    
    http.begin(client, url);
    http.addHeader("X-Device-ID", DEVICE_ID);
    http.addHeader("Authorization", "Bearer " + String(DEVICE_TOKEN));
    http.addHeader("Content-Type", "audio/wav");
    
    int httpResponseCode = http.POST((uint8_t*)wavBuffer, wavBufferSize);
    if (httpResponseCode > 0) {
      String response = http.getString();
      Serial.printf("[HTTP] Upload Response: %d\n", httpResponseCode);
      
      // Output response text
      DynamicJsonDocument responseDoc(1024);
      DeserializationError error = deserializeJson(responseDoc, response);
      if (!error && responseDoc.containsKey("transcript")) {
        String transcript = responseDoc["transcript"].as<String>();
        String agentResp = responseDoc.containsKey("response") ? responseDoc["response"].as<String>() : "Command Executed";
        
        Serial.printf("[Voice] Transcript: \"%s\"\n", transcript.c_str());
        Serial.printf("[Agent] Response: \"%s\"\n", agentResp.c_str());
        
        // Show response on OLED
        notificationUntil = millis() + 6000;
        updateDisplay("AGENT RESPONSE", "T: " + transcript, "R: " + agentResp);
      } else {
        Serial.printf("[HTTP] Raw response: %s\n", response.c_str());
        updateDisplay("UPLOAD COMPLETE", "Server updated", "successfully.");
        delay(1500);
      }
    } else {
      Serial.printf("[HTTP] Error sending WAV data: %d\n", httpResponseCode);
      updateDisplay("UPLOAD ERROR", "Code: " + String(httpResponseCode), "Retry again");
      delay(2000);
    }
    http.end();
  } else {
    Serial.println("[HTTP] Cannot upload. WiFi not connected.");
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
  
  // Map brightness (0 to 100) to NeoPixel scale (0 to 40) to keep it pleasant and not blinding
  int maxVal = map(brightness, 0, 100, 0, 40);
  if (maxVal < 0) maxVal = 0;
  if (maxVal > 40) maxVal = 40;

  if (ledBehavior == "rainbow") {
    // Breathy rainbow/purple transition
    float angle = millis() / 1000.0;
    int r = (int)(maxVal * (0.5 + 0.5 * sin(angle)));
    int g = (int)(maxVal * (0.5 + 0.5 * sin(angle + 2.0 * PI / 3.0)));
    int b = (int)(maxVal * (0.5 + 0.5 * sin(angle + 4.0 * PI / 3.0)));
    rgbLed.setPixelColor(0, rgbLed.Color(r, g, b));
  } 
  else if (ledBehavior == "pulse_blue") {
    // Pulse Blue
    int pulseVal = (int)(maxVal * (0.5 + 0.5 * sin(millis() / 400.0)));
    rgbLed.setPixelColor(0, rgbLed.Color(0, 0, pulseVal));
  } 
  else if (ledBehavior == "pulse_yellow") {
    // Pulse Yellow
    int pulseVal = (int)(maxVal * (0.5 + 0.5 * sin(millis() / 300.0)));
    rgbLed.setPixelColor(0, rgbLed.Color(pulseVal, (int)(pulseVal * 0.8), 0));
  } 
  else if (ledBehavior == "solid_green") {
    rgbLed.setPixelColor(0, rgbLed.Color(0, maxVal, 0));
  } 
  else { // "off" or default
    rgbLed.setPixelColor(0, rgbLed.Color(0, 0, 0));
  }
  rgbLed.show();
}

void setup() {
  Serial.begin(115200);
  delay(2000);
  Serial.println("--- Starting Second Brain ESP32-C6 Node ---");
  
  pinMode(BUTTON_UP, INPUT_PULLUP);
  pinMode(BUTTON_ACTION, INPUT_PULLUP);
  pinMode(BUTTON_DOWN, INPUT_PULLUP);
  
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
  
  Serial.println("[Setup] Device is fully running and listening.");
}

void loop() {
  // Check for WiFi reconnection if disconnected
  if (WiFi.status() != WL_CONNECTED && millis() % 15000 == 0) {
    Serial.println("[WiFi] Lost connection. Attempting reconnection...");
    connectToWiFi();
  }
  
  // Sync Heartbeats periodically
  if (millis() - lastHeartbeatTime >= heartbeatInterval) {
    sendHeartbeat();
    lastHeartbeatTime = millis();
  }
  
  // Check Voice Capture Button trigger (BUTTON_ACTION pulled to ground)
  bool actionBtn = digitalRead(BUTTON_ACTION);
  if (lastActionBtn == HIGH && actionBtn == LOW) {
    // Debounce
    delay(50);
    if (digitalRead(BUTTON_ACTION) == LOW) {
      recordAndUploadVoice();
      // Wait for release
      while(digitalRead(BUTTON_ACTION) == LOW) {
        delay(10);
      }
    }
  }
  lastActionBtn = actionBtn;

  // Refresh display state if not showing active overlay
  if (millis() > notificationUntil && !isRecording) {
    String wifiStatus = (WiFi.status() == WL_CONNECTED) ? "ONLINE" : "OFFLINE";
    updateDisplay(wifiStatus, "IP: " + WiFi.localIP().toString(), "Agent: " + agentHost + ":" + String(agentPort), "Press ACTION to record");
  }

  // Update hardware visual indicator
  updateLED();
  
  delay(10);
}
