# HARDCHATS

![](./.screens/preview.png)

## Features to add
- [ ] End-to-end encryption
- [ ] Screen sharing *(max of 2-3 users allowed)*
- [ ] Custom sounds for JOIN/QUIT/CHAT *(Togglable via speaker icon)*
- [ ] Device selection for Camera/Microphone

## Known bugs
- [ ] Speaker mute button not working *(atleast on mobile)*
- [ ] IRC connection on mobile and sometimes desktop not working *(Tested via Vandium browser on GrapheneOS)*
	- This might be because we have closed ports on some SuperNETs nodes I need to open still for websockets...
- [ ] Collapse chat button is hidden on mobile, leaving the chat stuck open
- [ ] Does not properly detect when a client quits so the cam gets frozen and the user remains in the user list still.
- [ ] Self camera view gets frozen often when someone else turns their camera on, but others see it live.
- [ ] Turning off cam or quitting causes the cam to freeze and the box not removing itself.
- [ ] Turning on camera makes audio stop working *(Reported by bombuzal, Firefox/Linux)*