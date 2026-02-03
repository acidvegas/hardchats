# Set xtrace, exit on error, & verbose mode
set -xev

sudo certbot certonly --standalone -d hardchats.com

# Create an NGINX config using tee
sudo tee /etc/nginx/sites-available/hardchats.com.conf << EOF
server {
    listen 80;
    listen [::]:80;
    server_name dev.hardchats.com;

    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name dev.hardchats.com;

    ssl_certificate     /etc/letsencrypt/live/hardchats.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hardchats.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:58080;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF

# Link the config and reload NGINX
sudo ln -sf /etc/nginx/sites-available/hardchats.com.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx