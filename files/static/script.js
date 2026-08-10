// ═══════════════════════════════════════════════════════════════════════════════
// TrackTiming — script.js
// ═══════════════════════════════════════════════════════════════════════════════

// ── Global state ───────────────────────────────────────────────────────────────
let drivers = {}; // { transponder: { name, class } }
let currentMode = "all";
let refreshInterval = null;
let sessionStats = {};
let lastLapId   = 0;
let lastSessId  = 0;
let raceLapsCache    = [];  // [{id,transponder,sessionid,laptime}]
let raceSessCache    = [];  // [{id,transponder,sessionid,timestamp}]
let raceLapsCursor   = 0;   // index into raceLapsCache up to which we've already processed
let rssiMap = {};
let serverTimeOffset = 0;
let voiceEnabled = false;
let voiceLastLapByDriver = {};

function byId(id) { return document.getElementById(id); }

function formatDate(d) { return d.toISOString().split("T")[0]; }

function formatLapTime(sec) {
  if (sec === null || sec === undefined || !isFinite(Number(sec))) return "";
  const total = Number(sec);
  const totalInt = Math.floor(total);
  let ms = Math.round((total - totalInt) * 1000);
  let minutes = Math.floor(totalInt / 60);
  let seconds = totalInt % 60;
  if (ms === 1000) { ms = 0; seconds++; if (seconds === 60) { seconds = 0; minutes++; } }
  return `${minutes}:${String(seconds).padStart(2,"0")}.${String(ms).padStart(3,"0")}`;
}

function getSelectedDateRange() {
  const start = byId("startDate").value;
  const end   = byId("endDate").value;
  return { start: start || null, end: end || null };
}

function parseLocalTimestamp(timestamp) {
  if (!timestamp) return NaN;
  const parts = timestamp.split(" ");
  if (parts.length !== 2) return NaN;
  const [datePart, timePart] = parts;
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute, second] = timePart.split(":").map(Number);
  return new Date(year, month - 1, day, hour, minute, second).getTime();
}

function parseServerTimestamp(timestamp) {
  return parseLocalTimestamp(timestamp) + (serverTimeOffset || 0);
}

// ── Drivers helpers ─────────────────────────────────────────────────────────────
async function loadDrivers() {
  try {
    const r = await fetch("/api/drivers");
    if (!r.ok) throw new Error("Failed to load drivers");
    const arr = await r.json();
    drivers = {};
    for (const d of arr) drivers[d.id] = { name: d.name, class: d.class };
  } catch (err) {
    console.error("Error loading drivers:", err);
    drivers = {};
  }
}

async function populateDriverSelect() {
  const select = byId("driverSelect");
  select.innerHTML = '<option value="">Select Driver</option>';
  for (const [tp, d] of Object.entries(drivers)) {
    const opt = document.createElement("option");
    opt.value = tp;
    opt.textContent = d.class ? `${d.name} (${d.class})` : `${d.name} (${tp})`;
    select.appendChild(opt);
  }
  select.addEventListener("change", () => {
    const tp = select.value;
    const url = new URL(window.location.href);
    tp ? url.searchParams.set("tp", tp) : url.searchParams.delete("tp");
    try { window.history.replaceState({}, "", url); } catch(e) {}
  });
}

function populateClassFilter() {
  const sel = byId("classFilter");
  if (!sel) return;
  const classes = [...new Set(Object.values(drivers).map(d => d.class).filter(c => c && c.trim()))];
  sel.innerHTML = `<option value="">All</option>` + classes.map(c => `<option value="${c}">${c}</option>`).join("");
}

async function getServerTimeMs() {
  const res = await fetch("/api/time");
  const data = await res.json();
  if (typeof data.serverTimeMs === "number") return data.serverTimeMs;
  if (typeof data.serverTimeISO === "string") return Date.parse(data.serverTimeISO);
  throw new Error("Invalid server time response");
}

// ── Voice announcement ────────────────────────────────────────────────────────
function toggleVoice() {
  voiceEnabled = !voiceEnabled;
  if (!voiceEnabled) {
    voiceLastLapByDriver = {};
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  }
  stopAutoRefresh();
  if (currentMode !== "race") startAutoRefresh();
  const btn = byId("voiceBtn");
  if (btn) {
    btn.title = voiceEnabled ? "Voice announcements ON" : "Voice announcements OFF";
    btn.innerHTML = voiceEnabled ? "&#x1F50A" : "&#x1F507";
    btn.classList.toggle("active", voiceEnabled);
  }
}
function speakLapTime(lapSec, driverName) {
  if (!voiceEnabled || !window.speechSynthesis) return;
  const t = Number(lapSec);
  if (!isFinite(t) || t <= 0) return;
  const totalInt = Math.floor(t);
  const tenths = Math.floor((t - totalInt) * 10);
  const minutes = Math.floor(totalInt / 60);
  const seconds = totalInt % 60;
  let timeText;
  if (minutes > 0) {
    timeText = `${minutes} minute ${seconds}`;
  } else if (seconds < 10) {
    timeText = `${seconds} point ${tenths}`;
  } else {
    timeText = `${seconds} ${tenths}`;
  }
  const text = driverName ? `${driverName} — ${timeText}` : timeText;
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = (navigator.languages && navigator.languages[0]) || navigator.language || navigator.userLanguage || "en-US";
  utter.rate = 1.1;
  window.speechSynthesis.speak(utter);
}
function announceNewLaps(driversData) {
  if (!voiceEnabled) return;
  for (const d of driversData) {
    const key = `${d.numLaps}_${d.lastLap}`;
    const prev = voiceLastLapByDriver[d.id];
    if (prev !== undefined && prev !== key) speakLapTime(d.lastLap, d.name || null);
    voiceLastLapByDriver[d.id] = key;
  }
}

// ── Mode ALL ──────────────────────────────────────────────────────────────────
async function showAllLaps() {
  const tbody = document.querySelector("#laps tbody");
  const thead = document.querySelector("#laps thead");
  thead.innerHTML = "<tr><th>Driver</th><th>Laps</th><th>Best</th><th>Last</th><th>Signal</th></tr>";
  
  const { start, end } = getSelectedDateRange();
  const params = new URLSearchParams();
  if (start) params.set("start", start);
  if (end)   params.set("end",   end);

  const [allLapsResp, rssiResp] = await Promise.all([
    fetch(`/api/allLaps?${params}`),
    fetch("/api/rssi").catch(()=>null)
  ]);
  if (!allLapsResp.ok) return;
  const data     = await allLapsResp.json();
  const rssiData = rssiResp && rssiResp.ok ? await rssiResp.json() : {};

  // Best lap banner
  const bestDiv = byId("bestLapDiv");
  if (bestDiv) {
    const atb = data.allTimeBest;
    let atbStr = "N/A";
    if (atb && atb.laptime !== null) {
      atbStr = Number(atb.laptime).toFixed(3);
      if (atb.timestamp) {
        const dt = new Date(atb.timestamp.replace(" ", "T") + "Z");
        if (!isNaN(dt)) {
          const dd = String(dt.getUTCDate()).padStart(2,"0");
          const mm = String(dt.getUTCMonth()+1).padStart(2,"0");
          const yyyy = dt.getUTCFullYear();
          atbStr += ` <i>(${dd}/${mm}/${yyyy})</i>`;
        }
      }
    }
    const ob = data.overallBest !== null ? Number(data.overallBest).toFixed(3) : "N/A";
    bestDiv.className = "best-lap-info";
    bestDiv.innerHTML = `
      <div class="best-lap-item"><b>Best:</b> <span class="best-lap-value">${ob}</span></div>
      <div class="best-lap-item"><b>All-Time Best:</b> <span class="best-lap-value">${atbStr}</span></div>
    `;
  }

  tbody.innerHTML = "";
  for (const d of data.drivers) {
    let bestStyle = "", lastStyle = "";
    if (data.overallBest !== null && d.bestLap === data.overallBest) bestStyle = "font-weight:bold;color:purple;";
    if (d.lastLap === d.bestLap && d.lastLap === data.overallBest)  lastStyle = "font-weight:bold;color:purple;";
    else if (d.lastLap === d.bestLap)                                lastStyle = "font-weight:bold;color:green;";
    else if (data.overallBest !== null && d.lastLap === data.overallBest) lastStyle = "font-weight:bold;color:purple;";

    // Signal quality bar
    const q = rssiData[d.id] !== undefined ? rssiData[d.id] : null;
    let signalCell = "-";
    if (q !== null) {
      const fillClass = q >= 70 ? "excellent" : q >= 40 ? "good" : "poor";
      signalCell = `<div class="signal-cell">
        <div class="signal-bar"><div class="signal-bar-fill ${fillClass}" style="width:${q}%"></div></div>
        <span class="signal-label ${fillClass}">${q}</span>
      </div>`;
    }

    const tr = document.createElement("tr");
    const nameTd = document.createElement("td");
    const link = document.createElement("a");
    link.href = `?tp=${d.id}`;
    link.className = "plain-link";
    link.textContent = d.name + (d.class ? ` (${d.class})` : "");
    link.setAttribute("role","button"); link.setAttribute("tabindex","0");
    nameTd.appendChild(link);
    tr.appendChild(nameTd);
    tr.innerHTML += `<td>${d.numLaps}</td><td style="${bestStyle}">${Number(d.bestLap).toFixed(3)}</td><td style="${lastStyle}">${Number(d.lastLap).toFixed(3)}</td><td>${signalCell}</td>`;
    tbody.appendChild(tr);
  }
  // New laps announcement
  announceNewLaps(data.drivers);
}

