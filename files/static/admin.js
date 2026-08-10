// ═══════════════════════════════════════════════════════════════════════════════
// TrackTiming — admin.js
// ═══════════════════════════════════════════════════════════════════════════════


// ── Global state ───────────────────────────────────────────────────────────────
const ADMIN_PASSWORD = "admin"; // admin password
let DRIVER_CLASSES = [];
let recentMsgInterval = null;


// ── Left Row (open access items + admin driver/lap edit) ───────────────────────
// Quick add driver form
function populateQuickAddDriver() {
  // Find transponders in laps not in drivers (unregistered)
  Promise.all([
    fetch("/api/laps").then(r=>r.json()),
    fetch("/api/drivers").then(r=>r.json())
  ]).then(([lapsData, driversArr])=>{
    const lapIds = new Set((lapsData.laps||[]).map(l=>l.transponder).filter(Boolean));
    const driverIds = new Set(driversArr.map(d=>d.id));
    const unregistered = Array.from(lapIds).filter(id=>!driverIds.has(id));
    let html = '<option value="">Transponder ID</option>';
    unregistered.forEach(id=>{ html += `<option value="${id}">${id}</option>`; });
    byId("quickDriverId").innerHTML = html;
    byId("quickDriverId").disabled = unregistered.length === 0;
  });
  populateClassDropdown(byId("quickDriverClass"));
}
byId("quickAddDriverForm").onsubmit = function(e) {
  e.preventDefault();
  const id = byId("quickDriverId").value;
  const name = byId("quickDriverName").value.trim();
  const cls = byId("quickDriverClass").value.trim();
  if (!id) return msg("quickAddMsg", "Select your transponder!");
  if (!name) return msg("quickAddMsg", "Enter your name!");
  fetch("/api/drivers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, name, class: cls })
  }).then(()=>{
    msg("quickAddMsg","Driver registered!");
    populateQuickAddDriver();
    populateLapDriverFilter();
    loadDrivers();
    byId("quickAddDriverForm").reset();
  });
};

// Recent decoder messages
function startRecentMessages() {
  fetchRecentMessages();
  if (!recentMsgInterval) recentMsgInterval = setInterval(fetchRecentMessages, 2000);
}
function stopRecentMessages() {
  if (recentMsgInterval) { clearInterval(recentMsgInterval); recentMsgInterval = null; }
}
function fetchRecentMessages() {
  fetch("/api/recentMessages").then(r=>r.json()).then(msgs=>{
    const container = byId("recentMsgsContainer");
    if (!container) return;
    if (!msgs.length) { container.innerHTML = "<i>No messages received yet.</i>"; return; }
    container.innerHTML = msgs.map(m =>
      `<div style="font-family:monospace;font-size:.8em;padding:2px 0;border-bottom:1px solid #eee;">
        <span style="color:#888;">${m.time}</span> ${m.raw}
      </div>`
    ).join("");
  }).catch(()=>{});
}

