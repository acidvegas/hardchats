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
  -p 3478:3478 \
  -p 5349:5349 \
  -p 60000-60499:60000-60499/udp \
  -v /etc/letsencrypt/live/${TURN_SERVER}:/etc/letsencrypt/live/${TURN_SERVER}:ro \
  instrumentisto/coturn \
  -n \
  --listening-port=3478 \
  --tls-listening-port=5349 \
  --listening-ip=0.0.0.0 \
  --external-ip=${PUBLIC_IP} \
  --min-port=60000 \
  --max-port=60499 \
  --fingerprint \
  --lt-cred-mech \
  --user=${TURN_USERNAME}:${TURN_PASSWORD} \
  --realm=${TURN_REALM} \
  --verbose \
  --cert=/etc/letsencrypt/live/${TURN_SERVER}/fullchain.pem --pkey=/etc/letsencrypt/live/${TURN_SERVER}/privkey.pem

# Run hardchats container
docker run -d --name hardchats --restart unless-stopped -p 127.0.0.1:58080:58080 hardchats