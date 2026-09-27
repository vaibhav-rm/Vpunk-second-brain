#!/bin/bash

# Root helper script to build and flash Second Brain ESP32-C6 firmware
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/firmware/upload.sh" "$@"
