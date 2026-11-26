/**
 * GEO ATTENDANCE – Google Sheet backend (Google Apps Script)
 * ----------------------------------------------------------
 * Receives clock-in / clock-out events from the phone app and writes them
 * to this Google Sheet.
 *
 * Tabs created by setup():
 *   Settings   – access code, grace period, max shift length
 *   Sites      – workplaces + radius (the app downloads these)
 *   Staff      – everyone who has registered on the app (untick "Allowed" to block)
 *   Attendance – one row per shift (clock in / clock out / hours)
 *   Log        – every raw event received, for checking and disputes
 *
 * After pasting this file: run setup() once, fill in Sites + Settings,
 * then Deploy > New deployment > Web app (Execute as: Me, Access: Anyone).
 */

var TABS = {
  SETTINGS: 'Settings',
  SITES: 'Sites',
  STAFF: 'Staff',
  ATTENDANCE: 'Attendance',
  LOG: 'Log'
};

var HEADERS = {
  Settings: ['Setting', 'Value', 'What it does'],
  Sites: ['Site Name', 'Latitude', 'Longitude', 'Radius (m)', 'Active'],
  Staff: ['Staff ID', 'Name', 'Allowed', 'Platform', 'Registered', 'Last Seen', 'Status', 'Current Site'],
  Attendance: ['Date', 'Staff ID', 'Name', 'Site', 'Clock In', 'Clock Out', 'Hours', 'In Method', 'Out Method', 'Status', 'Note'],
  Log: ['Received', 'Event Time', 'Staff ID', 'Name', 'Event', 'Site', 'Latitude', 'Longitude', 'Accuracy (m)', 'Source', 'Result']
};

// Attendance column numbers (1-based)
var A = { DATE: 1, ID: 2, NAME: 3, SITE: 4, IN: 5, OUT: 6, HOURS: 7, IN_M: 8, OUT_M: 9, STATUS: 10, NOTE: 11 };

/* ======================= ONE-TIME SETUP ======================= */

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone('Asia/Singapore');

  Object.keys(HEADERS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var h = HEADERS[name];
    sh.getRange(1, 1, 1, h.length).setValues([h])
      .setFontWeight('bold').setBackground('#1f2937').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  });

  var settings = ss.getSheetByName(TABS.SETTINGS);
  if (settings.getLastRow() < 2) {
    settings.getRange(2, 1, 3, 3).setValues([
      ['ACCESS_CODE', 'CHANGE-ME', 'Code staff type into the app when they register. Change it to block old installs.'],
      ['GRACE_MINUTES', 10, 'If someone leaves and comes back within this many minutes, the same shift continues (stops GPS jitter splitting shifts).'],
      ['MAX_SHIFT_HOURS', 16, 'A shift still open after this many hours is marked MISSING OUT when the person next clocks in.']
    ]);
  }

  var sites = ss.getSheetByName(TABS.SITES);
  if (sites.getLastRow() < 2) {
    sites.getRange(2, 1, 1, 5).setValues([['Main Workplace', 1.3521, 103.8198, 500, true]]);
    sites.getRange('E2:E').insertCheckboxes();
  }

  ss.getSheetByName(TABS.STAFF).getRange('C2:C').insertCheckboxes();
  ss.getSheetByName(TABS.ATTENDANCE).getRange('A2:A').setNumberFormat('dd/MM/yyyy');
  ss.getSheetByName(TABS.ATTENDANCE).getRange('E2:F').setNumberFormat('dd/MM/yyyy HH:mm');
  ss.getSheetByName(TABS.ATTENDANCE).getRange('G2:G').setNumberFormat('0.00');
  ss.getSheetByName(TABS.LOG).getRange('A2:B').setNumberFormat('dd/MM/yyyy HH:mm:ss');
  ss.getSheetByName(TABS.STAFF).getRange('E2:F').setNumberFormat('dd/MM/yyyy HH:mm');

  var def = ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1 && def.getLastRow() === 0) ss.deleteSheet(def);

  SpreadsheetApp.getUi().alert('Setup done. Now fill in the Sites tab and change ACCESS_CODE in Settings, then deploy as a Web app.');
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Attendance')
    .addItem('Run setup (create tabs)', 'setup')
    .addToUi();
}