// ── Mode DRIVER ───────────────────────────────────────────────────────────────
async function showDriverLaps() {
  const tp = byId("driverSelect").value;
  if (!tp) { byId("driverLaps").innerHTML = ""; return; }

  const { start, end } = getSelectedDateRange();
  const params = new URLSearchParams({ tp });
  if (start) params.set("start", start);
  if (end)   params.set("end",   end);

  const r = await fetch(`/api/driverLaps?${params}`);
  if (!r.ok) return;
  const data = await r.json();

  sessionStats = {};
  const container = byId("driverLaps");
  container.innerHTML = "";

  // Best lap banner
  const bestDiv = document.createElement("div");
  const atb = data.allTimeBest;
  let atbStr = "N/A";
  if (atb && atb.laptime !== null) {
    atbStr = Number(atb.laptime).toFixed(3);
    if (atb.timestamp) {
      const dt = new Date(atb.timestamp.replace(" ", "T") + "Z");
      if (!isNaN(dt)) {
        const dd = String(dt.getUTCDate()).padStart(2,"0");
        const mm = String(dt.getUTCMonth()+1).padStart(2,"0");
        const yyyy = dt.getUTCFullYear();
        atbStr += ` <i>(${dd}/${mm}/${yyyy})</i>`;
      }
    }
  }
  const ob = data.overallBest !== null ? Number(data.overallBest).toFixed(3) : "N/A";
  bestDiv.className = "best-lap-info";
  bestDiv.innerHTML = `
    <div class="best-lap-item"><b>Best:</b> <span class="best-lap-value">${ob}</span></div>
    <div class="best-lap-item"><b>All-Time Best:</b> <span class="best-lap-value">${atbStr}</span></div>
  `;
  container.appendChild(bestDiv);

  if (!data.days || data.days.length === 0) {
    container.innerHTML += "<i>No laps found for this driver in the selected date range.</i>";
    return;
  }

  for (const dayData of data.days) {
    const sep = document.createElement("hr"); sep.className = "session-day-separator";
    container.appendChild(sep);

    const [yyyy, mm, dd] = dayData.date.split("-");
    const dayHeader = document.createElement("div"); dayHeader.className = "session-day";
    const totalLapCount = dayData.sessions.reduce((s, sess) => s + sess.lapCount, 0);
    const runLabel = dayData.sessions.length === 1 ? "Run" : "Runs";
    dayHeader.innerHTML = `${dd}/${mm}/${yyyy} &nbsp;&ndash;&nbsp; ${dayData.sessions.length} ${runLabel} &nbsp;&ndash;&nbsp; ${totalLapCount} Laps`;
    container.appendChild(dayHeader);

    dayData.sessions.forEach((sess, i) => {
      const lapTimes = sess.laps;
      if (!lapTimes || lapTimes.length === 0) return;

      // Stats display
      const fastest = sess.fastest;
      const avg     = sess.avg10;
      const best3   = sess.best3;
      const best3Start = sess.best3Start;
      const best5   = sess.best5;
      const total   = sess.total;
      const lapCount = sess.lapCount;

      // 5min error time computation (kept client-side for detail display)
      let fiveMinStr = "N/A", fiveMinLostTime = "";
      const errorLapsSet = new Set();
      if (best5 !== null) {
        const fiveMinLaps = lapTimes.slice(0, best5.count);
        const fiveMinAvg = fiveMinLaps.reduce((a,b)=>a+b,0) / fiveMinLaps.length;
        const sorted = [...fiveMinLaps].sort((a,b)=>a-b);
        const mid = Math.floor(sorted.length/2);
        const fiveMinMedian = sorted.length%2!==0 ? sorted[mid] : (sorted[mid-1]+sorted[mid])/2;
        const fiveMinDev = Math.sqrt(fiveMinLaps.reduce((s,l)=>s+Math.pow(l-fiveMinAvg,2),0)/(fiveMinLaps.length-1||1));
        const threshold = fiveMinMedian + 1.5*fiveMinDev;
        const errorLaps = fiveMinLaps.filter(l=>l>threshold);
        const sumLost = (Math.round(10*errorLaps.reduce((s,l)=>s+(l-fiveMinMedian),0))/10).toFixed(1);
        fiveMinLaps.forEach((l,idx)=>{ if(l>threshold) errorLapsSet.add(idx); });
        fiveMinLostTime = sumLost > 0 ? ` (+${sumLost}s)` : "";
        fiveMinStr = `${best5.count} laps - ${formatLapTime(best5.total)}`;
      }

      // Highlight styles
      const fastestStyle = (data.overallBest!==null && fastest===data.overallBest) ? "font-weight:bold;color:purple;" : "";
      const avg10Style   = (data.overallBest10!==null && avg!==null && avg===data.overallBest10) ? "font-weight:bold;color:purple;" : "";
      const best3Style   = (data.overallBest3!==null && best3!==null && best3===data.overallBest3) ? "font-weight:bold;color:purple;" : "";
      const ob5 = data.overallBest5min;
      const fiveMinStyle = (ob5!==null && best5!==null && best5.count===ob5.count && best5.total===ob5.total) ? "font-weight:bold;color:purple;" : "";

      const totalFmt = formatLapTime(total);
      const runNumber = dayData.sessions.length - i;
      const sessionDateMs = parseLocalTimestamp(sess.timestamp);
      const sessionDate = new Date(sessionDateMs);
      const hh = String(sessionDate.getHours()).padStart(2,"0");
      const mn = String(sessionDate.getMinutes()).padStart(2,"0");

      // Session header
      const sessionHeader = document.createElement("div"); sessionHeader.className = "session-name";
      sessionHeader.innerHTML = `
        <div class="session-title"><b>Run ${runNumber} - </b> <span class="session-time">${hh}:${mn}</span></div>
        <div class="session-actions">
          <button type="button" class="note-btn" data-tp="${tp}" data-sid="${sess.sessionid}" aria-expanded="false" title="Edit Notes">&#x270E</button>
          <button type="button" class="fold-btn" data-tp="${tp}" data-sid="${sess.sessionid}" aria-expanded="false" title="Show/Hide Laps">&#x2795</button>
        </div>`;
      container.appendChild(sessionHeader);

      // Notes panel
      const noteDiv = document.createElement("div");
      noteDiv.className = "session-note";
      noteDiv.id = `note_${encodeURIComponent(tp)}_${encodeURIComponent(sess.sessionid)}`;
      noteDiv.style.display = "none";
      const existingNote = loadSessionNote(tp, sess.sessionid);
      noteDiv.innerHTML = `<textarea class="session-note-text" rows="4" placeholder="Write your notes for this run...">${existingNote}</textarea>`;
      container.appendChild(noteDiv);

      // Note button handler
      const noteBtn = sessionHeader.querySelector(".note-btn");
      noteBtn.addEventListener("click", () => {
        stopAutoRefresh();
        const isHidden = noteDiv.style.display === "none";
        container.querySelectorAll(".session-note").forEach(nd => {
          if (nd.style.display !== "none") {
            const hdr = nd.previousElementSibling;
            const btn = hdr ? hdr.querySelector(".note-btn") : null;
            if (btn) saveSessionNote(btn.getAttribute("data-tp"), btn.getAttribute("data-sid"), nd.querySelector(".session-note-text")?.value);
          }
          nd.style.display = "none";
        });
        container.querySelectorAll(".note-btn").forEach(b => { b.classList.remove("open"); b.setAttribute("aria-expanded","false"); });
        if (isHidden) {
          noteDiv.style.display = "block";
          noteBtn.classList.add("open"); noteBtn.setAttribute("aria-expanded","true");
          noteDiv.querySelector(".session-note-text")?.focus();
        } else {
          saveSessionNote(tp, sess.sessionid, noteDiv.querySelector(".session-note-text")?.value);
          noteBtn.classList.remove("open"); noteBtn.setAttribute("aria-expanded","false");
          startAutoRefresh();
        }
        noteBtn.textContent = isHidden ? "\u2716" : "\u270E";
        noteBtn.setAttribute("aria-expanded", String(isHidden));
      });

      // Fold button
      const foldBtn = sessionHeader.querySelector(".fold-btn");
      const lapsId = `laps_${encodeURIComponent(tp)}_${encodeURIComponent(sess.sessionid)}`;
      foldBtn.addEventListener("click", () => {
        const tableEl = document.getElementById(lapsId);
        if (!tableEl) return;
        const isHidden = tableEl.style.display === "none";
        isHidden ? stopAutoRefresh() : startAutoRefresh();
        foldBtn.classList.toggle("open", isHidden);
        tableEl.style.display = isHidden ? "" : "none";
        foldBtn.textContent = isHidden ? "\u2796" : "\u2795";
        foldBtn.setAttribute("aria-expanded", String(isHidden));
      });

      // Stats
      const statsDiv = document.createElement("div"); statsDiv.className = "session-stats";
      statsDiv.innerHTML = `
        <div class="session-stats-line"><b>Total time:</b> ${totalFmt} (<span>${lapCount} laps</span>)</div>
        <div class="session-stats-line"><b>Fastest:</b> <span style="${fastestStyle}">${fastest!==null?Number(fastest).toFixed(3):"N/A"}</span> &nbsp;/&nbsp; <b>Avg 10:</b> <span style="${avg10Style}">${avg!==null?Number(avg).toFixed(3):"N/A"}</span> &nbsp;/&nbsp; <b>Best 3:</b> <span style="${best3Style}">${best3!==null?Number(best3).toFixed(3):"N/A"}</span></div>
        <div class="session-stats-line"><b>5 min:</b> <span style="${fiveMinStyle}">${fiveMinStr}</span><i>${fiveMinLostTime}</i></div>
      `;
      container.appendChild(statsDiv);

      // Store stats for export
      sessionStats[sess.sessionid] = {
        fastest, average: avg, best3: best3??null,
        best5Text: best5 ? (fiveMinStr + fiveMinLostTime) : null,
        best5: best5 ?? null,
        lapCount, total, timestamp: sess.timestamp.replace(" ","T"),
        notes: existingNote,
      };

      // Laps table
      const table = document.createElement("table");
      table.id = lapsId; table.style.display = "none";
      table.innerHTML = "<tr><th>Lap</th><th>Lap Time</th></tr>";
      lapTimes.forEach((lt, idx) => {
        let style = `background-color:${idx%2===0?"#fff":"#eee"};`;
        if (lt === fastest) style += "font-weight:bold;color:green;";
        if (data.overallBest!==null && lt===data.overallBest) style += "font-weight:bold;color:purple;";
        if (best3Start!==-1 && idx>=best3Start && idx<best3Start+3) style += "font-weight:bold;";
        const timeStr = Number(lt).toFixed(3);
        const displayTime = errorLapsSet.has(idx) ? `<i>*${timeStr}*</i>` : timeStr;
        const tr = document.createElement("tr");
        tr.setAttribute("style", style);
        tr.innerHTML = `<td>${idx+1}</td><td>${displayTime}</td>`;
        table.appendChild(tr);
      });
      statsDiv.appendChild(table);
    });
  }
  // New laps announcement
  const lastDay = data.days[0];
  const lastSess = lastDay?.sessions[0];
  const lastLap = lastSess?.laps?.[lastSess.laps.length - 1];
  const totalLaps = data.days.reduce((n, day) => n + day.sessions.reduce((m, s) => m + s.lapCount, 0), 0);
  if (lastLap !== undefined) {
    announceNewLaps([{ id: tp, numLaps: totalLaps, lastLap }]);
  }
}

// ── Mode LEADERBOARD ──────────────────────────────────────────────────────────
async function showLeaderboard() {
  const tbody = document.querySelector("#laps tbody");
  const thead = document.querySelector("#laps thead");
  thead.innerHTML = "<tr><th>Driver</th><th>Class</th><th>Fastest Lap</th><th>Best Run (5min)</th><th>Total Laps</th></tr>";

  const selectedClass = byId("classFilter")?.value || "";
  const params = new URLSearchParams({ limit: "100" });
  if (selectedClass) params.set("class", selectedClass);

  const r = await fetch(`/api/leaderboard?${params}`);
  if (!r.ok) return;
  const leaderboard = await r.json();

  tbody.innerHTML = "";
  leaderboard.forEach((entry, idx) => {
    let nameStyle = "";
    if (idx===0) nameStyle="color:#BBA320;font-weight:bold;";
    else if (idx===1) nameStyle="color:#6F6F6F;font-weight:bold;";
    else if (idx===2) nameStyle="color:#9E5810;font-weight:bold;";
    const f5 = entry.fastest5min ? `${entry.fastest5min.count} laps - ${formatLapTime(entry.fastest5min.total)}` : "N/A";
    const tr = document.createElement("tr");
    tr.innerHTML = `<td style="${nameStyle}">${entry.name}</td><td>${entry.class||""}</td><td>${Number(entry.fastestlap).toFixed(3)}</td><td>${f5}</td><td>${entry.lapCount}</td>`;
    tbody.appendChild(tr);
  });
}

// ── Mode RACE ─────────────────────────────────────────────────────────────────
let raceActive = false;
let raceStartTime = null;
let raceEndTime = null;
let raceMainEndTime = null;
let raceDurationMinutes = 5;
let raceLapData = {};
let raceLapNumbers = {};
let raceInterval = null;
let raceDrivers = [];
let raceLapRows = [];
let raceGraceUsed = {};
let raceEndSound = null;
let raceEndTimeout = null;

function showRaceMode() {
  byId("raceControls").style.display = "";
  byId("laps").style.display = "none";
  byId("driverLaps").style.display = "none";
  byId("driverSelectWrapper").style.display = "none";
  byId("bestLapDiv").style.display = "none";
  document.querySelector(".display-bar-bottom").style.display = "none";
  resetRaceUI();
}

function resetRaceUI() {
  byId("raceCountdown").innerText = "";
  byId("raceStatus").innerText = "";
  byId("raceResults").innerHTML = "";
  byId("raceTableContainer").innerHTML = "";
  byId("raceStartBtn").disabled = false;
}

