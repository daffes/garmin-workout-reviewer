const list = document.querySelector("#activity-list");
const header = document.querySelector(".activity-table-head");
const TOKEN_KEY = "gwr.drive.access-token.v1";
const PROJECT_URL = "https://chatgpt.com/g/g-p-6a5f5d0e62c08191ad5f73463e7a4e64-iron-man-haines-city/project";

if (header) {
  header.innerHTML = ["Date", "Day", "Time", "ID", "Sport", "Distance", "Duration", "Links"]
    .map((label) => `<span>${label}</span>`)
    .join("");
}

if (list) {
  normalizeRows();
  new MutationObserver(normalizeRows).observe(list, { childList: true });
}

window.addEventListener("gwr-manifest-available", () => decorateGarminLinks());
document.addEventListener("click", handleStartReviewCapture, true);

function handleStartReviewCapture(event) {
  const button = event.target.closest("[data-start-review]");
  if (!button) return;

  const row = button.closest(".activity-row");
  if (!row) return;

  event.preventDefault();
  event.stopImmediatePropagation();

  const referenceId = row.querySelector("[data-copy-reference]")?.dataset.copyReference
    || row.dataset.referenceId
    || "unknown GWR activity";
  const folderId = row.dataset.folderId || "";
  const driveUrl = row.querySelector('.activity-links a[href*="drive.google.com/drive/folders/"]')?.href
    || (folderId ? `https://drive.google.com/drive/folders/${folderId}` : "");
  const prompt = buildReviewPrompt(referenceId, driveUrl);

  const originalLabel = button.textContent;
  button.textContent = "Opening…";
  window.open(PROJECT_URL, "_blank", "noopener");

  navigator.clipboard.writeText(prompt)
    .then(() => {
      button.textContent = "Prompt copied";
    })
    .catch(() => {
      button.textContent = "Copy failed";
      window.prompt("Copy this review prompt:", prompt);
    })
    .finally(() => {
      setTimeout(() => { button.textContent = originalLabel; }, 1400);
    });
}

function buildReviewPrompt(referenceId, driveUrl) {
  return [
    "Review this Garmin Workout Reviewer activity using the Iron Man Haines City project context.",
    "",
    `Activity reference: ${referenceId}`,
    `Google Drive activity folder: ${driveUrl}`,
    "",
    "Required workflow:",
    "1. Treat the GWR-* value as an internal Garmin Workout Reviewer activity ID, not as a public Garmin, Strava, Instagram, or web code.",
    "2. Do not search the web or File Library for this ID.",
    "3. Use the Google Drive connector and open the exact activity-folder URL above.",
    "4. Read activity-manifest.json, athlete-notes.md, and review-summary.json first.",
    "5. Complete the initial review from those compact files whenever possible. Do not read or process decoded-full JSON or raw GPS records unless a specific unanswered question requires second-by-second detail.",
    "6. For older activity folders without review-summary.json, use the *.analysis.json file, but avoid decoded-full JSON unless necessary.",
    "7. Apply my reusable Ironman workout-review method and evaluate execution, physiology, technique, relation to my current benchmarks, and the next training decision.",
    "8. Do not ask me to upload the activity again unless the Drive folder genuinely cannot be opened.",
  ].join("\n");
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

    const dayCell = document.createElement("span");
    dayCell.className = "activity-day";
    dayCell.textContent = Number.isNaN(parsed.getTime()) ? "—" : formatDay(parsed);

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

    row.insertBefore(dayCell, summary);
    row.insertBefore(timeCell, summary);
    if (reference) row.insertBefore(reference, summary);
    if (sport) row.insertBefore(sport, summary);
    row.insertBefore(distanceCell, summary);
    row.insertBefore(durationCell, summary);
    summary.remove();

    decorateGarminLink(row);
    if (distance === "—" || duration === "—") backfillMetrics(row).catch(() => {});
  }

  decorateGarminLinks();
}

function decorateGarminLinks() {
  if (!list) return;
  for (const row of list.querySelectorAll(":scope > .activity-row")) decorateGarminLink(row);
}

function decorateGarminLink(row) {
  const links = row.querySelector(".activity-links");
  if (!links || links.querySelector("[data-garmin-link]")) return;

  const manifest = window.__gwrManifestsByFolder instanceof Map
    ? window.__gwrManifestsByFolder.get(row.dataset.folderId)
    : null;
  const activityId = garminActivityId(manifest);
  if (!activityId) return;

  row.dataset.garminActivityId = activityId;
  const link = document.createElement("a");
  link.href = `https://connect.garmin.com/app/activity/${activityId}`;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "Garmin";
  link.dataset.garminLink = activityId;
  link.title = `Open Garmin Connect activity ${activityId}`;
  links.prepend(link);
}

function garminActivityId(manifest) {
  if (!manifest) return null;
  const candidates = [
    manifest.garminActivityId,
    manifest.activityId,
    manifest.source?.fitFileName,
    manifest.source?.extractedFitFileName,
    manifest.source?.fileName,
    manifest.folderName,
  ];

  for (const candidate of candidates) {
    const text = String(candidate || "");
    const exact = text.match(/^\d{8,16}$/);
    if (exact) return exact[0];
    const embedded = text.match(/(?:^|\D)(\d{8,16})(?=\D|$)/);
    if (embedded) return embedded[1];
  }
  return null;
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
    file.appProperties?.artifactType === "review-summary-json"
      || file.appProperties?.artifactType === "analysis-json"
      || file.name === "review-summary.json"
      || /\.analysis\.json$/i.test(file.name),
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

function formatDay(value) {
  return value.toLocaleDateString("en-US", { weekday: "short" });
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
