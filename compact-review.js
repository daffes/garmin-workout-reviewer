import { buildGradeAdjustedPaceReport } from "./gap.js?v=20260731-1201";

const PROJECT_URL = "https://chatgpt.com/g/g-p-6a5f5d0e62c08191ad5f73463e7a4e64-iron-man-haines-city/project";
const REVIEW_FILE_NAME = "review-summary.json";
const BUCKET_SECONDS = 30;
const uploadKinds = new Map();
const originalFetch = window.fetch.bind(window);

window.fetch = async (input, init = {}) => {
  const url = requestUrl(input);

  if (isDriveMetadataCreate(url, init)) {
    const metadata = parseJsonBody(init.body);
    const artifactType = metadata?.appProperties?.artifactType;

    if (artifactType === "analysis-json") {
      const rewritten = {
        ...metadata,
        name: REVIEW_FILE_NAME,
        appProperties: {
          ...(metadata.appProperties || {}),
          artifactType: "review-summary-json",
        },
      };
      const response = await originalFetch(input, { ...init, body: JSON.stringify(rewritten) });
      await rememberCreatedFile(response, "review-summary");
      return response;
    }

    if (artifactType === "activity-manifest") {
      const response = await originalFetch(input, init);
      await rememberCreatedFile(response, "manifest");
      return response;
    }
  }

  const uploadId = mediaUploadFileId(url, init);
  const kind = uploadId ? uploadKinds.get(uploadId) : null;

  if (kind === "review-summary") {
    const analysis = await parseBodyJson(init.body);
    if (analysis) {
      const compact = buildReviewSummary(analysis);
      return originalFetch(input, {
        ...init,
        body: jsonBlob(compact),
      });
    }
  }

  if (kind === "manifest") {
    const manifest = await parseBodyJson(init.body);
    if (manifest) {
      return originalFetch(input, {
        ...init,
        body: jsonBlob({
          ...manifest,
          reviewFileName: REVIEW_FILE_NAME,
          reviewStrategy: "Read review-summary.json first; use decoded-full JSON only for targeted deep dives.",
        }),
      });
    }
  }

  return originalFetch(input, init);
};

document.addEventListener("click", handleStartReview, true);

