# TrackTiming
Enhance your RC track with a simple permanent lap counting system, using only a Raspberry Pi and OpenStint decoder.

This is thought as a simple, inexpensive system to track open training sessions in small RC clubs. No internet, no laptop, no app : anyone with a WiFi capable device can connect and see their laptimes, neatly organized as training sessions.
Complete system cost is around 200€.

How it works ?
1. Install a timing loop following OpenStint recommendations : https://github.com/zsellera/openstint/blob/master/docs/setup-simple-rtlsdr.md
2. Connect the RTLSDR v4 to a Raspberry Pi 3B (or newer)
3. Install TrackTiming on the Pi :
   - Copy files to the Pi
   - Navigate to the files folder
   - Run: sudo bash install.sh
4. Restart the Pi (sudo reboot) and connect to the TrackTiming WiFi access point. Adjust your settings in the admin page and start driving !
5. You can enable laptimes voice announcement, take notes for your training sessions (setup, track conditions, feel...), and even start a small race on-the-go with your friends.

Optional :
 - DS3231 RTC module (~2€) to keep track of date and time without internet connection
 - I2C LCD module to enable display on the Pi

Note : though it works, there is plenty of room for improvement of the code and interface. Feel free to modify/improve it to suit your needs.
Note 2 : the system works by setting up an open wifi access point with captive portal on the raspberry. Some devices behave strangely or restrict functions on captive portals. In this case, you can "use the network as is", and manually connect to 192.168.4.1 in your preferred browser. Also, some smartphones aren't smart enough to access the local IP using WiFi, and try to use 4G/5G network instead. You can force WiFi to be used by temporarily disabling cellular data.
   
