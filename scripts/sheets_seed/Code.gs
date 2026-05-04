/**
 * ios-locctl — Sheets webhook for in-app bookmark uploads.
 *
 * What this does:
 *   The desktop app sends an array of bookmark objects via POST. This script
 *   appends each one as a row to the `bookmarks` tab, skipping any record
 *   whose lat,lng (rounded to 6 decimals) already exists, then returns a
 *   summary the app uses to update its UI.
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

// Tab inside the Spreadsheet that holds the bookmark rows. Must match the
// tab name configured in the desktop app (default "bookmarks").
const TAB_NAME = 'bookmarks';

// Column order in the sheet. The desktop app sends keys with these names;
// changing this array changes both the row write and the dedup-key reads.
const COLUMNS = ['name', 'lat', 'lng', 'country', 'category', 'added_by', 'added_at', 'note'];

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents || '[]');
  } catch (err) {
    return _json({ error: 'invalid JSON: ' + err.message }, 400);
  }

  // Accept either a bare array (legacy: treat as upsert) or an envelope:
  //   { action: 'upsert', items: [...] }
  // Delete operations are intentionally not supported — local installs can
  // only add/edit cloud rows, never remove them; cloud deletions happen in
  // the Sheet UI directly.
  let items;
  if (Array.isArray(body)) {
    items = body;
  } else if (body && Array.isArray(body.items)) {
    if (body.action && body.action !== 'upsert') {
      return _json({ error: `unsupported action: ${body.action}` }, 400);
    }
    items = body.items;
  } else {
    return _json({ error: 'expected an array of bookmarks or { action, items }' }, 400);
  }

  const sheet = SpreadsheetApp.getActive().getSheetByName(TAB_NAME);
  if (!sheet) {
    return _json({ error: `tab "${TAB_NAME}" not found in this spreadsheet` }, 404);
  }

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
  const skipped = [];

  items.forEach((b) => {
    const lat = parseFloat(b.lat);
    const lng = parseFloat(b.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      skipped.push({ name: b.name, reason: 'invalid coord' });
      return;
    }
    const key = _coordKey(lat, lng);
    const row = COLUMNS.map((c) => {
      if (c === 'lat') return lat;
      if (c === 'lng') return lng;
      return b[c] || '';
    });
    const existingRow = existing.get(key);
    if (existingRow != null) {
      sheet.getRange(existingRow, 1, 1, COLUMNS.length).setValues([row]);
      updated.push({ name: b.name, lat, lng });
    } else {
      sheet.appendRow(row);
      added.push({ name: b.name, lat, lng });
      existing.set(key, sheet.getLastRow());
    }
  });

  return _json({
    added: added.length,
    updated: updated.length,
    skipped: skipped.length,
    added_items: added,
    updated_items: updated,
    skipped_items: skipped,
  });
}

function doGet() {
  // Health check: visiting the URL in a browser should show this small
  // confirmation instead of an opaque error, so users can verify deployment
  // succeeded.
  return _json({
    ok: true,
    message: 'ios-locctl webhook is alive. POST an array of bookmarks to upload them.',
    expected_columns: COLUMNS,
    target_tab: TAB_NAME,
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
