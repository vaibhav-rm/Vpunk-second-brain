#!/bin/bash

# ==============================================================================
# Second Brain ESP32-C6 Firmware Build & Flash Tool
# ==============================================================================

set -e

# Path setup
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIRMWARE_DIR="$SCRIPT_DIR"

# Defaults
BUILD_ONLY=false
CLEAN_BUILD=false
CUSTOM_PORT=""
CUSTOM_IP=""
BAUD_RATE="460800"

# ANSI Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

show_help() {
  echo -e "${BOLD}Second Brain ESP32-C6 Build & Flash Script${NC}"
  echo ""
  echo "Usage: $0 [OPTIONS]"
  echo ""
  echo "Options:"
  echo "  -b, --build-only     Compile firmware without uploading to a device"
  echo "  -p, --port PORT      Specify serial port (e.g., /dev/ttyACM0, /dev/ttyUSB0)"
  echo "  -i, --ip IP_ADDR     Update DEFAULT_AGENT_HOST in config.h to target IP"
  echo "  -s, --speed BAUD     Specify upload baud rate (default: 460800, fallback: 115200)"
  echo "  -c, --clean          Clean build cache before compilation"
  echo "  -h, --help           Display this help message"
  echo ""
}

# Parse command-line options
while [[ $# -gt 0 ]]; do
  case $1 in
    -b|--build-only)
      BUILD_ONLY=true
      shift
      ;;
    -p|--port)
      CUSTOM_PORT="$2"
      shift 2
      ;;
    -i|--ip)
      CUSTOM_IP="$2"
      shift 2
      ;;
    -s|--speed)
      BAUD_RATE="$2"
      shift 2
      ;;
    -c|--clean)
      CLEAN_BUILD=true
      shift
      ;;
    -h|--help)
      show_help
      exit 0
      ;;
    *)
      echo -e "${RED}[-] Unknown option: $1${NC}"
      show_help
      exit 1
      ;;
  esac
done

echo -e "${CYAN}=============================================${NC}"
echo -e "${BOLD}   Second Brain ESP32-C6 Firmware Tool       ${NC}"
echo -e "${CYAN}=============================================${NC}"

# 1. Host IP Detection & Optional Config Update
echo -e "\n${BLUE}[1/5] Checking local network IP configuration...${NC}"

if [ -n "$CUSTOM_IP" ]; then
  echo -e "${GREEN}[+] Setting DEFAULT_AGENT_HOST to '$CUSTOM_IP' in config.h...${NC}"
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s/#define DEFAULT_AGENT_HOST \".*\"/#define DEFAULT_AGENT_HOST \"$CUSTOM_IP\"/" "$FIRMWARE_DIR/config.h"
  else
    sed -i "s/#define DEFAULT_AGENT_HOST \".*\"/#define DEFAULT_AGENT_HOST \"$CUSTOM_IP\"/" "$FIRMWARE_DIR/config.h"
  fi
fi

LOCAL_IPS=$(hostname -I 2>/dev/null || ip route get 1 2>/dev/null | awk '{print $7}' || echo "")
echo "Active local network IP address(es):"
for ip in $LOCAL_IPS; do
  if [[ $ip =~ ^192\.168\. || $ip =~ ^10\. || $ip =~ ^172\. ]]; then
    echo -e "  -> ${GREEN}$ip${NC} (Recommended for DEFAULT_AGENT_HOST)"
  else
    echo "     $ip"
  fi
done

# Read current DEFAULT_AGENT_HOST from config.h
CURRENT_CFG_IP=$(grep -E '#define DEFAULT_AGENT_HOST' "$FIRMWARE_DIR/config.h" | awk -F'"' '{print $2}')
echo -e "Current 'DEFAULT_AGENT_HOST' in config.h: ${YELLOW}${CURRENT_CFG_IP:-Not set}${NC}"

# 2. Port Detection
PORT_TO_USE=""
find_port() {
  if [ -n "$CUSTOM_PORT" ]; then
    echo "$CUSTOM_PORT"
  else
    local found=$(ls /dev/ttyUSB* /dev/ttyACM* /dev/cu.usb* /dev/cu.SLAB* /dev/cu.wchusb* 2>/dev/null | head -n 1 || echo "")
    if [ -z "$found" ]; then
      echo "/dev/ttyACM0"
    else
      echo "$found"
    fi
  fi
}

if [ "$BUILD_ONLY" = false ]; then
  echo -e "\n${BLUE}[2/5] Scanning for connected USB serial ports...${NC}"
  PORT_TO_USE=$(find_port)
  echo -e "${GREEN}[+] Selected serial port: $PORT_TO_USE${NC}"
else
  echo -e "\n${BLUE}[2/5] Build-only mode requested; skipping serial port scan.${NC}"
fi

# 3. Environment & Toolchain Setup
echo -e "\n${BLUE}[3/5] Setting up Arduino CLI environment...${NC}"

if mkdir -p "$HOME/.arduino15" 2>/dev/null && [ -w "$HOME/.arduino15" ]; then
  export ARDUINO_DIRECTORIES_DATA="${ARDUINO_DIRECTORIES_DATA:-$HOME/.arduino15}"
  export ARDUINO_DIRECTORIES_USER="${ARDUINO_DIRECTORIES_USER:-$HOME/Arduino}"
else
  export ARDUINO_DIRECTORIES_DATA="${ARDUINO_DIRECTORIES_DATA:-$FIRMWARE_DIR/.arduino15}"
  export ARDUINO_DIRECTORIES_USER="${ARDUINO_DIRECTORIES_USER:-$FIRMWARE_DIR/Arduino}"
