#!/usr/bin/env bash
# =============================================================================
# install.sh — Full TrackTiming install on Raspberry Pi (3B or newer)
# Run with : sudo bash install.sh (+ --wifi SSID [PASSWORD] for temporary internet)
# =============================================================================
set -e
INSTALL_DIR="/opt/tracktiming"
DATA_DIR="$INSTALL_DIR/data"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[OK]${NC} $*"; }
info() { echo -e "${YELLOW}[..] $*${NC}"; }
err()  { echo -e "${RED}[ERR]${NC} $*"; exit 1; }

[ "$(id -u)" -eq 0 ] || err "This script must be run as root : sudo bash install.sh"

# =============================================================================
# 0. TEMPORARY WIFI CONNECTION (optional)
# =============================================================================
# Disable access point and connect to wifi for updates
AP_WAS_ACTIVE=0

wifi_connect() {
    local ssid="$1" pass="$2"
    info "Switching to WiFi (SSID : $ssid)..."
    # Stop AP services if running
    systemctl stop tracktiming  2>/dev/null || true
    systemctl stop openstint    2>/dev/null || true
    systemctl stop dnsmasq      2>/dev/null || true
    systemctl stop hostapd      2>/dev/null || true
    systemctl stop wlan0-static-ip 2>/dev/null || true
    # Remove static IP from wlan0 if it was set
    ip addr del 192.168.4.1/24 dev wlan0 2>/dev/null || true
    # Give wlan0 back to NetworkManager
    rm -f /etc/NetworkManager/conf.d/tracktiming.conf
    systemctl reload NetworkManager 2>/dev/null || true
    sleep 2
    # Connect to the specified WiFi network
    if [ -n "$pass" ]; then
        nmcli dev wifi connect "$ssid" password "$pass" ifname wlan0 2>/dev/null \
        || err "Impossible to connect to WiFi '$ssid'"
    else
        nmcli dev wifi connect "$ssid" ifname wlan0 2>/dev/null \
        || err "Impossible to connect to WiFi '$ssid' (open network)"
    fi
    AP_WAS_ACTIVE=1
    ok "Connected to '$ssid' — Internet available for updates"
}

wifi_restore_ap() {
    [ "$AP_WAS_ACTIVE" -eq 1 ] || return 0
    info "Restoring TrackTiming access point..."
    nmcli con down "$WIFI_SSID" 2>/dev/null || true
    nmcli con delete "$WIFI_SSID" 2>/dev/null || true
    # Remove wlan0 from NetworkManager
    mkdir -p /etc/NetworkManager/conf.d
    cat > /etc/NetworkManager/conf.d/tracktiming.conf << 'NMCONF'
[keyfile]
unmanaged-devices=interface-name:wlan0
NMCONF
    systemctl reload NetworkManager 2>/dev/null || true
    sleep 1
    systemctl start wlan0-static-ip 2>/dev/null || true
    systemctl start hostapd  2>/dev/null || true
    systemctl start dnsmasq  2>/dev/null || true
    systemctl start openstint   2>/dev/null || true
    systemctl start tracktiming 2>/dev/null || true
    ok "TrackTiming access point restored (192.168.4.1)"
}

# Read arguments : --wifi SSID [PASSWORD]
WIFI_SSID="" WIFI_PASS=""
while [ $# -gt 0 ]; do
    case "$1" in
        --wifi) WIFI_SSID="${2:-}"; WIFI_PASS="${3:-}"; shift 2 ;;
        *) shift ;;
    esac
done

if [ -n "$WIFI_SSID" ]; then
    wifi_connect "$WIFI_SSID" "$WIFI_PASS"
    # Restore AP at the end of the script (even if it fails)
    trap wifi_restore_ap EXIT
else
    echo "    (offline mode — pass --wifi SSID [PASSWORD] for a temporary connection)"
fi

# =============================================================================
# 1. SYSTEM UPDATE
# =============================================================================
info "Updating packages..."
#apt-get update -qq
#apt-get upgrade -y -qq
ok "System up to date"

# =============================================================================
# 2. SYSTEM DEPENDENCIES
# =============================================================================
info "Installing system dependencies..."
apt-get install -y -qq \
    python3 python3-pip python3-smbus \
    i2c-tools \
    hostapd dnsmasq \
    cmake build-essential git \
    libhackrf-dev librtlsdr-dev \
    libliquid-dev libzmq3-dev cppzmq-dev \
    libfec-dev \
    2>/dev/null || true
ok "System dependencies installed"

# =============================================================================
# 3. PYTHON DEPENDENCIES
# =============================================================================
info "Installing Python dependencies..."

# Install via apt or pip as fallback
apt-get install -y -qq \
    python3-flask \
    python3-zmq \
    python3-smbus2 \
    gunicorn \
    2>/dev/null || true

python3 -c "import flask, zmq, smbus2" 2>/dev/null || {
    info "Fallback pip for flask/pyzmq/smbus2..."
    pip3 install --quiet --break-system-packages flask pyzmq smbus2 2>/dev/null \
    || pip3 install --quiet flask pyzmq smbus2 2>/dev/null \
    || err "Impossible to install flask pyzmq and smbus2"
}
command -v gunicorn >/dev/null 2>&1 || {
    info "Fallback pip for gunicorn..."
    pip3 install --quiet --break-system-packages gunicorn 2>/dev/null \
    || pip3 install --quiet gunicorn 2>/dev/null \
    || err "Impossible to install gunicorn"
}
ok "flask pyzmq smbus2 and gunicorn installed"

# RPLCD (optional LCD I2C) — via pip only
apt-get install -y -qq python3-rpi.gpio 2>/dev/null || true
pip3 install --quiet --break-system-packages RPLCD 2>/dev/null \
|| pip3 install --quiet RPLCD 2>/dev/null \
|| true

python3 -c "from RPLCD.i2c import CharLCD" 2>/dev/null \
    && ok "RPLCD installed (LCD I2C)" \
    || echo "    (RPLCD not installed — LCD disabled)"

ok "Python dependencies installed"

# =============================================================================
# 4. I2C ACTIVATION (for RTC+LCD)
# =============================================================================
info "Activating I2C..."
# Bookworm : /boot/firmware/config.txt — Bullseye and before : /boot/config.txt
if [ -f /boot/firmware/config.txt ]; then
    BOOT_CONFIG=/boot/firmware/config.txt
else
    BOOT_CONFIG=/boot/config.txt
fi
if ! grep -q "^dtparam=i2c_arm=on" "$BOOT_CONFIG" 2>/dev/null; then
    echo "dtparam=i2c_arm=on" >> "$BOOT_CONFIG"
    ok "I2C activated in $BOOT_CONFIG (will take effect after next reboot)"
else
    ok "I2C already activated"
fi

# Add DS3231 RTC overlay automatically if a device is detected on I2C address 0x68
if command -v i2cdetect >/dev/null 2>&1; then
    rtc_found=0
    for bus in 1 0; do
        if [ -e "/dev/i2c-$bus" ] && i2cdetect -y "$bus" 0x68 0x68 2>/dev/null | grep -q "68"; then
            rtc_found=1
            break
        fi
    done

    if [ "$rtc_found" -eq 1 ]; then
        if ! grep -q "^dtoverlay=i2c-rtc,ds3231" "$BOOT_CONFIG" 2>/dev/null; then
            echo "dtoverlay=i2c-rtc,ds3231" >> "$BOOT_CONFIG"
            timedatectl set-timezone Etc/UTC
            ok "DS3231 RTC overlay added to $BOOT_CONFIG"
        else
            ok "DS3231 RTC overlay already present"
        fi
    else
        info "No RTC detected on I2C address 0x68; DS3231 overlay skipped"
    fi
else
    info "i2cdetect not available; DS3231 overlay check skipped"
fi

# =============================================================================
# 5. DOWNLOADING / INSTALLATING / UPDATING OPENSTINT
# =============================================================================
info "Install/Update OpenStint..."
OPENSTINT_DIR="/opt/openstint"
OPENSTINT_REPO="https://github.com/zsellera/openstint.git"
OPENSTINT_NEED_BUILD=0

if [ ! -d "$OPENSTINT_DIR/.git" ]; then
    info "Copying OpenStint from $OPENSTINT_REPO..."
    rm -rf "$OPENSTINT_DIR"
    git clone --depth=1 "$OPENSTINT_REPO" "$OPENSTINT_DIR" \
        && ok "OpenStint repository cloned into $OPENSTINT_DIR" \
        || err "Failed to clone OpenStint (please check your internet connection)"
    OPENSTINT_NEED_BUILD=1
else
    info "Checking for OpenStint updates..."
    BEFORE=$(git -C "$OPENSTINT_DIR" rev-parse HEAD 2>/dev/null || echo "unknown")
    OPENSTINT_TMP="${OPENSTINT_DIR}.tmp"
    rm -rf "$OPENSTINT_TMP"
    GIT_ERR_FILE=$(mktemp)
    git clone --depth=1 "$OPENSTINT_REPO" "$OPENSTINT_TMP" 2>"$GIT_ERR_FILE" || true
    if [ -d "$OPENSTINT_TMP/.git" ]; then
        AFTER=$(git -C "$OPENSTINT_TMP" rev-parse HEAD 2>/dev/null || echo "unknown")
        rm -f "$GIT_ERR_FILE"
        if [ "$BEFORE" != "$AFTER" ]; then
            [ -d "$OPENSTINT_DIR/build" ] && mv "$OPENSTINT_DIR/build" "$OPENSTINT_TMP/build" || true
            rm -rf "$OPENSTINT_DIR"
            mv "$OPENSTINT_TMP" "$OPENSTINT_DIR"
            ok "OpenStint updated ($(echo "$BEFORE" | cut -c1-7) → $(echo "$AFTER" | cut -c1-7))"
            OPENSTINT_NEED_BUILD=1
        else
            rm -rf "$OPENSTINT_TMP"
            ok "OpenStint already up to date ($(echo "$BEFORE" | cut -c1-7))"
        fi
    else
        GIT_ERR=$(cat "$GIT_ERR_FILE"); rm -f "$GIT_ERR_FILE"; rm -rf "$OPENSTINT_TMP"
        echo -e "${YELLOW}    (Update of OpenStint ignored — no access to GitHub)${NC}"
        echo -e "${YELLOW}    Advice : rerun with --wifi SSID [PASSWORD] to update${NC}"
        echo -e "${YELLOW}    DDetails   : $(echo "$GIT_ERR" | tail -1)${NC}"
        ok "OpenStint kept at current version ($(echo "$BEFORE" | cut -c1-7))"
    fi
fi

if [ "$OPENSTINT_NEED_BUILD" -eq 1 ]; then
    info "Compiling OpenStint..."
    (
        cd "$OPENSTINT_DIR"
        rm -rf build
        mkdir -p build && cd build
        cmake .. \
            -DCMAKE_BUILD_TYPE=Release \
            -Wno-dev \
            -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
            2>/dev/null
        make -j$(nproc)
    ) && ok "OpenStint compiled in $OPENSTINT_DIR/" \
      || echo -e "${YELLOW}    (Compilation of OpenStint failed — compile manually from $OPENSTINT_DIR)${NC}"
fi

# =============================================================================
# 6. TRACKTIMING INSTALL
# =============================================================================
info "Installing TrackTiming in $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR" "$DATA_DIR"

# Copy Python file
cp "$SCRIPT_DIR/track_timing.py" "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/track_timing.py"

# Copy static files (web interface) if they exist
if [ -d "$SCRIPT_DIR/static" ]; then
    cp -r "$SCRIPT_DIR/static" "$INSTALL_DIR/"
    ok "Static files copied"
else
    mkdir -p "$INSTALL_DIR/static"
    echo "    (empty static/ folder — copy index.html, script.js, style.css, admin.html, admin.js from the Arduino)"
fi
ok "TrackTiming installed in $INSTALL_DIR"

# =============================================================================
# 7. REMOVE wlan0 FROM NETWORKMANAGER (for access point mode)
# =============================================================================
info "Removing wlan0 from NetworkManager..."
mkdir -p /etc/NetworkManager/conf.d
cat > /etc/NetworkManager/conf.d/tracktiming.conf << 'NMCONF'
[keyfile]
unmanaged-devices=interface-name:wlan0
NMCONF
systemctl restart NetworkManager 2>/dev/null || true
ok "wlan0 excluded from NetworkManager"