// Driver edit + delete
function loadDrivers() {
  fetch("/api/drivers").then(r=>r.json()).then(arr=>{
    let html = `<div class="driver-controls">
      <label for="editDriverSelect" class="visually-hidden">Select Driver</label>
      <select id="editDriverSelect" class="admin-only"><option value="">-</option>`;
    arr.forEach(d=>{
      const id = d.id || "", name = d.name || "", cls = d.class || "";
      html += `<option value="${id}" data-name="${encodeURIComponent(name)}" data-class="${cls}">${name} (${id})</option>`;
    });
    html += `</select>
      <button id="editDriverBtn" class="admin-only" disabled>Edit</button>
      <button id="deleteDriverBtn" class="admin-only" disabled>Delete</button>
    </div>
    <div id="driversMsg"></div>`;
    byId("driversList").innerHTML = html;
    const select = byId("editDriverSelect");
    const editBtn = byId("editDriverBtn");
    const delBtn = byId("deleteDriverBtn");
    if (select) {
      select.onchange = function() {
        const selected = select.value;
        editBtn.disabled = !selected;
        delBtn.disabled = !selected;
      };
    }
    if (editBtn) editBtn.onclick = function(){
      const selected = select.value;
      if (!selected) return;
      const opt = select.options[select.selectedIndex];
      const name = decodeURIComponent(opt.getAttribute("data-name"));
      const existingClass = opt.getAttribute("data-class") || "";
      // Driver Editor Box
      const editor = document.createElement("div");
      editor.style = "position:fixed;top:0;left:0;width:100vw;height:100vh;background:#0005;z-index:9999;display:flex;align-items:center;justify-content:center;";
      editor.innerHTML = `
        <div style="background:#fff;padding:20px 30px;border-radius:8px;box-shadow:0 2px 8px #0003;min-width:220px;display:flex;flex-direction:column;align-items:center;gap:8px;">
          <input id="editDriverName" type="text" style="width:90%;padding:8px;" />
          <select id="editDriverClassSelect" style="width:90%;padding:8px;"></select>
          <div style="display:flex;gap:8px;justify-content:center;width:100%;margin-top:6px;">
            <button id="editClassOk">Save</button>
            <button id="editClassCancel">Cancel</button>
          </div>
        </div>
      `;
      document.body.appendChild(editor);
      // Populate fields
      byId("editDriverName").value = name;
      populateClassDropdown(byId("editDriverClassSelect"), existingClass);
      byId("editClassOk").onclick = function() {
        const newName = byId("editDriverName").value.trim();
        const newClass = byId("editDriverClassSelect").value;
        document.body.removeChild(editor);
        fetch("/api/drivers", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: selected, name: newName, class: newClass })
        }).then(()=>{ msg("driversMsg","Driver updated!"); loadDrivers(); });
      };
      byId("editClassCancel").onclick = function() {
        document.body.removeChild(editor);
      };
    };
    if (delBtn) delBtn.onclick = function(){
      const sel = byId("editDriverSelect");
      if (!sel || !sel.value) return msg("driversMsg","Select a driver");
      if (!confirm("Delete driver?")) return;
      fetch("/api/drivers", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: sel.value })
      })
      .then(async resp => {
        if (!resp.ok) {
          const txt = await resp.text().catch(()=>"");
          throw new Error(txt || resp.statusText);
        }
        msg("driversMsg","Deleted");
        loadDrivers();
        populateQuickAddDriver();
      })
      .catch(err => {
        console.error(err);
        msg("driversMsg","Error deleting driver");
      });
    };
  });
}

