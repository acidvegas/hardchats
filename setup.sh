#!/bin/bash
# HARDCHATS WebRTC Voice/Video Server - Developed by acidvegas (https://github.com/acidvegas/hardchats)
# hardchats/setup.sh


# Load environment variables
[ -f .env ] && source .env || { echo "Error: .env file not found"; exit 1; }

# Set xtrace, exit on error, & verbose mode (after loading environment variables)
set -xev

# Build the hardchats image
docker build -t hardchats .

# Remove existing containers if they exist
docker rm -f coturn 2>/dev/null || true
docker rm -f hardchats 2>/dev/null || true

# Get public IP
PUBLIC_IP=$(curl -4 -s https://maxmind.supernets.org/ | jq -rc .ip)

# Run coturn container
docker run -d \
  --name coturn \
  --restart unless-stopped \
  --network host \
  instrumentisto/coturn \
  -n \
  --listening-port=${TURN_PORT} \
  --listening-ip=${PUBLIC_IP} \
  --relay-ip=${PUBLIC_IP} \
  --external-ip=${PUBLIC_IP} \
  --min-port=60000 \
  --max-port=60499 \
  --fingerprint \
  --lt-cred-mech \
  --user=${TURN_USERNAME}:${TURN_PASSWORD} \
  --realm=${TURN_REALM} \
  --no-tls \
  --no-dtls \
  --no-cli \
  --log-file=stdout

# Run hardchats container
docker run -d --name hardchats --restart unless-stopped -p 127.0.0.1:58080:58080 \
  -e IRC_SERVER=${IRC_SERVER} \
  -e IRC_PORT=${IRC_PORT} \
  -e IRC_CHANNEL=${IRC_CHANNEL} \
  -e TURN_SERVER=${TURN_SERVER} \
  -e TURN_PORT=${TURN_PORT} \
  -e TURN_USERNAME=${TURN_USERNAME} \
  -e TURN_PASSWORD=${TURN_PASSWORD} \
  -e TURN_REALM=${TURN_REALM} \
  hardchats