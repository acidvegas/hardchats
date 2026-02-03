#!/bin/bash
# HARDCHATS WebRTC Voice/Video Server - Developed by acidvegas (https://github.com/acidvegas/hardchats)
# hardchats/setup.sh


# Load environment variables
[ -f .env ] && source .env || { echo "Error: .env file not found"; exit 1; }

# Set xtrace, exit on error, & verbose mode (after loading environment variables)
set -xev

# Remove existing docker container if it exists
docker rm -f hardchats 2>/dev/null || true

# Get public IP
PUBLIC_IP=$(curl -4 -s https://maxmind.supernets.org/ | jq -rc .ip)

# Create a turn password
TURN_PASSWORD=$(openssl rand -hex 16)

# Replace the password in the config.py file
sed -i "s/credential: '[^']*'/credential: '$TURN_PASSWORD'/" config.py


cat << EOF > turnserver.conf
echo "listening-port=3478" > /etc/turnserver.conf && \
    echo "tls-listening-port=5349" >> /etc/turnserver.conf && \
    echo "listening-ip=0.0.0.0" >> /etc/turnserver.conf && \
    echo "external-ip=$PUBLIC_IP" >> /etc/turnserver.conf && \
    echo "relay-ip=$PUBLIC_IP" >> /etc/turnserver.conf && \
    echo "min-port=49152" >> /etc/turnserver.conf && \
    echo "max-port=65535" >> /etc/turnserver.conf && \
    echo "verbose" >> /etc/turnserver.conf && \
    echo "fingerprint" >> /etc/turnserver.conf && \
    echo "lt-cred-mech" >> /etc/turnserver.conf && \
    echo "user=hardchats:$TURN_PASSWORD" >> /etc/turnserver.conf && \
    echo "realm=hardchats" >> /etc/turnserver.conf'

# Run the Docker container
docker run -d --name hardchats --restart unless-stopped --network host hardchats

# Create the turn server config file in the docker container without using a bunch of && staments, do it cleanly
docker exec -it hardchats sh -c 