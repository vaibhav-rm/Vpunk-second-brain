#ifndef CONFIG_H
#define CONFIG_H

// Default WiFi credentials (used if not overridden by dynamic settings in NVS)
#define DEFAULT_WIFI_SSID "Simba"
#define DEFAULT_WIFI_PASS "Simba.5g"

// Web Dashboard / Next.js Agent details
// NOTE: Change this to your computer's local IP address (e.g. 192.168.1.20)
#define DEFAULT_AGENT_HOST "192.168.29.8" 
#define DEFAULT_AGENT_PORT 3000

// Device Identity
#define DEVICE_ID "second-brain-001"
#define DEVICE_TOKEN "dev-token-xyz123"

// Hardware Pinout Configuration
#define STATUS_LED_PIN    8 // Onboard LED

// Buttons
#define BUTTON_UP      0
#define BUTTON_ACTION  1
#define BUTTON_DOWN    2

// OLED Display I2C Pins
#define OLED_SDA 6
#define OLED_SCL 7

// I2S Microphone Pinout (INMP441)
#define I2S_SCK_PIN 4
#define I2S_WS_PIN  5
#define I2S_SD_PIN  20

// Sampling specifications
#define SAMPLE_RATE 16000
#define BITS_PER_SAMPLE 16

#endif // CONFIG_H
