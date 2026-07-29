const list = document.querySelector("#activity-list");
const header = document.querySelector(".activity-table-head");

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

function formatDate(value) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatTime(value) {
  return `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
}