/* ======================= WEB ENDPOINTS ======================= */

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    checkCode_(p.code);
    if (p.action === 'config') return json_({ ok: true, sites: getSites_(), graceMinutes: num_(getSetting_('GRACE_MINUTES'), 10) });
    if (p.action === 'status') return json_(Object.assign({ ok: true }, getStatus_(String(p.staffId || '').trim())));
    return json_({ ok: true, message: 'Geo Attendance backend is running.' });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    checkCode_(body.code);

    var staffId = String(body.staffId || '').trim().toUpperCase();
    var name = String(body.name || '').trim();
    if (!staffId || !name) throw new Error('Staff ID and name are required.');

    lock.waitLock(20000);
    var allowed = upsertStaff_(staffId, name, body.platform);
    if (!allowed) throw new Error('Your account has been blocked. Please contact your supervisor.');

    if (body.action === 'register') {
      return json_(Object.assign({ ok: true, sites: getSites_() }, getStatus_(staffId)));
    }

    if (body.action === 'events') {
      var events = (body.events || []).slice().sort(function (a, b) {
        return new Date(a.time) - new Date(b.time);
      });
      var results = events.map(function (ev) {
        return { id: ev.id, result: processEvent_(staffId, name, ev) };
      });
      SpreadsheetApp.flush();
      return json_(Object.assign({ ok: true, results: results }, getStatus_(staffId)));
    }

    throw new Error('Unknown action.');
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (x) {}
  }
}

/* ======================= CORE LOGIC ======================= */

/**
 * ev = { id, type: 'ENTER'|'EXIT', site, time (ISO), lat, lng, acc, source: 'auto'|'manual'|'startup' }
 */
function processEvent_(staffId, name, ev) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(TABS.ATTENDANCE);
  var now = new Date();
  var t = safeTime_(ev.time, now);
  var site = String(ev.site || '').trim();
  var method = ev.source === 'manual' ? 'Manual' : 'Auto';
  var grace = num_(getSetting_('GRACE_MINUTES'), 10) * 60000;
  var maxShift = num_(getSetting_('MAX_SHIFT_HOURS'), 16) * 3600000;
  var result;

  var open = findRow_(sh, staffId, 'OPEN');

  if (ev.type === 'ENTER') {
    if (open && (t - open.values[A.IN - 1]) > maxShift) {
      // Old shift never got a clock-out (phone off / app killed)
      sh.getRange(open.row, A.STATUS).setValue('MISSING OUT');
      sh.getRange(open.row, A.NOTE).setValue('No clock-out received. Please check with the staff.');
      open = null;
    }

    if (open) {
      result = 'Already clocked in at ' + open.values[A.SITE - 1];
    } else {
      var last = findRow_(sh, staffId, 'CLOSED');
      var lastOut = last && last.values[A.OUT - 1];
      if (last && lastOut instanceof Date && last.values[A.SITE - 1] === site &&
          t >= lastOut && (t - lastOut) <= grace) {
        // Came back within the grace period: carry on the same shift
        sh.getRange(last.row, A.OUT, 1, 3).setValues([['', '', '']]);
        sh.getRange(last.row, A.STATUS).setValue('OPEN');
        appendNote_(sh, last.row, 'Left ' + fmt_(lastOut) + ', back ' + fmt_(t) + ' (within grace).');
        result = 'Back within grace period, shift continued';
      } else {
        sh.appendRow([dateOnly_(t), staffId, name, site, t, '', '', method, '', 'OPEN', '']);
        result = 'Clocked in';
      }
    }
    setStaffStatus_(staffId, 'IN', site);

  } else if (ev.type === 'EXIT') {
    if (!open) {
      result = 'Ignored, not clocked in';
    } else if (method === 'Auto' && site && open.values[A.SITE - 1] !== site) {
      result = 'Ignored, exit from ' + site + ' but clocked in at ' + open.values[A.SITE - 1];
    } else {
      var tin = open.values[A.IN - 1];
      var hours = Math.max(0, Math.round(((t - tin) / 3600000) * 100) / 100);
      sh.getRange(open.row, A.OUT, 1, 3).setValues([[t, hours, method]]);
      sh.getRange(open.row, A.STATUS).setValue('CLOSED');
      result = 'Clocked out (' + hours + ' h)';
      setStaffStatus_(staffId, 'OUT', '');
    }
  } else {
    result = 'Ignored, unknown event type';
  }

  ss.getSheetByName(TABS.LOG).appendRow([
    now, t, staffId, name, ev.type, site,
    ev.lat || '', ev.lng || '', ev.acc ? Math.round(ev.acc) : '', ev.source || '', result
  ]);
  return result;
}

