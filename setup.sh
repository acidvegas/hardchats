#!/bin/bash
# HARDCHATS WebRTC Voice/Video Server - Developed by acidvegas (https://github.com/acidvegas/hardchats)
# hardchats/setup.sh


# Load environment variables
[ -f .env ] && source .env || { echo "Error: .env file not found"; exit 1; }

# Exit on error & verbose mode (no xtrace: it would print the LiveKit secret and Zulip key)
set -ev

# Container name + local port (override to run a second copy, e.g. HC_NAME=hardchats-beta HC_PORT=58081)
HC_NAME=${HC_NAME:-hardchats}
HC_PORT=${HC_PORT:-58080}

# Build the hardchats image
docker build -t ${HC_NAME} .

# Remove existing containers if they exist
docker rm -f ${HC_NAME}-livekit 2>/dev/null || true
docker rm -f ${HC_NAME} 2>/dev/null || true

# Get public IPs
PUBLIC_IP=$(curl -4 -s https://maxmind.supernets.org/ | jq -rc .ip)
PUBLIC_IP6=$(curl -6 -s https://maxmind.supernets.org/ | jq -rc .ip)

# Run the LiveKit SFU (media on UDP 7882 / TCP 7881, TURN/TLS on 5349, API on 7880 locally)
docker run -d \
  --name ${HC_NAME}-livekit \
  --restart unless-stopped \
  --network host \
  -v /etc/letsencrypt:/etc/letsencrypt:ro \
  -e LIVEKIT_KEYS="${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}" \
  livekit/livekit-server:v1.13.11 \
  --config-body "$(sed "s/PUBLIC_IP6/${PUBLIC_IP6}/g; s/PUBLIC_IP/${PUBLIC_IP}/g" livekit.yaml)" \
  --node-ip ${PUBLIC_IP},${PUBLIC_IP6}

# Run hardchats container
docker run -d --name ${HC_NAME} --restart unless-stopped --user 10001:10001 -p 127.0.0.1:${HC_PORT}:58080 \
  -e IRC_SERVER=${IRC_SERVER} \
  -e IRC_PORT=${IRC_PORT} \
  -e IRC_CHANNEL=${IRC_CHANNEL} \
  -e IRCBOT_ENABLED=${IRCBOT_ENABLED:-1} \
  -e LIVEKIT_URL=${LIVEKIT_URL} \
  -e LIVEKIT_API_URL=http://172.17.0.1:7880 \
  -e LIVEKIT_API_KEY=${LIVEKIT_API_KEY} \
  -e LIVEKIT_API_SECRET=${LIVEKIT_API_SECRET} \
  -e ZULIP_BOT_EMAIL=${ZULIP_BOT_EMAIL} \
  -e ZULIP_BOT_KEY=${ZULIP_BOT_KEY} \
  ${HC_NAME}