async function startRace() {
  raceDurationMinutes = parseInt(byId("raceDuration").value) || 5;
  byId("raceStartBtn").disabled = true;
  byId("raceResults").innerHTML = "";
  byId("raceTableContainer").innerHTML = "";
  raceLapData = {};
  raceLapNumbers = {};
  raceLapRows = [];
  raceDrivers = [];
  raceActive = false;
  raceStartTime = null;
  raceEndTime = null;
  raceMainEndTime = null;
  raceGraceUsed = {};
  voiceLastLapByDriver = {};
  lastLapId = 0; lastSessId = 0;
  raceLapsCache = []; raceSessCache = []; raceLapsCursor = 0;

  // 10s countdown
  let countdown = 10;
  byId("raceCountdown").style.display = "";
  byId("raceCountdown").innerText = `Race starts in ${countdown}...`;
  byId("raceStatus").innerText = "";
  let countdownInterval = setInterval(async () => {
    countdown--;
    if (countdown > 0) {
      byId("raceCountdown").innerText = `Race starts in ${countdown}...`;
    } else {
      clearInterval(countdownInterval);
      byId("raceCountdown").innerText = "GO!";
      playSound(1200, 1000); // start sound
      raceActive = true;
      raceStartTime = await getServerTimeMs();
      serverTimeOffset = raceStartTime - Date.now();

      // main race end + 30s implicit grace included in raceEndTime
      raceMainEndTime = raceStartTime + raceDurationMinutes * 60 * 1000;
      raceEndTime     = raceMainEndTime + 30 * 1000;

      // reset per-race bookkeeping
      raceLapData = {};
      raceLapRows = [];
      raceDrivers = [];
      raceGraceUsed = {};

      // current max IDs to process only new laps
      try {
        const [lr, sr] = await Promise.all([fetch("/api/laps?fromRow=1"), fetch("/api/sessions?fromRow=1")]);
        const [ld, sd] = await Promise.all([lr.json(), sr.json()]);
        lastLapId  = ld.lastId  || 0;
        lastSessId = sd.lastId  || 0;
        raceLapsCache = ld.laps || [];
        raceSessCache = sd.sessions || [];
      } catch(e) { lastLapId = 0; lastSessId = 0; }

      // start polling until we call endRace()
      pollRaceLaps();
      if (raceInterval) clearInterval(raceInterval);
      raceInterval = setInterval(pollRaceLaps, 1000);

      // program race end sound at raceMainEndTime
      if (raceEndSound) clearTimeout(raceEndSound);
      raceEndSound = setTimeout(() => playSound(1200, 500), raceDurationMinutes * 60 * 1000);

      // fallback: ensure race ends at raceEndTime if not finished
      if (raceEndTimeout) clearTimeout(raceEndTimeout);
      raceEndTimeout = setTimeout(() => { if (raceActive) endRace(); }, raceDurationMinutes * 60 * 1000 + 30000);
    }
  }, 1000);
}

function playSound(lengthMs,freqHz) {
  try {
    const dur = Number(lengthMs);
    const fr = Number(freqHz);
    if (!isFinite(dur) || dur <= 0) return;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = fr;
    osc.connect(ctx.destination);
    osc.start();
    setTimeout(() => { try { osc.stop(); ctx.close(); } catch (e) {} }, dur);
  } catch (e) {}
}