# =============================================================================
# 8. HOSTAPD CONFIGURATION (for access point mode, set password here if desired)
# =============================================================================
info "Setting up hostapd..."

cat > /etc/hostapd/hostapd.conf << 'HOSTAPD'
interface=wlan0
driver=nl80211
ssid=TrackTiming
hw_mode=g
channel=6
wmm_enabled=0
macaddr_acl=0
auth_algs=1
ignore_broadcast_ssid=0
# UNCOMMENT FOLLOWING 2 LINES TO SET WPA2 PASSWORD :
#wpa=2
#wpa_passphrase=password
HOSTAPD

sed -i 's|#DAEMON_CONF=.*|DAEMON_CONF="/etc/hostapd/hostapd.conf"|' /etc/default/hostapd 2>/dev/null || true
echo 'DAEMON_CONF="/etc/hostapd/hostapd.conf"' > /etc/default/hostapd
ok "hostapd configured (SSID : TrackTiming)"

# =============================================================================
# 9. DNSMASQ CONFIGURATION (DHCP + DNS wildcard for captive portal)
# =============================================================================
info "Setting up dnsmasq..."

# Save original dnsmasq.conf if not already saved
[ -f /etc/dnsmasq.conf.orig ] || cp /etc/dnsmasq.conf /etc/dnsmasq.conf.orig

cat > /etc/dnsmasq.conf << 'DNSMASQ'
# TrackTiming — dnsmasq config
interface=wlan0
bind-interfaces
dhcp-range=192.168.4.2,192.168.4.100,255.255.255.0,24h
# DNS wildcard : redirect all domains to 192.168.4.1
address=/#/192.168.4.1
DNSMASQ

ok "dnsmasq configured (DHCP + DNS wildcard 192.168.4.1)"

# =============================================================================
# 10. SET STATIC IP FOR wlan0 (dedicated systemd service)
# =============================================================================
# Dedicated service to ensure wlan0 is set to 192.168.4.1 before dnsmasq starts
info "Setting static IP for wlan0..."

cat > /etc/systemd/system/wlan0-static-ip.service << 'WLAN0SVC'
[Unit]
Description=Set static IP on wlan0 for TrackTiming AP
After=hostapd.service
Before=dnsmasq.service

[Service]
Type=oneshot
ExecStart=/sbin/ip addr add 192.168.4.1/24 dev wlan0
ExecStartPost=/sbin/iw wlan0 set power_save off
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
WLAN0SVC

systemctl daemon-reload
systemctl enable wlan0-static-ip
ok "wlan0-static-ip service created and enabled (192.168.4.1 assigned after hostapd)"

# =============================================================================
# 11. TRACKTIMING SYSTEMD SERVICE (Gunicorn webserver)
# =============================================================================
info "Installing tracktiming systemd service (Gunicorn)..."
GUNICORN_BIN=$(command -v gunicorn || echo /usr/bin/gunicorn)
cat > /etc/systemd/system/tracktiming.service << TRACKSVC
[Unit]
Description=TrackTiming Lap Timer (Gunicorn)
After=network.target openstint.service
Wants=openstint.service

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR
Environment=TRACKTIMING_DATA=$DATA_DIR
Environment=TRACKTIMING_LOG_LEVEL=INFO
ExecStart=$GUNICORN_BIN track_timing:app \\
    --bind 0.0.0.0:80 \\
    --workers 1 \\
    --threads 4 \\
    --timeout 30 \\
    --access-logfile - \\
    --error-logfile -
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
TRACKSVC

systemctl daemon-reload
systemctl enable tracktiming
ok "Service tracktiming (Gunicorn) installed and enabled"

# =============================================================================
# 12. ACTIVATING WEB SERVICES
# =============================================================================
info "Activation of hostapd and dnsmasq..."
systemctl unmask hostapd 2>/dev/null || true
systemctl enable hostapd dnsmasq
ok "hostapd and dnsmasq activated"

# =============================================================================
# 13. OPENSTINT SYSTEMD SERVICE (for RTL-SDR)
# =============================================================================
info "Setting up openstint service..."

