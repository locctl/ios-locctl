/**
 * ios-locctl — Sheets webhook for in-app bookmark uploads.
 *
 * What this does:
 *   The desktop app sends bookmark changes via POST. This script upserts
 *   rows by lat,lng and can also delete rows, then returns a summary the
 *   app uses to update its UI.
 *
 * Why a Web App instead of OAuth in the desktop app:
 *   The desktop app needs zero credentials this way — the webhook URL itself
 *   acts as the access token. That URL is stored locally in the user's
 *   sheets_config.json and never shared. Anyone with the URL can append rows
 *   (read continues to use the public CSV export), so treat the URL like a
 *   password: don't paste it in screenshots, chat logs, etc.
 *
 * One-time setup (5 minutes):
 *   1. Open your bookmarks Google Sheet.
 *   2. Extensions → Apps Script. (Opens a separate editor tab.)
 *   3. Replace the default Code.gs with this whole file. Save (⌘S).
 *   4. Deploy → New deployment → click the gear icon → Web app.
 *      • Description: anything ("ios-locctl uploads")
 *      • Execute as: Me
 *      • Who has access: Anyone
 *   5. Click Deploy. First time will ask for permissions —
 *      Authorize → pick your Google account → Advanced → Go to (project name)
 *      (unverified-developer warning is normal, this is your own script).
 *   6. Copy the Web app URL it shows you (looks like
 *      https://script.google.com/macros/s/AKfyc.../exec).
 *   7. Paste that URL into the desktop app: book面板 → ⚙ → Webhook URL field.
 *
 * To re-deploy after editing this script:
 *   Deploy → Manage deployments → pencil icon next to your deployment →
 *   Version: New version → Deploy. The URL stays the same.
 */

const BOOKMARKS_TAB = 'bookmarks';
const ROUTES_TAB = 'routes';
const BOOKMARK_COLUMNS = ['name', 'lat', 'lng', 'country', 'category', 'updated_by', 'updated_at', 'note'];
const ROUTE_COLUMNS = ['name', 'waypoints_json', 'updated_by', 'updated_at', 'note'];

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents || '[]');
  } catch (err) {
    return _json({ error: 'invalid JSON: ' + err.message }, 400);
  }

  let upserts = [];
  let deletes = [];
  const resource = body && typeof body === 'object' && body.resource === 'routes' ? 'routes' : 'bookmarks';
  if (Array.isArray(body)) {
    upserts = body;
  } else if (body && typeof body === 'object') {
    if (body.action && !['upsert', 'sync'].includes(body.action)) {
      return _json({ error: `unsupported action: ${body.action}` }, 400);
    }
    upserts = Array.isArray(body.items) ? body.items : Array.isArray(body.upserts) ? body.upserts : [];
    deletes = Array.isArray(body.deletes) ? body.deletes : [];
  } else {
    return _json({ error: 'expected an array of bookmarks or sync payload' }, 400);
  }

  const sheet = SpreadsheetApp.getActive().getSheetByName(resource === 'routes' ? ROUTES_TAB : BOOKMARKS_TAB);
  if (!sheet) {
    return _json({ error: `tab "${resource === 'routes' ? ROUTES_TAB : BOOKMARKS_TAB}" not found in this spreadsheet` }, 404);
  }
  return resource === 'routes'
    ? _handleRoutes(sheet, upserts, deletes)
    : _handleBookmarks(sheet, upserts, deletes);
}