function getStatus_(staffId) {
  if (!staffId) return { status: 'OUT' };
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.ATTENDANCE);
  var open = findRow_(sh, staffId, 'OPEN');
  if (!open) return { status: 'OUT' };
  return { status: 'IN', site: open.values[A.SITE - 1], clockIn: open.values[A.IN - 1].toISOString() };
}

/* ======================= HELPERS ======================= */

/** Finds the most recent Attendance row for this staff with the given status. */
function findRow_(sh, staffId, status) {
  var last = sh.getLastRow();
  if (last < 2) return null;
  var start = Math.max(2, last - 5000); // only look at recent rows for speed
  var values = sh.getRange(start, 1, last - start + 1, HEADERS.Attendance.length).getValues();
  for (var i = values.length - 1; i >= 0; i--) {
    if (String(values[i][A.ID - 1]).toUpperCase() === staffId && values[i][A.STATUS - 1] === status) {
      return { row: start + i, values: values[i] };
    }
  }
  return null;
}

function upsertStaff_(staffId, name, platform) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.STAFF);
  var last = sh.getLastRow();
  var now = new Date();
  if (last >= 2) {
    var ids = sh.getRange(2, 1, last - 1, 3).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i][0]).toUpperCase() === staffId) {
        sh.getRange(i + 2, 2).setValue(name);
        sh.getRange(i + 2, 4).setValue(platform || '');
        sh.getRange(i + 2, 6).setValue(now);
        return ids[i][2] !== false;
      }
    }
  }
  sh.appendRow([staffId, name, true, platform || '', now, now, 'OUT', '']);
  sh.getRange(sh.getLastRow(), 3).insertCheckboxes().setValue(true);
  return true;
}

function setStaffStatus_(staffId, status, site) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.STAFF);
  var last = sh.getLastRow();
  if (last < 2) return;
  var ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).toUpperCase() === staffId) {
      sh.getRange(i + 2, 7, 1, 2).setValues([[status, site]]);
      return;
    }
  }
}

function getSites_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.SITES);
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, 5).getValues()
    .filter(function (r) { return r[0] && r[4] !== false && r[1] !== '' && r[2] !== ''; })
    .map(function (r) {
      return { name: String(r[0]).trim(), latitude: Number(r[1]), longitude: Number(r[2]), radius: Number(r[3]) || 500 };
    });
}

function getSetting_(key) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.SETTINGS);
  var last = sh.getLastRow();
  if (last < 2) return '';
  var rows = sh.getRange(2, 1, last - 1, 2).getValues();
  for (var i = 0; i < rows.length; i++) if (rows[i][0] === key) return rows[i][1];
  return '';
}

function checkCode_(code) {
  var expected = String(getSetting_('ACCESS_CODE') || '').trim().toUpperCase();
  if (expected && String(code || '').trim().toUpperCase() !== expected) throw new Error('Wrong access code.');
}

function appendNote_(sh, row, text) {
  var cell = sh.getRange(row, A.NOTE);
  var old = cell.getValue();
  cell.setValue(old ? old + ' | ' + text : text);
}

function safeTime_(iso, now) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return now;
  if (d - now > 5 * 60000) return now;              // device clock in the future
  if (now - d > 7 * 24 * 3600000) return now;       // older than a week: don't trust
  return d;
}

function dateOnly_(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function fmt_(d) { return Utilities.formatDate(d, 'Asia/Singapore', 'HH:mm'); }
function num_(v, def) { var n = Number(v); return isNaN(n) || v === '' ? def : n; }
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
