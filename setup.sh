#!/bin/bash
# HARDCHATS WebRTC Voice/Video Server - Developed by acidvegas (https://github.com/acidvegas/hardchats)
# hardchats/setup.sh


# Load environment variables
[ -f .env ] && source .env || { echo "Error: .env file not found"; exit 1; }

# Set xtrace, exit on error, & verbose mode (after loading environment variables)
set -xev

# Remove existing docker container if it exists
docker rm -f hardchats 2>/dev/null || true

# Run the Docker container
docker run -d --name hardchats --restart unless-stopped -p 58080:58080 -p 3478:3478 -p 60000-60499:60000-60499/udp hardchats --env-file .env