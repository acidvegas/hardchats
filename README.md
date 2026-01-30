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
- [ ] Screen sharing *(max of 2-3 users allowed)*
- [ ] Low bandwidth mode *(added but needs testing)*
- [ ] Add cookies to remember settings *(Name, Camera/Microphone device, etc)*
- [ ] Color picker to replace the green accent with your own color choice *(Remembered via cookies)*
- [ ] Drag to resize the width of the chat & user list.
- [ ] API for basic metrics and information about the chat.
- [ ] IRC bot for admin management
- [ ] Mute icon indicator next to their name in the users list to signify they are muted
- [ ] Truncate cameras to squares to fix better, show full camera in maximized mode.
- [ ] IRC channel +H history loading on connection

###### Bugs
- [ ] ⚠️ Does not properly detect when a client quits so the cam gets frozen and the user remains in the user list still.
- [ ] ⚠️ IRC connection Chrome-based browsers not working *(Tested via Vandium browser on GrapheneOS and Chromium on Linux/Windows)*
- [ ] Mobile users when they have someone maximized should see a horizontally scrolling list on the bottom of other cameras still, like how desktop mode does it.
- [ ] Mobile users need to be able to scroll all the video shares in tile mode, they cant all fit on the screen when many people are on camera.
- [ ] Mobile users personal camera is frozen in a group
- [ ] Browser noticiations for JOIN, QUIT, & CHAT is not working.
- [ ] Custom sounds for JOIN/QUIT/CHAT are not playing
- [ ] Anyone can lockdown the chat pretty easily by opening 25 connections so no one can join.
- [ ] Strange bug observed on Vandium on GrapheneOS mobile, I was unable to hear one specific person who joined after me. Rejoining fixed the issue, but my desktop thatw as connected the whole time didn't suffer from this issue.
- [ ] Javascript console in Firefox reports `WebRTC: ICE failed, see about:webrtc for more details`
- [ ] When you try to click something in the users menu, if someone speaks and hilights their name, it hijacks the click in the users menu *(reported by bombuzal)*

###### Touchups
- [ ] Cleaner IRC chat *(hide server notices and redundant content)*
- [ ] Better captcha system to prevent bot abuse
- [ ] Show total users online on the home page to see
- [ ] No script notice on home page if Javascript is disabled
- [ ] Muting other people / turning fof their vdieo cuts the stream entirely to save bandwidth
- [ ] ABC order for users list
- [ ] Throttle camera on and off to prevent probe spam *(reported by incog)*

###### Fancy Pipe Dreams
- [ ] Milkdrop animations from the audio
- [ ] Multiple room support + lobby system
- [ ] Scripting engine for Python to make this extentible like WeeChat & irssi

## Contribute
Come join us on `irc.supernets.org` in `#hardchats` for testing, feedback, & collaboration!

---

###### Mirrors: [acid.vegas](https://git.acid.vegas/hardchats) • [SuperNETs](https://git.supernets.org/acidvegas/hardchats) • [GitHub](https://github.com/acidvegas/hardchats) • [GitLab](https://gitlab.com/acidvegas/hardchats) • [Codeberg](https://codeberg.org/acidvegas/hardchats)