fi

mkdir -p "$ARDUINO_DIRECTORIES_DATA" "$ARDUINO_DIRECTORIES_USER"

ARDUINO_CLI=""
if command -v arduino-cli &> /dev/null; then
  echo "[+] Found global 'arduino-cli' installation."
  ARDUINO_CLI="arduino-cli"
elif [ -f "$FIRMWARE_DIR/bin/arduino-cli" ]; then
  echo "[+] Found local 'arduino-cli' in $FIRMWARE_DIR/bin."
  ARDUINO_CLI="$FIRMWARE_DIR/bin/arduino-cli"
else
  echo "[!] 'arduino-cli' not found. Bootstrapping local toolchain..."
  mkdir -p "$FIRMWARE_DIR/bin"
  curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | BINDIR="$FIRMWARE_DIR/bin" sh
  ARDUINO_CLI="$FIRMWARE_DIR/bin/arduino-cli"
fi

$ARDUINO_CLI version

# 4. Core & Library Sync
echo -e "\n${BLUE}[4/5] Syncing ESP32 board manager and required libraries...${NC}"

if [ ! -f "$ARDUINO_DIRECTORIES_DATA/arduino-cli.yaml" ]; then
  $ARDUINO_CLI config init || true
fi

$ARDUINO_CLI config set board_manager.additional_urls https://espressif.github.io/arduino-esp32/package_esp32_index.json || true
$ARDUINO_CLI core update-index

if ! $ARDUINO_CLI core list | grep -q "esp32:esp32"; then
  echo "[+] Installing ESP32 core..."
  $ARDUINO_CLI core install esp32:esp32
else
  echo "[+] ESP32 core is already installed."
fi

LIBS=("ArduinoJson" "Adafruit SSD1306" "Adafruit GFX Library" "Adafruit NeoPixel")
for lib in "${LIBS[@]}"; do
  if ! $ARDUINO_CLI lib list | grep -q "$lib"; then
    echo "[+] Installing library '$lib'..."
    $ARDUINO_CLI lib install "$lib"
  else
    echo "[+] Library '$lib' is installed."
  fi
done

# 5. Compile & Flash
FQBN="esp32:esp32:esp32c6:CDCOnBoot=cdc"

echo -e "\n${BLUE}[5/5] Compiling firmware.ino for ESP32-C6...${NC}"

COMPILE_ARGS=("--fqbn" "$FQBN" "$FIRMWARE_DIR")
if [ "$CLEAN_BUILD" = true ]; then
  COMPILE_ARGS+=("--clean")
fi

$ARDUINO_CLI compile "${COMPILE_ARGS[@]}"
echo -e "${GREEN}[+] Firmware compiled successfully!${NC}"

if [ "$BUILD_ONLY" = true ]; then
  echo -e "\n${GREEN}=============================================${NC}"
  echo -e "${GREEN}   🎉 Build complete! (Upload skipped)       ${NC}"
  echo -e "${GREEN}=============================================${NC}"
  exit 0
fi

echo -e "\n${CYAN}[+] Uploading binary to $PORT_TO_USE (speed: $BAUD_RATE)...${NC}"

set +e
$ARDUINO_CLI upload -p "$PORT_TO_USE" --fqbn "$FQBN" --upload-property "upload.speed=$BAUD_RATE" "$FIRMWARE_DIR"
UPLOAD_STATUS=$?
set -e

if [ $UPLOAD_STATUS -ne 0 ]; then
  echo -e "\n${YELLOW}[!] First upload attempt failed (Exit code: $UPLOAD_STATUS). Retrying...${NC}"
  sleep 1.5
  RETRY_PORT=$(find_port)
  echo -e "${YELLOW}[!] Attempting upload on $RETRY_PORT at 115200 baud...${NC}"
  set +e
  $ARDUINO_CLI upload -p "$RETRY_PORT" --fqbn "$FQBN" --upload-property "upload.speed=115200" "$FIRMWARE_DIR"
  UPLOAD_STATUS=$?
  set -e
fi

if [ $UPLOAD_STATUS -eq 0 ]; then
  echo -e "\n${GREEN}=============================================${NC}"
  echo -e "${GREEN}   🎉 Success! Firmware flashed to ESP32-C6!  ${NC}"
  echo -e "${GREEN}=============================================${NC}"
else
  echo -e "\n${RED}=============================================${NC}"
  echo -e "${RED}   [-] Upload Failed (Exit Code $UPLOAD_STATUS)       ${NC}"
  echo -e "${RED}=============================================${NC}"
  echo -e "${YELLOW}How to fix code -1 / upload errors:${NC}"
  echo -e "1. ${BOLD}Manual Download Mode (100% Fix)${NC}:"
  echo -e "   - Press & HOLD the ${BOLD}BOOT${NC} button on your ESP32-C6."
  echo -e "   - Tap (press & release) the ${BOLD}RESET (RST)${NC} button once."
  echo -e "   - Release the ${BOLD}BOOT${NC} button."
  echo -e "   - Run ${BOLD}./build_and_flash.sh${NC} again."
  echo -e "2. ${BOLD}Close Serial Monitors${NC}: Ensure no active terminal (screen, picocom, serial monitor) is holding $PORT_TO_USE open."
  echo -e "3. ${BOLD}Permissions${NC}: Ensure your user is in dialout group: ${BOLD}sudo usermod -a -G dialout \$USER${NC}"
  exit $UPLOAD_STATUS
fi