async function pollRaceLaps() {
  // Fetch only new laps/sessions since last poll
  try {
    const [lr, sr] = await Promise.all([
      fetch(`/api/laps?fromRow=${lastLapId + 1}`),
      fetch(`/api/sessions?fromRow=${lastSessId + 1}`)
    ]);
    const [ld, sd] = await Promise.all([lr.json(), sr.json()]);
    if (ld.laps && ld.laps.length > 0) {
      raceLapsCache.push(...ld.laps);
      lastLapId = ld.lastId;
    }
    if (sd.sessions && sd.sessions.length > 0) {
      raceSessCache.push(...sd.sessions);
      lastSessId = sd.lastId;
    }
  } catch(e) { return; }

  if (!raceStartTime) return;

  // Build sessions lookup
  const driverSessions = {};
  for (const s of raceSessCache) {
    if (!driverSessions[s.transponder]) driverSessions[s.transponder] = [];
    driverSessions[s.transponder].push(s);
  }

  // Process only new laps since last poll
  const newLaps = raceLapsCache.slice(raceLapsCursor);
  raceLapsCursor = raceLapsCache.length;

  for (const newLap of newLaps) {
    const tp = newLap.transponder;
    if (!raceLapData[tp]) { raceLapData[tp] = []; raceDrivers.push(tp); }

    // Find the relevant session for this driver (earliest with laps after raceStart)
    const sessList = (driverSessions[tp] || []).slice().sort((a,b) => {
      const ta = parseServerTimestamp(a.timestamp) || 0;
      const tb = parseServerTimestamp(b.timestamp) || 0;
      return ta - tb;
    });
    let relevantSession = null;
    for (const session of sessList) {
      if (!session.timestamp) continue;
      const sessionStartMs = parseServerTimestamp(session.timestamp);
      if (isNaN(sessionStartMs)) continue;
      const sessionLaps = raceLapsCache.filter(l => l.transponder===tp && l.sessionid===session.sessionid);
      if (!sessionLaps.length) continue;
      const lapStarts = sessionLaps.map((L,i) => {
        let a = 0; for (let j=0;j<=i;j++) a += Number(sessionLaps[j].laptime);
        return sessionStartMs + Math.round(a*1000) - Math.round(Number(L.laptime)*1000);
      });
      if (lapStarts.some(s => s >= raceStartTime)) { relevantSession = session; break; }
    }
    if (!relevantSession) continue;

    // Now process this new lap in the context of the relevant session
    const sessionStartMs = parseServerTimestamp(relevantSession.timestamp);
    const sessionLaps    = raceLapsCache.filter(l => l.transponder===tp && l.sessionid===relevantSession.sessionid);
    const lapIndex       = sessionLaps.findIndex(l => l.id===newLap.id);
    if (lapIndex === -1) continue;

    // Calculate cumulative end times for the session
    const cum = []; let acc = 0;
    for (const L of sessionLaps) { acc += Number(L.laptime); cum.push(acc); }
    const lapEnds   = cum.map(c => sessionStartMs + Math.round(c*1000));
    const lapStarts = sessionLaps.map((L,i) => lapEnds[i] - Math.round(Number(L.laptime)*1000));

    // Find firstIdx (first lap starting >= raceStartTime)
    let firstIdx = -1;
    for (let i=0;i<lapStarts.length;i++) { if (lapStarts[i]>=raceStartTime) {firstIdx=i; break;} }
    if (firstIdx===-1) continue;

    // If this is the first lap for the driver, add lap0 (partial lap)
    if (raceLapData[tp].length===0 && lapIndex===firstIdx) {
      const lap0 = (lapStarts[firstIdx] - raceStartTime) / 1000;
      if (lap0 > 0.01) raceLapData[tp].push(Number(lap0));
    }

    // Add the lap if it fits the criteria
    const endMs = lapEnds[lapIndex];
    if (endMs<=raceMainEndTime) {
      raceLapData[tp].push(Number(newLap.laptime));
    } else if (endMs>raceMainEndTime && endMs<=raceEndTime) {
      if (!raceGraceUsed[tp]) {
        raceLapData[tp].push(Number(newLap.laptime));
        raceGraceUsed[tp] = true;
      }
    }
  }

  // Build rows
  raceLapRows = [];
  let maxLaps = 0;
  for (const d of raceDrivers) { const len=(raceLapData[d]||[]).length; if(len>maxLaps) maxLaps=len; }
  for (let i=0;i<maxLaps;i++) {
    const row = {lapNum:i+1};
    for (const d of raceDrivers) row[d]=(raceLapData[d]&&raceLapData[d][i]!==undefined)?Number(raceLapData[d][i]).toFixed(3):"";
    raceLapRows.push(row);
  }

  // New laps announcement
  announceNewLaps(raceDrivers
    .filter(tp => (raceLapData[tp] || []).length > 0)
    .map(tp => {
      const arr = raceLapData[tp] || [];
      return { id: tp, numLaps: arr.length, lastLap: arr[arr.length - 1], name: drivers[tp] ? drivers[tp].name : tp };
    }));

  renderLiveRaceResults();
  renderRaceTable();

  // early finish: after main end, if every driver has either a lap after main end or consumed grace -> finish
  const nowServer = Date.now() + (serverTimeOffset||0);
  if (nowServer>=raceMainEndTime) {
    let allDone = true;
    for (const tp of raceDrivers) { if (!raceGraceUsed[tp]) {allDone=false; break;} }
    if (allDone) endRace();
  }
}

function renderRaceTable() {
  const container = byId("raceTableContainer");
  // Only show drivers that have at least one recorded lap
  const displayDrivers = raceDrivers.filter(d=>(raceLapData[d]||[]).length>0);
  if (!displayDrivers.length) { container.innerHTML="<i>No laps recorded yet.</i>"; return; }

  // Compute best lap for each displayed driver (excluding lap 0, which is the first lap)
  const bestLapByDriver = {};
  for (const d of displayDrivers) {
    const arr = raceLapData[d]||[];
    bestLapByDriver[d] = arr.length>1 ? Math.min(...arr.slice(1)) : null;
  }

  // Rebuild table only if the set of drivers changed
  let table = container.querySelector("table");
  const existingHeaders = table ? [...table.querySelectorAll("thead th")].slice(1).map(th=>th.dataset.tp) : [];
  const driversChanged = existingHeaders.length !== displayDrivers.length || displayDrivers.some((d,i)=>d!==existingHeaders[i]);
  if (driversChanged) {
    let html = `<table><thead><tr><th>Lap #</th>`;
    for (const d of displayDrivers) html += `<th data-tp="${d}">${drivers[d]?drivers[d].name:d}</th>`;
    html += `</tr></thead><tbody></tbody></table>`;
    container.innerHTML = html;
    table = container.querySelector("table");
  }

  const tbody = table.querySelector("tbody");
  const existingRows = tbody.querySelectorAll("tr");

  for (let i=0; i<raceLapRows.length; i++) {
    const row = raceLapRows[i];
    if (i < existingRows.length) {
      const cells = existingRows[i].querySelectorAll("td");
      displayDrivers.forEach((d, di) => {
        const cell = cells[di+1];
        if (!cell) return;
        const val = row[d] || "";
        const bold = val!==""&&bestLapByDriver[d]!==null&&row.lapNum>1&&Number(val)===bestLapByDriver[d];
        cell.style.fontWeight = bold ? "bold" : "";
        if (cell.textContent !== val) cell.textContent = val;
      });
    } else {
      // Append new row
      const tr = document.createElement("tr");
      let html = `<td>${row.lapNum}</td>`;
      for (const d of displayDrivers) {
        const val = row[d] || "";
        const bold = val!==""&&bestLapByDriver[d]!==null&&row.lapNum>1&&Number(val)===bestLapByDriver[d];
        html += `<td style="${bold?"font-weight:bold;":""}">${val}</td>`;
      }
      tr.innerHTML = html;
      tbody.appendChild(tr);
    }
  }
}

function endRace() {
  if (!raceActive) return;
  raceActive = false;
  if (raceInterval) { clearInterval(raceInterval); raceInterval=null; }
  if (raceEndSound) { clearTimeout(raceEndSound); raceEndSound=null; }
  if (raceEndTimeout) { clearTimeout(raceEndTimeout); raceEndTimeout=null; }
  byId("raceStatus").innerHTML="<b>&#x1F3C1; Race finished! &#x1F3C1;</b>";
  playSound(600,500); // finish sound
  const timerDiv=byId("raceTimer");
  if(timerDiv) timerDiv.style.display="none";
  const startBtn=byId("raceStartBtn");
  if(startBtn) startBtn.disabled=false;
  renderLiveRaceResults();
}

