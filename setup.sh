#!/bin/bash
# HARDCHATS WebRTC Voice/Video Server - Developed by acidvegas (https://github.com/acidvegas/hardchats)
# hardchats/setup.sh

# Set xtrace, exit on error, & verbose mode
set -xev

# Install dependencies
pip install -r requirements.txt

# Get public IP
PUBLIC_IP=$(curl -4 -s https://maxmind.supernets.org/ | jq -rc .ip)

# Install coturn
sudo apt update && sudo apt install -y coturn

# Enable coturn
sudo sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn

# Generate random password
TURN_PASSWORD=$(openssl rand -hex 16)

# Configure coturn
sudo tee /etc/turnserver.conf << EOF
listening-port=3478
tls-listening-port=5349
listening-ip=0.0.0.0
external-ip=$PUBLIC_IP
relay-ip=$PUBLIC_IP
min-port=49152
max-port=65535
verbose
fingerprint
lt-cred-mech
user=hardchats:$TURN_PASSWORD
realm=hardchats
no-cli
EOF

# Restart coturn
sudo systemctl restart coturn && sudo systemctl enable coturn

echo "Backup your TURN server password: $TURN_PASSWORD"
echo "Edit your config.py file with the new TURN server password."
echo "Start the server: python3 server.py"