GAIN_ENV_FILE="$DATA_DIR/openstint_gain.env"
if [ ! -f "$GAIN_ENV_FILE" ]; then
    echo "OPENSTINT_GAIN=20" > "$GAIN_ENV_FILE"
    ok "Gain file created : $GAIN_ENV_FILE (default : 20 dB)"
else
    ok "Gain file already present : $GAIN_ENV_FILE"
fi

OPENSTINT_BIN=""
for candidate in \
    "$OPENSTINT_DIR/build/src/openstint_rtlsdr" \
    "$OPENSTINT_DIR/build/src/openstint_hackrf" \
    "$OPENSTINT_DIR/build/src/openstint" \
    "$OPENSTINT_DIR/src/openstint_rtlsdr" \
    "$OPENSTINT_DIR/src/openstint_hackrf" \
    "$OPENSTINT_DIR/src/openstint"; do
    if [ -x "$candidate" ]; then
        OPENSTINT_BIN="$candidate"
        break
    fi
done

if [ -z "$OPENSTINT_BIN" ]; then
    OPENSTINT_BIN="$OPENSTINT_DIR/build/src/openstint_rtlsdr"
    echo -e "${YELLOW}    (Can't find openstint binary — the service will point to $OPENSTINT_BIN)${NC}"
else
    ok "OpenStint binary detected : $OPENSTINT_BIN"
fi

cat > /etc/systemd/system/openstint.service << OPENSTINTSVC
[Unit]
Description=OpenStint Laptiming Decoder
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=$OPENSTINT_DIR
EnvironmentFile=-$GAIN_ENV_FILE
ExecStart=/bin/sh -c '$OPENSTINT_BIN -g \${OPENSTINT_GAIN:-20}'
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
OPENSTINTSVC

systemctl daemon-reload
systemctl enable openstint
ok "Service openstint installed and enabled"

# =============================================================================
# 14. SUDOERS — OPENSTINT RESTART WITHOUT PASSWORD
# =============================================================================
info "Setting up sudoers for openstint restart..."
SUDOERS_FILE="/etc/sudoers.d/tracktiming"
cat > "$SUDOERS_FILE" << 'SUDOERS'
# Allow track_timing to restart openstint for gain settings
pi ALL=(ALL) NOPASSWD: /bin/systemctl restart openstint
SUDOERS
chmod 0440 "$SUDOERS_FILE"
# Syntax check for sudoers (prevents locking yourself out of the system)
visudo -c -f "$SUDOERS_FILE" 2>/dev/null \
    && ok "Sudoers rule created : $SUDOERS_FILE" \
    || { rm -f "$SUDOERS_FILE"; echo -e "${YELLOW}    (Invalid sudoers file — deleted. Add manually : pi ALL=(ALL) NOPASSWD: /bin/systemctl restart openstint)${NC}"; }

# =============================================================================
# SUMMARY
# =============================================================================
echo ""
echo -e "${GREEN}============================================================${NC}"
echo -e "${GREEN}  Install finished !${NC}"
echo -e "${GREEN}============================================================${NC}"
echo ""
echo "  TrackTiming files    : $INSTALL_DIR"
echo "  Data                 : $DATA_DIR"
echo "  OpenStint            : $OPENSTINT_DIR"
echo "  RTL-SDR gain         : $GAIN_ENV_FILE"
echo "  Sudoers              : /etc/sudoers.d/tracktiming"
echo "  HTTP server          : Gunicorn (1 worker × 4 threads)"
echo ""
echo "  Next steps :"
echo ""
echo "  1. Restart the Raspberry Pi :"
echo "     sudo reboot"
echo ""
echo "  2. After reboot, the services start automatically :"
echo "     sudo systemctl status tracktiming"
echo "     sudo systemctl status openstint"
echo ""
echo "  3. Connect to 'TrackTiming' WiFi."
echo "     The browser will open automatically on http://192.168.4.1"
echo ""
echo "  4. Set the RTL-SDR gain from the admin page (section Receiver Gain)."
echo "     The value is saved in $GAIN_ENV_FILE"
echo "     and openstint restarts automatically to apply it."
echo ""
echo "  If need for internet after installation (to install future updates) :"
echo "     sudo bash install.sh --wifi SSID password"
echo ""
