const list = document.querySelector("#activity-list");
const header = document.querySelector(".activity-table-head");
const TOKEN_KEY = "gwr.drive.access-token.v1";

if (header) {
  header.innerHTML = ["Date", "Time", "ID", "Sport", "Distance", "Duration", "Links"]
    .map((label) => `<span>${label}</span>`)
    .join("");
}

if (list) {
  normalizeRows();
  new MutationObserver(normalizeRows).observe(list, { childList: true });
}

function normalizeRows() {
  for (const row of list.querySelectorAll(":scope > .activity-row:not([data-column-layout])")) {
    row.dataset.columnLayout = "1";

    const dateCell = row.querySelector(".activity-when");
    const summary = row.querySelector(".activity-summary");
    const links = row.querySelector(".activity-links");
    if (!dateCell || !summary || !links) continue;

    const reference = summary.querySelector(".activity-reference");
    const sport = summary.querySelector(".activity-sport");
    const title = summary.querySelector(".activity-title");
    const start = dateCell.getAttribute("datetime") || "";
    const parsed = new Date(start);

    dateCell.className = "activity-date";
    dateCell.textContent = Number.isNaN(parsed.getTime()) ? "—" : formatDate(parsed);

    const timeCell = document.createElement("time");
    timeCell.className = "activity-time";
    timeCell.dateTime = start;
    timeCell.textContent = Number.isNaN(parsed.getTime()) ? "—" : formatTime(parsed);

    if (sport) sport.textContent = sport.textContent.split("/")[0].trim();

    const { distance, duration } = extractMetrics(title?.textContent || "");
    const distanceCell = document.createElement("span");
    distanceCell.className = "activity-distance";
    distanceCell.textContent = distance;

    const durationCell = document.createElement("span");
    durationCell.className = "activity-duration";
    durationCell.textContent = duration;

    row.insertBefore(timeCell, summary);
    if (reference) row.insertBefore(reference, summary);
    if (sport) row.insertBefore(sport, summary);
    row.insertBefore(distanceCell, summary);
    row.insertBefore(durationCell, summary);
    summary.remove();

    if (distance === "—" || duration === "—") backfillMetrics(row).catch(() => {});
  }
}

async function backfillMetrics(row) {
  if (row.dataset.metricsBackfill) return;
  row.dataset.metricsBackfill = "1";

  const token = readToken();
  const folderId = row.dataset.folderId;
  if (!token || !folderId) return;

  const query = `'${driveEscape(folderId)}' in parents and trashed=false`;
  const url = `https://www.googleapis.com/drive/v3/files?spaces=drive&pageSize=50&fields=${encodeURIComponent("files(id,name,appProperties)")}&q=${encodeURIComponent(query)}`;
  const files = await driveJson(url, token);
  const analysisFile = (files.files || []).find((file) =>
    file.appProperties?.artifactType === "analysis-json" || /\.analysis\.json$/i.test(file.name),
  );
  if (!analysisFile) return;

  const analysis = await driveJson(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(analysisFile.id)}?alt=media`,
    token,
  );
  const summary = analysis.summary || {};

  const distanceCell = row.querySelector(".activity-distance");
  const durationCell = row.querySelector(".activity-duration");
  if (distanceCell?.textContent === "—") distanceCell.textContent = formatDistance(summary.totalDistanceMeters);
  if (durationCell?.textContent === "—") {
    durationCell.textContent = formatDuration(summary.totalTimerTimeSeconds ?? summary.totalElapsedTimeSeconds);
  }
}

function extractMetrics(value) {
  const parts = String(value)
    .split("·")
    .map((part) => part.trim())
    .filter(Boolean);

  const distance = parts.find((part) => /^\d+(?:\.\d+)?\s*(?:km|m)$/i.test(part)) || "—";
  const duration = parts.find((part) => /^\d+:\d{2}(?::\d{2})?$/.test(part)) || "—";
  return { distance, duration };
}

function readToken() {
  try {
    const cached = JSON.parse(localStorage.getItem(TOKEN_KEY) || "null");
    return cached?.accessToken || null;
  } catch {
    return null;
  }
}

async function driveJson(url, token) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Drive API ${response.status}`);
  return response.json();
}

function driveEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function formatDate(value) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatTime(value) {
  return `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
}

function formatDistance(meters) {
  if (!Number.isFinite(Number(meters))) return "—";
  return Number(meters) >= 1000 ? `${(Number(meters) / 1000).toFixed(2)} km` : `${Math.round(Number(meters))} m`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(Number(seconds))) return "—";
  const total = Math.max(0, Math.round(Number(seconds)));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
}