function _handleBookmarks(sheet, upserts, deletes) {
  // Build a coord-key → row index map of existing rows so we can rewrite a
  // matching row in place instead of appending a duplicate. Without this,
  // edits to cloud bookmarks (which keep their lat,lng) would be silently
  // dropped as "duplicates".
  const lastRow = sheet.getLastRow();
  const existing = new Map(); // key → 1-indexed sheet row number
  if (lastRow >= 2) {
    const range = sheet.getRange(2, 2, lastRow - 1, 2).getValues(); // B:C lat,lng
    range.forEach((r, i) => {
      const lat = parseFloat(r[0]);
      const lng = parseFloat(r[1]);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        existing.set(_coordKey(lat, lng), i + 2);
      }
    });
  }

  const added = [];
  const updated = [];
  const deleted = [];
  const skipped = [];

  upserts.forEach((b) => {
    const lat = parseFloat(b.lat);
    const lng = parseFloat(b.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      skipped.push({ name: b.name, reason: 'invalid coord' });
      return;
    }
    const key = _coordKey(lat, lng);
    const row = BOOKMARK_COLUMNS.map((c) => {
      if (c === 'lat') return lat;
      if (c === 'lng') return lng;
      return b[c] || '';
    });
    const existingRow = existing.get(key);
    if (existingRow != null) {
      sheet.getRange(existingRow, 1, 1, BOOKMARK_COLUMNS.length).setValues([row]);
      updated.push({ name: b.name, lat, lng });
    } else {
      sheet.appendRow(row);
      added.push({ name: b.name, lat, lng });
      existing.set(key, sheet.getLastRow());
    }
  });

  deletes.forEach((b) => {
    const lat = parseFloat(b.lat);
    const lng = parseFloat(b.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      skipped.push({ name: b.name, reason: 'invalid delete coord' });
      return;
    }
    const existingRow = existing.get(_coordKey(lat, lng));
    if (existingRow == null) {
      skipped.push({ name: b.name, reason: 'delete target not found' });
      return;
    }
    sheet.deleteRow(existingRow);
    deleted.push({ name: b.name, lat, lng });
    existing.clear();
    const nowLastRow = sheet.getLastRow();
    if (nowLastRow >= 2) {
      const range = sheet.getRange(2, 2, nowLastRow - 1, 2).getValues();
      range.forEach((r, i) => {
        const rowLat = parseFloat(r[0]);
        const rowLng = parseFloat(r[1]);
        if (Number.isFinite(rowLat) && Number.isFinite(rowLng)) {
          existing.set(_coordKey(rowLat, rowLng), i + 2);
        }
      });
    }
  });

  return _json({
    added: added.length,
    updated: updated.length,
    deleted: deleted.length,
    skipped: skipped.length,
    added_items: added,
    updated_items: updated,
    deleted_items: deleted,
    skipped_items: skipped,
  });
}

function _handleRoutes(sheet, upserts, deletes) {
  const lastRow = sheet.getLastRow();
  const existing = new Map();
  if (lastRow >= 2) {
    const names = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    names.forEach((r, i) => {
      const name = String(r[0] || '').trim();
      if (name) existing.set(name, i + 2);
    });
  }

  const added = [];
  const updated = [];
  const deleted = [];
  const skipped = [];

  upserts.forEach((r) => {
    const name = String(r.name || '').trim();
    const waypoints = String(r.waypoints_json || '').trim();
    if (!name) {
      skipped.push({ name: '', reason: 'missing route name' });
      return;
    }
    if (!waypoints) {
      skipped.push({ name, reason: 'missing waypoints_json' });
      return;
    }
    const row = ROUTE_COLUMNS.map((c) => r[c] || '');
    const existingRow = existing.get(name);
    if (existingRow != null) {
      sheet.getRange(existingRow, 1, 1, ROUTE_COLUMNS.length).setValues([row]);
      updated.push({ name });
    } else {
      sheet.appendRow(row);
      added.push({ name });
      existing.set(name, sheet.getLastRow());
    }
  });

  deletes.forEach((r) => {
    const name = String(r.name || '').trim();
    if (!name) {
      skipped.push({ name: '', reason: 'missing delete route name' });
      return;
    }
    const existingRow = existing.get(name);
    if (existingRow == null) {
      skipped.push({ name, reason: 'delete target not found' });
      return;
    }
    sheet.deleteRow(existingRow);
    deleted.push({ name });
    existing.clear();
    const nowLastRow = sheet.getLastRow();
    if (nowLastRow >= 2) {
      const names = sheet.getRange(2, 1, nowLastRow - 1, 1).getValues();
      names.forEach((row, i) => {
        const rowName = String(row[0] || '').trim();
        if (rowName) existing.set(rowName, i + 2);
      });
    }
  });

  return _json({
    added: added.length,
    updated: updated.length,
    deleted: deleted.length,
    skipped: skipped.length,
    added_items: added,
    updated_items: updated,
    deleted_items: deleted,
    skipped_items: skipped,
  });
}

function doGet() {
  // Health check: visiting the URL in a browser should show this small
  // confirmation instead of an opaque error, so users can verify deployment
  // succeeded.
  return _json({
    ok: true,
    message: 'ios-locctl webhook is alive. POST bookmark or route sync payloads to upload them.',
    bookmarks_tab: BOOKMARKS_TAB,
    routes_tab: ROUTES_TAB,
    bookmarks_columns: BOOKMARK_COLUMNS,
    routes_columns: ROUTE_COLUMNS,
  });
}

function _coordKey(lat, lng) {
  return lat.toFixed(6) + ',' + lng.toFixed(6);
}

function _json(obj, status) {
  // Apps Script Web Apps can't actually set HTTP status codes — the runtime
  // strips them. We pass `status` through inside the JSON body so the desktop
  // app can branch on `error` / `added` instead of needing an HTTP code.
  if (status && status >= 400 && !obj.error) obj.error = `http ${status}`;
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
