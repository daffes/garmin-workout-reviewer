const PROJECT_URL = "https://chatgpt.com/g/g-p-6a5f5d0e62c08191ad5f73463e7a4e64-iron-man-haines-city/project";

document.addEventListener("click", handleStartReview, true);

function handleStartReview(event) {
  const button = event.target.closest("[data-start-review]");
  if (!button) return;

  const row = button.closest(".activity-row");
  if (!row) return;

  event.preventDefault();
  event.stopImmediatePropagation();

  const activity = readActivity(row);
  const prompt = buildReviewPrompt(activity);
  const originalLabel = button.textContent;

  button.textContent = "Opening…";
  window.open(PROJECT_URL, "_blank", "noopener");

  navigator.clipboard.writeText(prompt)
    .then(() => { button.textContent = "Prompt copied"; })
    .catch(() => {
      button.textContent = "Copy failed";
      window.prompt("Copy this review prompt:", prompt);
    })
    .finally(() => {
      setTimeout(() => { button.textContent = originalLabel; }, 1400);
    });
}

function readActivity(row) {
  const referenceId = row.querySelector("[data-copy-reference]")?.dataset.copyReference
    || row.dataset.referenceId
    || "unknown GWR activity";
  const folderId = row.dataset.folderId || "";
  const driveUrl = row.querySelector('.activity-links a[href*="drive.google.com/drive/folders/"]')?.href
    || (folderId ? `https://drive.google.com/drive/folders/${folderId}` : "");
  const garminUrl = row.querySelector('.activity-links a[href*="connect.garmin.com/app/activity/"]')?.href || "";

  return {
    referenceId,
    driveUrl,
    garminUrl,
    date: clean(row.querySelector(".activity-date")?.textContent),
    day: clean(row.querySelector(".activity-day")?.textContent),
    time: clean(row.querySelector(".activity-time")?.textContent),
    sport: titleCase(clean(row.querySelector(".activity-sport")?.textContent) || "Workout"),
    distance: cleanMetric(row.querySelector(".activity-distance")?.textContent),
    duration: cleanMetric(row.querySelector(".activity-duration")?.textContent),
  };
}

function buildReviewPrompt(activity) {
  const date = activity.date || "Undated";
  const result = [activity.distance, activity.duration ? `in ${activity.duration}` : ""]
    .filter(Boolean)
    .join(" ");
  const headline = `Review my ${date} ${activity.sport} workout${result ? ` — ${result}` : ""} — ${activity.referenceId}.`;
  const suggestedTitle = [date, activity.sport, activity.distance, activity.referenceId]
    .filter(Boolean)
    .join(" — ");

  return [
    headline,
    `Suggested thread title: ${suggestedTitle}`,
    "",
    `Activity reference: ${activity.referenceId}`,
    `Activity date: ${[activity.date, activity.day, activity.time].filter(Boolean).join(" ")}`,
    `Sport: ${activity.sport}`,
    activity.distance ? `Distance: ${activity.distance}` : null,
    activity.duration ? `Duration: ${activity.duration}` : null,
    `Google Drive activity folder: ${activity.driveUrl}`,
    activity.garminUrl ? `Garmin Connect activity: ${activity.garminUrl}` : null,
    "",
    "Required workflow:",
    "1. Treat the GWR-* value as an internal Garmin Workout Reviewer activity ID, not as a public Garmin, Strava, Instagram, or web code.",
    "2. Do not search the web or File Library for this ID.",
    "3. Use the Google Drive connector and open the exact activity-folder URL above.",
    "4. Read activity-manifest.json, athlete-notes.md, and review-summary.json first.",
    "5. Complete the initial review from those compact files whenever possible. Do not read decoded-full JSON or raw GPS records unless a specific unanswered question requires second-by-second detail.",
    "6. For older folders without review-summary.json, use the *.analysis.json file, but avoid decoded-full JSON unless necessary.",
    "7. Apply my reusable Ironman workout-review method and evaluate execution, physiology, technique, relation to my current benchmarks, and the next training decision.",
    "8. Do not ask me to upload the activity again unless the Drive folder genuinely cannot be opened.",
  ].filter(Boolean).join("\n");
}

function clean(value) {
  const text = String(value || "").trim();
  return text === "—" ? "" : text;
}

function cleanMetric(value) {
  return clean(value);
}

function titleCase(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
