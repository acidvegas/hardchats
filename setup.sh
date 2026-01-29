#!/bin/bash
# HARDCHATS WebRTC Voice/Video Server - Developed by acidvegas (https://github.com/acidvegas/hardchats)
# hardchats/setup.sh

set -e

echo "=== HardChats Setup ==="

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "Please run as root: sudo ./setup.sh"
    exit 1
fi

# Get public IP
echo "[*] Detecting public IP..."
PUBLIC_IP=$(curl -4 -s icanhazip.com)
if [ -z "$PUBLIC_IP" ]; then
    echo "[-] Could not detect public IP"
    exit 1
fi
echo "[+] Public IP: $PUBLIC_IP"

# Install coturn
echo "[*] Installing coturn..."
apt update
apt install -y coturn

# Enable coturn
echo "[*] Enabling coturn service..."
sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn

# Generate random password
TURN_PASSWORD=$(openssl rand -hex 16)

# Configure coturn
echo "[*] Configuring coturn..."
cat > /etc/turnserver.conf << EOF
# HardChats TURN Server Configuration
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

# Configure firewall if ufw is active
if command -v ufw &> /dev/null && ufw status | grep -q "active"; then
    echo "[*] Configuring firewall..."
    ufw allow 3478/tcp
    ufw allow 3478/udp
    ufw allow 5349/tcp
    ufw allow 5349/udp
    ufw allow 49152:65535/udp
    ufw allow 58080/tcp
    echo "[+] Firewall configured"
fi

# Restart coturn
echo "[*] Starting coturn..."
systemctl restart coturn
systemctl enable coturn

# Check status
if systemctl is-active --quiet coturn; then
    echo "[+] coturn is running"
else
    echo "[-] coturn failed to start"
    journalctl -u coturn --no-pager -n 20
    exit 1
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "TURN Server: $PUBLIC_IP:3478"
echo "Username: hardchats"
echo "Password: $TURN_PASSWORD"
echo ""
echo "Update your client.js ICE_SERVERS with:"
echo ""
cat << EOF
const ICE_SERVERS = [
    { urls: 'stun:$PUBLIC_IP:3478' },
    {
        urls: 'turn:$PUBLIC_IP:3478',
        username: 'hardchats',
        credential: '$TURN_PASSWORD'
    },
    {
        urls: 'turn:$PUBLIC_IP:3478?transport=tcp',
        username: 'hardchats',
        credential: '$TURN_PASSWORD'
    }
];
EOF
echo ""
echo "Then start the server: python3 server.py"