// Lap delete
function deleteAllLaps() {
  const sel = byId("lapDriverFilter");
  const tp = sel ? sel.value : "";
  const display = (sel && sel.selectedIndex >= 0) ? sel.options[sel.selectedIndex].text : tp;
  const confirmMsg = tp ? `Delete all laps for ${display} ?` : "Delete all laps?";
  if (!confirm(confirmMsg)) return;
  const url = tp ? `/api/laps?tp=${encodeURIComponent(tp)}` : `/api/laps`;
  fetch(url, { method: "DELETE" })
    .then(async resp => {
      if (!resp.ok) {
        const txt = await resp.text().catch(()=>"");
        throw new Error(txt || resp.statusText);
      }
      // refresh UI
      populateLapDriverFilter();
      showLapsTable();
      msg("lapsMsg", tp ? `Deleted laps for ${display}` : "All laps deleted!");
    })
    .catch(err => {
      console.error(err);
      msg("lapsMsg", "Error deleting laps");
    });
}
function deleteLapRow(row) {
  if (!confirm(`Delete lap row ${row} ?`)) return;
  fetch(`/api/laps?row=${row}`, { method: "DELETE" })
    .then(async resp => {
      if (!resp.ok) {
        const txt = await resp.text().catch(()=>"");
        throw new Error(txt || resp.statusText);
      }
      showLapsTable();
      msg("lapsMsg", `Lap ${row} deleted!`);
    })
    .catch(err => {
      console.error(err);
      msg("lapsMsg", "Error deleting lap row");
    });
}
function showLapsTable() {
  Promise.all([
    fetch("/api/laps").then(r=>r.json()),
    fetch("/api/sessions").then(r=>r.json())
  ]).then(([lapsData, sessionsData])=>{
    const lapRows = lapsData.laps || [];
    if (!lapRows.length) { byId("lapsTableContainer").innerHTML = ""; return; }
    // Build session map keyed by "transponder_sessionid" -> timestamp string
    const sessMap = {};
    (sessionsData.sessions || []).forEach(s=>{
      if (s.transponder && s.sessionid) sessMap[`${s.transponder}_${s.sessionid}`] = s.timestamp;
    });
    const driverId = byId("lapDriverFilter").value;
    if (!driverId) { byId("lapsTableContainer").innerHTML = ""; return; }
    const filtered = lapRows
      .filter(r => r.transponder === driverId)
      .reverse(); // show newest first
    let html = `<table><thead><tr><th>#</th><th>Date</th><th>Session</th><th>Lap Time</th><th>Del.</th></tr></thead><tbody>`;
    filtered.forEach(r => {
      const sid = r.sessionid;
      let dateStr = "";
      const ts = sessMap[`${r.transponder}_${sid}`];
      if (ts) {
        const datePart = ts.split(" ")[0];
        if (datePart) {
          const [yyyy, mm, dd] = datePart.split("-");
          if (dd && mm && yyyy) dateStr = `${dd}/${mm}/${yyyy}`;
        }
      }
      const timeDisplay = isFinite(Number(r.laptime)) ? Number(r.laptime).toFixed(3) : r.laptime;
      html += `<tr><td>${r.id}</td><td>${dateStr}</td><td>${sid}</td><td>${timeDisplay}</td><td><button onclick="deleteLapRow(${r.id})">X</button></td></tr>`;
    });
    html += "</tbody></table>";
    byId("lapsTableContainer").innerHTML = html;
    byId("lapsTableContainer").style.display = "";
  }).catch(err=>{
    console.error(err);
    byId("lapsTableContainer").innerHTML = "Error loading laps/sessions";
  });
}


// ── Right row (admin only items) ──────────────────────────────────
// Laptime thresholds
function loadThresholds() {
  fetch("/api/thresholds").then(r=>r.json()).then(d=>{
    byId("minLap").value = d.min; byId("maxLap").value = d.max;
  });
}
function saveThresholds() {
  fetch("/api/thresholds", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ min: +byId("minLap").value, max: +byId("maxLap").value })
  }).then(()=>msg("saveMsg","Saved!"));
}

// RTL-SDR gain
function loadGain() {
  fetch("/api/gain").then(r=>r.json()).then(d=>{
    const slider = byId("gainSlider");
    const label  = byId("gainValue");
    if (slider) slider.value = d.gain;
    if (label)  label.textContent = d.gain + " dB";
  });
}
function onGainInput() {
  const v = byId("gainSlider").value;
  byId("gainValue").textContent = v + " dB";
}
function saveGain() {
  const gain = parseInt(byId("gainSlider").value);
  byId("gainMsg").textContent = "Applying…";
  fetch("/api/gain", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gain })
  }).then(r=>r.json()).then(d=>{
    const txt = d.warning ? `Saved (${d.warning})` : `Gain set to ${d.gain} dB — openstint restarting…`;
    msg("gainMsg", txt, 4000);
  }).catch(()=>msg("gainMsg","Error"));
}