function handleStartReview(event) {
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
    .then(() => { button.textContent = "Prompt copied"; })
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

function buildReviewSummary(analysis) {
  const records = Array.isArray(analysis.records) ? analysis.records : [];
  const sessions = Array.isArray(analysis.sessions) ? analysis.sessions : [];
  const laps = Array.isArray(analysis.laps) ? analysis.laps : [];
  const gapReport = buildGradeAdjustedPaceReport(analysis, BUCKET_SECONDS);
  const timeSeries = mergeGapIntoTimeSeries(
    bucketRecords(records, BUCKET_SECONDS),
    gapReport?.timeSeries || [],
  );
  const firstHalf = halfMetrics(records, 0, 0.5);
  const secondHalf = halfMetrics(records, 0.5, 1);

  return {
    schemaVersion: 4,
    generatedAt: analysis.generatedAt || new Date().toISOString(),
    purpose: "Compact default input for an Iron Man Haines City workout review",
    source: analysis.source || null,
    athleteNotes: analysis.athleteNotes || "",
    summary: analysis.summary || {},
    sessions,
    laps,
    events: analysis.events || [],
    lengths: analysis.lengths || [],
    activities: analysis.activities || [],
    workoutSteps: analysis.workoutSteps || [],
    workouts: analysis.workouts || [],
    deviceInfos: analysis.deviceInfos || [],
    hrv: analysis.hrv || [],
    recordFields: analysis.recordFields || [],
    availableMessageGroups: analysis.availableMessageGroups || {},
    aggregateMetrics: {
      heartRate: metricStats(records, ["heartRate", "heart_rate"]),
      power: metricStats(records, ["power"]),
      cadence: metricStats(records, ["cadence"]),
      speedMetersPerSecond: metricStats(records, ["enhancedSpeed", "enhanced_speed", "speed"]),
      elevationMeters: metricStats(records, ["enhancedAltitude", "enhanced_altitude", "altitude"]),
      temperatureC: metricStats(records, ["temperature"]),
      leftRightBalance: metricStats(records, ["leftRightBalance", "left_right_balance"]),
    },
    firstHalf,
    secondHalf,
    drift: compareHalves(firstHalf, secondHalf),
    gradeAdjustedPace: gapReport ? compactObject({
      ...gapReport,
      timeSeries: undefined,
    }) : null,
    timeSeries: {
      bucketSeconds: BUCKET_SECONDS,
      description: "Thirty-second aggregates without GPS coordinates; use decoded-full JSON only for targeted deep dives.",
      samples: timeSeries,
    },
    rawDetail: {
      recordCount: records.length,
      omittedFromThisFile: true,
      availableInDecodedFullJson: true,
    },
  };
}

function mergeGapIntoTimeSeries(timeSeries, gapTimeSeries) {
  const gapByElapsedSeconds = new Map(gapTimeSeries.map((sample) => [sample.elapsedSeconds, sample]));
  return timeSeries.map((sample) => {
    const gap = gapByElapsedSeconds.get(sample.elapsedSeconds);
    return gap ? {
      ...sample,
      gapSecondsPerKm: gap.gapSecondsPerKm,
      gapGradeCoveragePercent: gap.gradeCoveragePercent,
    } : sample;
  });
}

function bucketRecords(records, bucketSeconds) {
  const timed = records
    .map((record) => ({ record, time: recordTime(record) }))
    .filter((item) => Number.isFinite(item.time))
    .sort((a, b) => a.time - b.time);
  if (!timed.length) return [];

  const origin = timed[0].time;
  const buckets = new Map();
  for (const item of timed) {
    const index = Math.max(0, Math.floor((item.time - origin) / (bucketSeconds * 1000)));
    if (!buckets.has(index)) buckets.set(index, []);
    buckets.get(index).push(item.record);
  }

  return [...buckets.entries()].map(([index, bucket]) => {
    const startMs = origin + index * bucketSeconds * 1000;
    const speed = average(bucket, ["enhancedSpeed", "enhanced_speed", "speed"]);
    return compactObject({
      startTime: new Date(startMs).toISOString(),
      elapsedSeconds: index * bucketSeconds,
      sampleCount: bucket.length,
      distanceMeters: lastNumber(bucket, ["distance"]),
      heartRate: average(bucket, ["heartRate", "heart_rate"]),
      power: average(bucket, ["power"]),
      cadence: average(bucket, ["cadence"]),
      speedMetersPerSecond: speed,
      paceSecondsPerKm: speed && speed > 0 ? round(1000 / speed, 1) : null,
      elevationMeters: average(bucket, ["enhancedAltitude", "enhanced_altitude", "altitude"]),
      gradePercent: average(bucket, ["grade"]),
      temperatureC: average(bucket, ["temperature"]),
      leftRightBalance: average(bucket, ["leftRightBalance", "left_right_balance"]),
    });
  });
}

function halfMetrics(records, startFraction, endFraction) {
  if (!records.length) return {};
  const start = Math.floor(records.length * startFraction);
  const end = Math.max(start + 1, Math.ceil(records.length * endFraction));
  const slice = records.slice(start, end);
  return compactObject({
    sampleCount: slice.length,
    heartRate: average(slice, ["heartRate", "heart_rate"]),
    power: average(slice, ["power"]),
    cadence: average(slice, ["cadence"]),
    speedMetersPerSecond: average(slice, ["enhancedSpeed", "enhanced_speed", "speed"]),
    elevationMeters: average(slice, ["enhancedAltitude", "enhanced_altitude", "altitude"]),
  });
}

function compareHalves(first, second) {
  const output = {};
  for (const key of ["heartRate", "power", "cadence", "speedMetersPerSecond", "elevationMeters"]) {
    const a = number(first[key]);
    const b = number(second[key]);
    if (a == null || b == null) continue;
    output[key] = {
      absoluteChange: round(b - a, 2),
      percentChange: a === 0 ? null : round(((b - a) / a) * 100, 2),
    };
  }

  const hr1 = number(first.heartRate);
  const hr2 = number(second.heartRate);
  const output1 = number(first.power) ?? number(first.speedMetersPerSecond);
  const output2 = number(second.power) ?? number(second.speedMetersPerSecond);
  if (hr1 && hr2 && output1 && output2) {
    const ratio1 = output1 / hr1;
    const ratio2 = output2 / hr2;
    output.aerobicDecouplingPercent = round(((ratio1 - ratio2) / ratio1) * 100, 2);
    output.aerobicDecouplingBasis = first.power != null && second.power != null ? "power-to-heart-rate" : "speed-to-heart-rate";
  }
  return output;
}

function metricStats(records, keys) {
  const values = records.map((record) => number(pick(record, keys))).filter((value) => value != null);
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    sampleCount: values.length,
    min: round(sorted[0], 2),
    average: round(values.reduce((sum, value) => sum + value, 0) / values.length, 2),
    max: round(sorted[sorted.length - 1], 2),
    p50: round(percentile(sorted, 0.5), 2),
    p95: round(percentile(sorted, 0.95), 2),
  };
}

function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function average(records, keys) {
  const values = records.map((record) => number(pick(record, keys))).filter((value) => value != null);
  if (!values.length) return null;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length, 2);
}

function lastNumber(records, keys) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const value = number(pick(records[index], keys));
    if (value != null) return round(value, 2);
  }
  return null;
}

function recordTime(record) {
  const value = pick(record, ["timestamp", "startTime", "start_time"]);
  if (!value) return NaN;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : NaN;
}

function pick(object, keys) {
  for (const key of keys) {
    if (object?.[key] !== undefined && object[key] !== null) return object[key];
  }
  return null;
}

function number(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined));
}

function isDriveMetadataCreate(url, init) {
  return init?.method === "POST"
    && url.startsWith("https://www.googleapis.com/drive/v3/files?")
    && String(headerValue(init.headers, "Content-Type") || "").includes("application/json");
}

function mediaUploadFileId(url, init) {
  if (init?.method !== "PATCH" || !url.includes("/upload/drive/v3/files/")) return null;
  return url.match(/\/upload\/drive\/v3\/files\/([^?]+)/)?.[1] || null;
}

async function rememberCreatedFile(response, kind) {
  if (!response.ok) return;
  try {
    const data = await response.clone().json();
    if (data?.id) uploadKinds.set(String(data.id), kind);
  } catch {
    // The original app still receives the untouched response.
  }
}

function parseJsonBody(body) {
  if (typeof body !== "string") return null;
  try { return JSON.parse(body); } catch { return null; }
}

async function parseBodyJson(body) {
  try {
    if (typeof body === "string") return JSON.parse(body);
    if (body instanceof Blob) return JSON.parse(await body.text());
    return null;
  } catch {
    return null;
  }
}

function headerValue(headers, name) {
  if (headers instanceof Headers) return headers.get(name);
  const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1] || null;
}

function requestUrl(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input?.url || "";
}

function jsonBlob(value) {
  return new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
}
