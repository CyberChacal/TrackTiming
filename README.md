# TrackTiming
Improve your RC track with a simple permanent lap counting system, using only a Raspberry Pi and OpenStint decoder.

No internet, no laptop, no app : anyone with a WiFi capable device can connect and see their laptimes, neatly organized as training sessions.

How it works ?
1. Install a timing loop following OpenStint recommendations : https://github.com/zsellera/openstint/blob/master/docs/setup-simple-rtlsdr.md
2. Connect the RTLSDR v4 to a Raspberry Pi 3B (or newer)
3. Install TrackTiming on the Pi :
   - Copy files to the Pi
   - Navigate to the files folder
   - Run: sudo bash install.sh
4. Restart the Pi (sudo reboot) and connect to the TrackTiming WiFi access point. Adjust your settings in the admin page and start driving !

Optional :
 - DS3231 RTC module (~2€) to keep track of date and time without internet connection
 - I2C LCD module to enable display on the Pi

Note : though it works, there is plenty of room for improvement of the code and interface. Feel free to modify/improve it to suit your needs.
   