// RC4 TX learning
function loadTxLearnList() {
  fetch("/txlearn.csv").then(r=>r.text()).then(t=>{
    const l = t.trim().split("\n").slice(1);
    let html = '<option value="">Learned ID</option>';
    l.forEach(line => {
      const parts = line.split(",");
      const id = parts[0];
      if (id && id.length === 4) html += `<option value="${id}">${id}</option>`;
    });
    byId("txlearnSelect").innerHTML = html;
  });
}
function txLearn() {
  const oldId = byId("txlearnSelect").value;
  const newId = byId("txlearnId").value;
  if (!oldId || oldId.length !== 4) return msg("learnMsg", "Select a 4-digit transponder!");
  if (newId.length !== 7) return msg("learnMsg", "New ID must be 7 digits!");
  fetch("/api/txlearn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ old_id: oldId, new_id: newId })
  })
  .then(async resp => {
    if (!resp.ok) {
      const txt = await resp.text().catch(()=>"");
      throw new Error(txt || resp.statusText);
    }
    msg("learnMsg","Renamed and cleaned up.");
    loadTxLearnList();
    populateQuickAddDriver();
    loadDrivers();
  })
  .catch(err => {
    msg("learnMsg", err.message || "Error");
  });
}

// Set RTC to current time
function setRtcNow() {
  const d = new Date();
  // Format: YYYY-MM-DDTHH:MM:SS (local time)
  const iso = d.getFullYear() + '-' +
    String(d.getMonth()+1).padStart(2,'0') + '-' +
    String(d.getDate()).padStart(2,'0') + 'T' +
    String(d.getHours()).padStart(2,'0') + ':' +
    String(d.getMinutes()).padStart(2,'0') + ':' +
    String(d.getSeconds()).padStart(2,'0');
  fetch("/api/rtc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ time: iso })
  }).then(()=>msg("rtcMsg","RTC updated!"));
}