function renderLiveRaceResults() {
  const resultsDiv=byId("raceResults");
  const timerDiv=byId("raceTimer");
  const countdownDiv=byId("raceCountdown");

  const displayDrivers=raceDrivers.filter(d=>(raceLapData[d]||[]).length>0);
  if(countdownDiv) countdownDiv.style.display=(displayDrivers&&displayDrivers.length>0)?"none":"";
  if(timerDiv) timerDiv.style.display=raceActive?"":"none";

  // Timer: use server-aligned "now"
  let nowServer = Date.now() + serverTimeOffset;
  let elapsed = raceStartTime ? Math.max(0, Math.floor((nowServer - raceStartTime) / 1000)) : 0;
  let duration = raceMainEndTime && raceStartTime ? Math.floor((raceMainEndTime - raceStartTime) / 1000) : 0;
  const fmt = s => `${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;
  if (timerDiv) {
    timerDiv.innerHTML = `Race Time: ${fmt(elapsed)} / ${fmt(duration)}`;
  }
  if (!raceLapData || displayDrivers.length === 0) {
    resultsDiv.innerHTML = "";
    return;
  }

  // Build standings
  let standings=displayDrivers.map(tp=>{
    const arr=raceLapData[tp]||[];
    const lapsN=arr.length;
    const lastLap=arr[lapsN-1]||null;
    let totalTime=0; for(const v of arr) totalTime+=Number(v);
    // Find best lap for this driver, excluding lap 0 (partial lap)
    let bestLap=arr.length>1?Math.min(...arr.slice(1)):null;
    return {tp,laps:lapsN,lastLap,totalTime,bestLap};
  });

  // Find overall best lap (excluding lap 0 for all drivers)
  let overallBest = null;
  for (const s of standings) {
    if (s.bestLap !== null && (overallBest === null || s.bestLap < overallBest)) {
      overallBest = s.bestLap;
    }
  }

  // Sort: most laps, then lowest total time
  standings.sort((a, b) => b.laps - a.laps || a.totalTime - b.totalTime);

  // Table header
  let html=`<table style="width:100%;text-align:center;"><thead><tr><th>#</th><th>Driver</th><th>Laps</th><th>Total</th><th>Last Lap</th><th>Gap</th></tr></thead><tbody>`;
  
  // Table body
  let prevLaps=null, prevTime=null;
  standings.forEach((s,idx)=>{
    const driver = drivers[s.tp] || {};
    const name = driver.name || s.tp;
    let gap = "-";
    if (idx > 0) {
      if (s.laps < prevLaps) {
        gap = `${prevLaps - s.laps} lap(s)`;
      } else {
        gap = `${(s.totalTime - prevTime).toFixed(3)} s`;
      }
    }
    prevLaps = s.laps;
    prevTime = s.totalTime;

    // Style for last lap: green if best for driver (excluding lap 0), purple if best overall
    let lastLapStyle = "";
    if (s.laps > 1 && s.lastLap !== null) {
      if (Number(s.lastLap) === Number(s.bestLap)) {
        lastLapStyle = "font-weight:bold;color:green;";
      }
      if (overallBest !== null && Number(s.lastLap) === Number(overallBest)) {
        lastLapStyle = "font-weight:bold;color:purple;";
      }
    }

    // Color top3 names gold/silver/bronze
    let rankDisplay = idx + 1;
    let rankStyle = "";
    if (idx === 0) rankStyle = "color:#BBA320;font-weight:bold;"; // Gold
    else if (idx === 1) rankStyle = "color:#6F6F6F;font-weight:bold;"; // Silver
    else if (idx === 2) rankStyle = "color:#9E5810;font-weight:bold;"; // Bronze
    html += `<tr>
      <td style="${rankStyle}">${rankDisplay}</td>
      <td>${name}</td>
      <td>${s.laps}</td>
      <td>${formatLapTime(s.totalTime)}</td>
      <td style="${lastLapStyle}">${s.lastLap !== null ? Number(s.lastLap).toFixed(3) : ""}</td>
      <td>${gap}</td>
    </tr>`;
  });
  html += `</tbody></table>`;

  resultsDiv.innerHTML = html;
}

// ── Routing / navigation ───────────────────────────────────────────────────────
function onModeChange(mode) {
  const lapsTable          = byId("laps");
  const driverLapsDiv      = byId("driverLaps");
  const driverSelectWrapper = byId("driverSelectWrapper");
  const displayBarBottom   = document.querySelector(".display-bar-bottom");
  const bestLapDiv         = byId("bestLapDiv");
  const raceControls       = byId("raceControls");
  const classFilterWrapper = byId("classFilterWrapper");
  const exportBtns         = byId("exportButtons");

  if(exportBtns) exportBtns.style.display = (mode==="leaderboard") ? "" : "none";

  if (mode==="all") {
    lapsTable.style.display=""; driverLapsDiv.style.display="none";
    driverSelectWrapper.style.display="none"; displayBarBottom.style.display="";
    bestLapDiv.style.display=""; classFilterWrapper.style.display="none";
    if(raceControls) raceControls.style.display="none";
    showAllLaps();
  } else if (mode==="driver") {
    lapsTable.style.display="none"; driverLapsDiv.style.display="";
    driverSelectWrapper.style.display=""; displayBarBottom.style.display="";
    bestLapDiv.style.display="none"; classFilterWrapper.style.display="none";
    if(raceControls) raceControls.style.display="none";
    showDriverLaps();
  } else if (mode==="leaderboard") {
    lapsTable.style.display=""; driverLapsDiv.style.display="none";
    driverSelectWrapper.style.display="none"; displayBarBottom.style.display="none";
    bestLapDiv.style.display="none"; classFilterWrapper.style.display="";
    if(raceControls) raceControls.style.display="none";
    showLeaderboard();
  } else if (mode==="race") {
    lapsTable.style.display="none"; driverLapsDiv.style.display="none";
    driverSelectWrapper.style.display="none"; displayBarBottom.style.display="none";
    bestLapDiv.style.display="none"; classFilterWrapper.style.display="none";
    if(raceControls) showRaceMode();
  }
}

