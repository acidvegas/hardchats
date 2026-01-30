# HARDCHATS

![](./.screens/preview.png)

## Features to add
- [ ] End-to-end encryption
- [ ] Screen sharing *(max of 2-3 users allowed)*
- [ ] Custom sounds for JOIN/QUIT/CHAT *(Togglable via speaker icon)*
- [ ] Browser noticiations for JOIN, QUIT, & CHAT *(able to turn off in settings menu, along with the sounds)*
- Low bandwidth mode

## Known bugs
- [ ] Footer bar is overlapping the chat input text box on mobile
- [ ] Speaker mute button not working, nor is the volume control from the users menu
- [ ] IRC connection on mobile and sometimes desktop not working *(Tested via Vandium browser on GrapheneOS)*
	- This might be because we have closed ports on some SuperNETs nodes I need to open still for websockets...
- [X] Collapse chat button is hidden on mobile, leaving the chat stuck open
- [ ] Does not properly detect when a client quits so the cam gets frozen and the user remains in the user list still.
- [X] Self camera view gets frozen often when someone else turns their camera on, but others see it live.
- [X] Turning off cam or quitting causes the cam to freeze and the box not removing itself.
- [X] Turning on camera makes audio stop working *(Reported by bombuzal, Firefox/Linux)*

## Contribute
Come join us on `irc.supernets.org` in `#hardchats` for testing, feedback, & collaboration!