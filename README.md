# HARDCHATS

![](./.screens/preview.png)


## Setup

#### NGINX setup

###### Create a certificate
```bash
sudo certbot certonly --standalone -d hardchats.com
```

###### Create an NGINX config
```bash
sudo nano /etc/nginx/sites-available/hardchats.com.conf
```

```
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
```

```bash
sudo ln -sf /etc/nginx/sites-available/hardchats.com.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

#### UnrealIRCd setup

###### Create a listen block for websocket connections over TLS
```
listen {
    ip *;
    port 7000;
    options {
        tls;
        websocket { type text; }
    };
    tls-options {
        certificate "tls/irc.crt";
        key "tls/irc.key";
		options { no-client-certificate; }
    };
};
```

###### Load required modules

```
loadmodule "webserver";
loadmodule "websocket";
loadmodule "websocket_common";
```

## Roadmap
###### Features
- [ ] End-to-end encryption
- [ ] Low bandwidth mode

###### Bugs
- [ ] ⚠️ IRC connection Chrome-based browsers not working *(Tested via Vandium browser on GrapheneOS and Chromium on Linux/Windows)*
- [ ] When you try to click something in the users menu, if someone speaks and hilights their name, it hijacks the click in the users menu *(reported by bombuzal)*
- [ ] Mobile users when they have someone maximized should see a horizontally scrolling list on the bottom of other cameras still, like how desktop mode does it.
- [ ] Mobile users need to be able to scroll all the video shares in tile mode, they cant all fit on the screen when many people are on camera.
- [ ] Mobile users personal camera is frozen in a group
- [ ] Javascript console in Firefox reports `WebRTC: ICE failed, see about:webrtc for more details`
- [ ] Strange bug observed on Vandium on GrapheneOS mobile, I was unable to hear one specific person who joined after me. Rejoining fixed the issue, but my desktop thatw as connected the whole time didn't suffer from this issue.

###### Touchups
- [ ] Hide the screen share button on mobile as it is pointless.
- [ ] IRC channel +H history loading on connection
- [ ] Color picker to replace the green accent with your own color choice *(Remembered via cookies)*
- [ ] Cleaner IRC chat *(hide server notices and redundant content)*
- [ ] Better captcha system to prevent bot abuse

###### Fancy Pipe Dreams
- [ ] Milkdrop animations from the audio
- [ ] Multiple room support + lobby system

## Contribute
Come join us on `irc.supernets.org` in `#hardchats` for testing, feedback, & collaboration!

---

###### Mirrors: [acid.vegas](https://git.acid.vegas/hardchats) • [SuperNETs](https://git.supernets.org/acidvegas/hardchats) • [GitHub](https://github.com/acidvegas/hardchats) • [GitLab](https://gitlab.com/acidvegas/hardchats) • [Codeberg](https://codeberg.org/acidvegas/hardchats)