function setMode(mode) {
  if(raceActive && mode!=="race") raceActive=false;
  currentMode=mode;
  voiceLastLapByDriver = {};
  document.querySelectorAll(".mode-btn").forEach(b=>b.classList.remove("active"));
  if(mode!=="driver") {
    try {
      const url=new URL(window.location.href);
      url.searchParams.delete("tp"); url.searchParams.delete("transponder");
      window.history.replaceState({},"",url);
    } catch(e) {}
  }
  if(mode==="all") {byId("modeAllBtn").classList.add("active");startAutoRefresh();}
  if(mode==="driver") {byId("modeDriverBtn").classList.add("active");startAutoRefresh();}
  if(mode==="leaderboard") {byId("modeLeaderboardBtn").classList.add("active");startAutoRefresh();}
  if(mode==="race") {byId("modeRaceBtn").classList.add("active");stopAutoRefresh();}
  onModeChange(mode);
}

async function onTimeFilterChange() { onModeChange(currentMode); }

// ── Auto-refresh ──────────────────────────────────────────────────────────────
function startAutoRefresh() {
  if(refreshInterval) return;
  const rate = voiceEnabled ? 1000 : 5000;
  refreshInterval=setInterval(async()=>{
    await loadDrivers();
    onModeChange(currentMode);
  }, rate);
}
function stopAutoRefresh() {
  if(!refreshInterval) return;
  clearInterval(refreshInterval);
  refreshInterval=null;
}

// ── Sesion notes (localStorage) ──────────────────────────────────────────
function getSessionNoteKey(tp, sid) { return `sessionnote:${encodeURIComponent(tp)}_${encodeURIComponent(sid)}`; }
function loadSessionNote(tp, sid) { try { return localStorage.getItem(getSessionNoteKey(tp,sid))||""; } catch(e) { return ""; } }
function saveSessionNote(tp, sid, text) { try { localStorage.setItem(getSessionNoteKey(tp,sid),text||""); } catch(e) {} }

// ── Export CSV ────────────────────────────────────────────────────────────────
// Export a CSV file
function exportCSV(filename) {
  fetch(filename).then(r=>{if(!r.ok) throw new Error(); return r.text();})
    .then(text=>{
      const blob=new Blob([text],{type:"text/csv"});
      const link=document.createElement("a");
      link.href=URL.createObjectURL(blob);
      link.download=filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }).catch(()=>alert("Could not export "+filename));
}

// Export filtered laps.csv and sessions.csv for selected driver
async function exportSelectedDriverData() {
  const tp = byId("driverSelect").value;
  if(!tp) return alert("No driver selected!");
  try {
    const {start,end}=getSelectedDateRange();
    const fmtDateForFilename = d=>d?d.replace(/-/g,""):"all";
    const filename=`sessions_${tp}_${fmtDateForFilename(start)}_${fmtDateForFilename(end)}.csv`;
    // Build CSV
    const entries=Object.entries(sessionStats||{});
    if(!entries.length) return alert("No sessions found for the selected driver / date range.");
    const rows=[["Session_id","Timestamp","LapCount","Fastest","Average","3Best","5Min","Notes"]];
    for(const [sessionId,stats] of entries) {
      rows.push([
        sessionId,
        (stats.timestamp||"").replace(/T/," ").replace(/Z$/,""),
        stats.lapCount||0,
        stats.fastest!==null?Number(stats.fastest).toFixed(3):"",
        stats.average!==null?Number(stats.average).toFixed(3):"",
        stats.best3!==null?Number(stats.best3).toFixed(3):"N/A",
        stats.best5Text||"N/A",
        (stats.notes||loadSessionNote(tp,sessionId)||"").replace(/\n/g," ")
      ]);
    }
    const csv=rows.map(r=>r.join(",")).join("\r\n");
    const blob=new Blob([csv],{type:"text/csv"});
    const link=document.createElement("a");
    link.href=URL.createObjectURL(blob);
    link.download=filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } catch(err) { alert("Error exporting data: "+err.message); }
}

//Notes clear helper
async function clearAllSessionNotes(confirmBefore=true) {
  try {
    if(confirmBefore&&!confirm("Erase all saved session notes? This cannot be undone.")) return 0;
    const n=localStorage.length;
    localStorage.clear();
    alert(`Cleared ${n} session note(s).`); return n;
  } catch(e) { alert("Could not clear notes: "+(e?.message||e)); return 0; }
}

// ── Initialization ────────────────────────────────────────────────────────────
async function init() {
  const today = formatDate(new Date());
  byId("startDate").value = today;
  byId("endDate").value   = today;
  await loadDrivers();
  await populateDriverSelect();
  populateClassFilter();
  // If URL has ?tp=... (or ?transponder=...), auto-select that driver and switch to driver mode
  (function applyUrlDriverParam() {
    const params = new URLSearchParams(window.location.search);
    const tpParam = params.get("tp") || params.get("transponder");
    if (!tpParam) return;
    const select = byId("driverSelect");
    if (!select) return;
    // If transponder not present in options yet, add it so user can select/bookmark even before drivers.csv matches
    if (![...select.options].some(o=>o.value===tpParam)) {
      const opt=document.createElement("option");
      opt.value=tpParam;
      opt.textContent=tpParam;
      select.appendChild(opt);
    }
    select.value = tpParam;
    setMode("driver");
  })();
  const classSel = byId("classFilter");
  if(classSel) {
    classSel.addEventListener("change",()=>{
      if(currentMode==="leaderboard") showLeaderboard();
    });
  }
  startAutoRefresh();
  onModeChange(currentMode);
}

window.onload = init;
