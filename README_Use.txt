Files :
-track_timing.py = Main python code for raspberry
-index.html = Main page for the timing system
-script.js = Script associated to index.html
-style.css = CSS for both html pages
-admin.html = Admin page for timing system setup
-admin.js = Script associated to admin.html, password is hardcoded here (not very secure, can be seen in browser)
-favicon.png = Logo
-banner.png = Custom header bar logo (define your own)
-icons.woff2 = Font file for the various icons used (define your own)

How to use :
- Connect to TrackTiming open WiFi
- If the portal doesn't open automatically, type 192.168.4.1 in a web browser
- Optional : create a bookmark/link to 192.168.4.1 or to 192.168.4.1/?tp=XXXXXXX for a specific transponder shortcut
- Admin Page (password = admin): 
	- Register drivers from the list of unregistered transponders
	- Set min/max laptimes (default 5s/120s)
	- Rename learned RC4 transponders (see OpenStint doc)
	- Set Date/Time in the RTC module
	- Edit drivers / classes
	- Delete laps

Transponder compatibility :
- RCHourglass homemade
- OpenStint homemade
- MRT
- AMBRC DP
- RC4 Hybrid (optional learning for better detection)
- RC4 / RC4 Pro compatible after learning (use website admin to register real TX number)