// Classes manager
async function renderClassManager() {
  const select  = byId("editClassSelect");
  const editBtn = byId("editClassBtn");
  const delBtn  = byId("deleteClassBtn");
  const addBtn  = byId("addClassBtn");
  if (!select || !editBtn || !delBtn || !addBtn) return;
  // Fill select with current classes
  let options = '<option value="">-</option>';
  DRIVER_CLASSES.forEach(name => {
    options += `<option value="${name}">${name}</option>`;
  });
  select.innerHTML = options;
  select.value = "";
  editBtn.disabled = true;
  delBtn.disabled  = true;
  select.onchange = () => {
    const has = !!select.value;
    editBtn.disabled = !has;
    delBtn.disabled  = !has;
  };
  // Add class
  addBtn.onclick = async () => {
    const name = byId("newClassName").value.trim();
    if (!name) return msg("classMsg", "Enter a class name!");
    const resp = await fetch("/api/classes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    });
    if (resp.status === 409) return msg("classMsg", "Class already exists.");
    if (!resp.ok)            return msg("classMsg", "Error adding class.");
    byId("newClassName").value = "";
    msg("classMsg", `"${name}" added!`);
    await _refreshClasses();
    select.value = name;
    select.dispatchEvent(new Event("change"));
  };
  // Edit class
  editBtn.onclick = () => {
    const oldName = select.value;
    if (!oldName) return;
    //Class editor box
    const editor = document.createElement("div");
    editor.style = "position:fixed;top:0;left:0;width:100vw;height:100vh;background:#0005;z-index:9999;display:flex;align-items:center;justify-content:center;";
    editor.innerHTML = `
      <div style="background:#fff;padding:20px 30px;border-radius:8px;box-shadow:0 2px 8px #0003;min-width:220px;display:flex;flex-direction:column;align-items:center;gap:8px;">
        <input id="editClassName" type="text" style="width:90%;padding:8px;" maxlength="30" />
        <div style="display:flex;gap:8px;justify-content:center;width:100%;margin-top:6px;">
          <button id="editClassOk">Save</button>
          <button id="editClassCancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(editor);
    byId("editClassName").value = oldName;
    byId("editClassName").select();
    byId("editClassName").focus();
    byId("editClassCancel").onclick = () => document.body.removeChild(editor);
    byId("editClassOk").onclick = async () => {
      const newName = byId("editClassName").value.trim();
      if (!newName || newName === oldName) { document.body.removeChild(editor); return; }
      const resp = await fetch("/api/classes", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ old_name: oldName, new_name: newName })
      });
      document.body.removeChild(editor);
      if (resp.status === 409) return msg("classMsg", "Class already exists.");
      if (!resp.ok)            return msg("classMsg", "Error renaming class.");
      const data = await resp.json();
      const note = data.updated_drivers > 0 ? ` (${data.updated_drivers} driver(s) updated)` : "";
      msg("classMsg", `Renamed to "${newName}"${note}.`, 3000);
      await _refreshClasses();
      select.value = newName;
      select.dispatchEvent(new Event("change"));
    };
  };
  // Delete class
  delBtn.onclick = async () => {
    const name = select.value;
    if (!name) return;
    if (!confirm(`Delete class "${name}"?\nAffected drivers will have no class.`)) return;
    const resp = await fetch("/api/classes", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    });
    if (!resp.ok) return msg("classMsg", "Error deleting class.");
    const data = await resp.json();
    const note = data.affected_drivers > 0 ? ` (${data.affected_drivers} driver(s) affected)` : "";
    msg("classMsg", `"${name}" deleted${note}.`, 3000);
    await _refreshClasses();
  };
}


// ── Helper functions ──────────────────────────────────────────────────────────
// Admin login
async function login() {
  if (byId("pw").value === ADMIN_PASSWORD) {
    document.body.classList.add("is-admin");

    const loginWrap = byId("adminLoginWrapper");
    if (loginWrap) loginWrap.style.display = "none";

    const lapFilter = byId("lapDriverFilter");
    if (lapFilter) {
      lapFilter.value = "";
      lapFilter.onchange = showLapsTable;
    }
    await loadClasses();
    loadThresholds();
    loadGain();
    populateLapDriverFilter();
    showLapsTable();
    loadDrivers();
    await renderClassManager();
  } else msg("loginMsg", "Wrong password");
}
// Load classes from server
async function loadClasses() {
  try {
    const r = await fetch("/api/classes");
    if (!r.ok) throw new Error("Failed to load classes");
    const arr = await r.json();
    DRIVER_CLASSES = arr.map(c => c.name);
  } catch(e) {
    console.error("Error loading classes:", e);
  }
}
// Get element by ID
function byId(id) { return document.getElementById(id); }
// Show a temporary message in an element
function msg(id, txt, t=1500) { byId(id).innerText = txt; setTimeout(()=>byId(id).innerText="",t); }
// Class dropdown population
function populateClassDropdown(sel, selected) {
  sel.innerHTML = '<option value="">Select class</option>' +
    DRIVER_CLASSES.map(c => `<option value="${c}"${c===selected?" selected":""}>${c}</option>`).join('');
}
// Driver laps population
function populateLapDriverFilter() {
  Promise.all([
    fetch("/api/laps").then(r=>r.json()),
    fetch("/api/drivers").then(r=>r.json())
  ]).then(([lapsData, driversArr])=>{
    const ids = new Set((lapsData.laps||[]).map(l=>l.transponder).filter(Boolean));
    const driverMap = {};
    driversArr.forEach(d=>{ driverMap[d.id] = d.name; });
    let html = '<option value="">-</option>';
    Array.from(ids).sort().forEach(id=>{
      const name = driverMap[id] ? `${driverMap[id]} (${id})` : id;
      html += `<option value="${id}">${name}</option>`;
    });
    byId("lapDriverFilter").innerHTML = html;
  });
}
// Refresh DRIVER_CLASSES and dropdowns
async function _refreshClasses() {
  await loadClasses();
  await renderClassManager();
  populateQuickAddDriver();
  loadDrivers();
}

// ── Initialization ────────────────────────────────────────────────────────────
async function init() {
  const loginForm = byId("loginForm");
  if (loginForm) {
    loginForm.onsubmit = function(e) { e.preventDefault(); login(); };
  }
  await loadClasses();
  populateQuickAddDriver();
  loadTxLearnList();
  startRecentMessages();
};

window.onload = init;
