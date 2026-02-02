#!/bin/bash

# Script to start gNMI service with proper logging

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

echo "==================================="
echo "Starting gNMI Service"
echo "==================================="
echo ""
echo "Working directory: $(pwd)"
echo "Node version: $(node --version)"
echo ""

# Check if proto files exist
if [ ! -f "proto/gnmi/gnmi.proto" ]; then
    echo "ERROR: proto/gnmi/gnmi.proto not found!"
    exit 1
fi

if [ ! -f "proto/gnmi_ext/gnmi_ext.proto" ]; then
    echo "ERROR: proto/gnmi_ext/gnmi_ext.proto not found!"
    exit 1
fi

echo "✓ Proto files found"
echo ""

# Start the service
node gnmi-service.js
