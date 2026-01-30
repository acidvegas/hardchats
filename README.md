# HARDCHATS

![](./.screens/preview.png)

## Features to add
- [ ] End-to-end encryption
- [ ] Screen sharing *(max of 2-3 users allowed)*
- [ ] Low bandwidth mode *(added but needs testing)*
- [ ] Add cookies to remember settings *(Name, Camera/Microphone device, etc)*
- [ ] Color picker to replace the green accent with your own color choice *(Remembered via cookies)*
- [ ] Drag to resize the width of the chat & user list.
- [ ] API for basic metrics and information about the chat.
- [ ] IRC bot for admin management

## Known bugs
- [ ] Browser noticiations for JOIN, QUIT, & CHAT is not working.
- [ ] Custom sounds for JOIN/QUIT/CHAT are not playing
- [ ] IRC connection Chrome-based browsers not working *(Tested via Vandium browser on GrapheneOS and Chromium on Linux/Windows)*
	- This might be because we have closed ports on some SuperNETs nodes I need to open still for websockets...
- [ ] Does not properly detect when a client quits so the cam gets frozen and the user remains in the user list still.
- [ ] Anyone can lockdown the chat pretty easily by opening 25 connections so no one can join.

## Touchups
- [ ] Cleaner IRC chat *(hide server notices and redundant content)*
- [ ] Better captcha system to prevent bot abuse
- [ ] Show total users online on the home page to see
- [ ] No script notice on home page if Javascript is disabled

## Fancy Pipe Dreams
- [ ] Milkdrop animations from the audio
- [ ] Multiple room support + lobby system

## Contribute
Come join us on `irc.supernets.org` in `#hardchats` for testing, feedback, & collaboration!