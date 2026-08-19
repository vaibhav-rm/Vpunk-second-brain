#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

echo "============================================="
echo "   Second Brain ESP32-C6 Firmware Uploader   "
echo "============================================="

# 1. Detect Host Local IP Address
echo -e "\n[1/5] Detecting your computer's local network IP address..."
LOCAL_IPS=$(hostname -I 2>/dev/null || ip route get 1 2>/dev/null | awk '{print $7}' || echo "Could not detect automatically")

echo "Your active local IP address(es) on this network:"
RECOMMENDED_IP=""
for ip in $LOCAL_IPS; do
  if [[ $ip =~ ^192\.168\. || $ip =~ ^10\. || $ip =~ ^172\. ]]; then
    echo "  ->  $ip  (Configured in config.h)"
    RECOMMENDED_IP=$ip
  else
    echo "      $ip"
  fi
done
echo -e "Ensure this matches 'DEFAULT_AGENT_HOST' in 'config.h'."

# 2. Detect Connected Serial Ports
echo -e "\n[2/5] Scanning for connected USB serial ports..."
PORTS=$(ls /dev/ttyUSB* /dev/ttyACM* 2>/dev/null || true)

PORT_TO_USE=""
if [ -z "$PORTS" ]; then
  echo "[-] ERROR: No ESP32-C6 serial port detected. Please connect your device via USB."
  echo "    Checking /dev/ttyACM0 by default..."
  PORT_TO_USE="/dev/ttyACM0"
else
  echo "[+] Detected serial ports:"
  for port in $PORTS; do
    echo "  - $port"
  done
  PORT_TO_USE=$(echo "$PORTS" | head -n 1)
  echo "[+] Selected port: $PORT_TO_USE"
fi

# 3. Bootstrap arduino-cli locally if missing
echo -e "\n[3/5] Checking Arduino CLI toolchain..."
ARDUINO_CLI=""

if command -v arduino-cli &> /dev/null; then
  echo "[+] Found global 'arduino-cli' installation."
  ARDUINO_CLI="arduino-cli"
elif [ -f "./bin/arduino-cli" ]; then
  echo "[+] Found local 'arduino-cli' in ./bin."
  ARDUINO_CLI="./bin/arduino-cli"
else
  echo "[!] 'arduino-cli' not found. Bootstrapping local compiler toolchain..."
  mkdir -p bin
  curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | BINDIR=$(pwd)/bin sh
  ARDUINO_CLI="./bin/arduino-cli"
  echo "[+] Successfully installed arduino-cli locally."
fi

# Print version
$ARDUINO_CLI version

# 4. Install Board Index & Libraries
echo -e "\n[4/5] Syncing ESP32 board index and dependency libraries..."

# Initialize arduino-cli config if not present
if [ ! -f ~/.arduino15/arduino-cli.yaml ]; then
  $ARDUINO_CLI config init || true
fi

# Add Espressif ESP32 package URL to config
echo "[+] Adding ESP32 board manager URL..."
$ARDUINO_CLI config set board_manager.additional_urls https://espressif.github.io/arduino-esp32/package_esp32_index.json || true

echo "[+] Updating core index..."
$ARDUINO_CLI core update-index

# Check if ESP32 core is installed
if ! $ARDUINO_CLI core list | grep -q "esp32:esp32"; then
  echo "[+] Installing ESP32 toolchain (this may take a minute)..."
  $ARDUINO_CLI core install esp32:esp32
else
  echo "[+] ESP32 board support is already installed."
fi

# Check if ArduinoJson is installed
if ! $ARDUINO_CLI lib list | grep -q "ArduinoJson"; then
  echo "[+] Installing ArduinoJson library..."
  $ARDUINO_CLI lib install "ArduinoJson"
else
  echo "[+] ArduinoJson library is already installed."
fi

# Check if Adafruit SSD1306 is installed
if ! $ARDUINO_CLI lib list | grep -q "Adafruit SSD1306"; then
  echo "[+] Installing Adafruit SSD1306 library..."
  $ARDUINO_CLI lib install "Adafruit SSD1306"
else
  echo "[+] Adafruit SSD1306 library is already installed."
fi

# Check if Adafruit GFX Library is installed
if ! $ARDUINO_CLI lib list | grep -q "Adafruit GFX Library"; then
  echo "[+] Installing Adafruit GFX Library..."
  $ARDUINO_CLI lib install "Adafruit GFX Library"
else
  echo "[+] Adafruit GFX Library is already installed."
fi

# Check if Adafruit NeoPixel is installed
if ! $ARDUINO_CLI lib list | grep -q "Adafruit NeoPixel"; then
  echo "[+] Installing Adafruit NeoPixel library..."
  $ARDUINO_CLI lib install "Adafruit NeoPixel"
else
  echo "[+] Adafruit NeoPixel library is already installed."
fi

# 5. Compile and Upload
echo -e "\n[5/5] Compiling and uploading firmware.ino to ESP32-C6..."

echo "[+] Compiling sketch..."
$ARDUINO_CLI compile --fqbn esp32:esp32:esp32c6:CDCOnBoot=cdc .

echo "[+] Uploading code on $PORT_TO_USE..."
$ARDUINO_CLI upload -p "$PORT_TO_USE" --fqbn esp32:esp32:esp32c6:CDCOnBoot=cdc .

echo -e "\n============================================="
echo "   🎉 Success! Firmware uploaded to ESP32-C6! "
echo "============================================="
