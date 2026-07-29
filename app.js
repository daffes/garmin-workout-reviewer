import { Decoder, Stream } from "https://cdn.jsdelivr.net/npm/@garmin/fitsdk@21.208.0/src/index.js";

const CLIENT_ID = "876189937046-luqlkqg5vv7qjqa4srcudu9ie4u5q97g.apps.googleusercontent.com";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const ROOT = "Iron Man Training Data";
const APP = "garmin-workout-reviewer";
const CONNECTED_KEY = "gwr.drive.connected";
const MANIFEST_NAME = "activity-manifest.json";

const $ = (selector) => document.querySelector(selector);
const el = {
  connect: $("#connect-drive"),
  driveStatus: $("#drive-status"),
  refreshLibrary: $("#refresh-library"),
  libraryStatus: $("#library-status"),
  activityList: $("#activity-list"),
  file: $("#fit-file"),
  fileName: $("#file-name"),
  notes: $("#athlete-notes"),
  parse: $("#parse-fit"),
  parseStatus: $("#parse-status"),
  results: $("#results-panel"),
  integrity: $("#integrity-status"),
  grid: $("#summary-grid"),
  groups: $("#message-groups"),
  dlAnalysis: $("#download-analysis"),
  dlFull: $("#download-full"),
  save: $("#save-panel"),
  upload: $("#upload-drive"),
  uploadStatus: $("#upload-status"),
  driveResult: $("#drive-result"),
  log: $("#log"),
  clear: $("#clear-log"),
};

const state = {
  file: null,
  token: null,
  tokenExpiresAt: 0,
  tokenClient: null,
  tokenWaiter: null,
  refreshTimer: null,
  full: null,
  analysis: null,
  root: null,
  activities: [],
};

el.file.onchange = () => {
  state.file = el.file.files?.[0] || null;
  el.fileName.textContent = state.file ? `${state.file.name} · ${bytes(state.file.size)}` : "No file selected";
  el.parse.disabled = !state.file;
  status(el.parseStatus, state.file ? "Ready to parse" : "Waiting for file", state.file ? "good" : "neutral");
};

el.connect.onclick = () => connectDrive(true);
el.refreshLibrary.onclick = loadLibrary;
el.parse.onclick = parseFit;
el.dlAnalysis.onclick = () => download(state.analysis, analysisName());
el.dlFull.onclick = () => download(state.full, fullName());
el.upload.onclick = uploadPackage;
el.clear.onclick = () => { el.log.textContent = ""; };
el.activityList.onclick = handleLibraryClick;

boot();

async function boot() {
  note("Initializing Google Drive connection...");
  try {
    await initTokenClient();
    if (localStorage.getItem(CONNECTED_KEY) === "1") {
      await connectDrive(false);
    } else {
      status(el.driveStatus, "Not connected", "neutral");
      status(el.libraryStatus, "Connect Drive", "neutral");
    }
  } catch (error) {
    status(el.driveStatus, "Reconnect required", "warn");
    status(el.libraryStatus, "Connect Drive", "neutral");
    note(`Silent Drive connection was not available: ${msg(error)}`);
  }
}

async function initTokenClient() {
  if (state.tokenClient) return;
  await waitGoogle();
  state.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPE,
    include_granted_scopes: true,
    callback: handleTokenResponse,
    error_callback: (error) => rejectToken(new Error(`Google authorization did not complete: ${error.type || "unknown"}`)),
  });
}

async function connectDrive(interactive) {
  try {
    status(el.driveStatus, interactive ? "Opening Google" : "Restoring session", "working");
    await authorize(interactive);
    status(el.driveStatus, "Drive connected", "good");
    el.connect.textContent = "Reconnect Drive";
    localStorage.setItem(CONNECTED_KEY, "1");
    note(interactive ? "Google Drive connected." : "Google Drive session restored silently.");
    await loadLibrary();
  } catch (error) {
    status(el.driveStatus, "Reconnect required", "warn");
    status(el.libraryStatus, "Connect Drive", "neutral");
    if (interactive) fail(error);
    else throw error;
  }
}

async function authorize(interactive = false) {
  if (state.token && Date.now() < state.tokenExpiresAt - 60_000) return state.token;
  await initTokenClient();
  if (state.tokenWaiter) return state.tokenWaiter.promise;

  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  state.tokenWaiter = { promise, resolve: resolvePromise, reject: rejectPromise };

  try {
    state.tokenClient.requestAccessToken({ prompt: interactive ? "select_account" : "" });
  } catch (error) {
    rejectToken(error);
  }
  return promise;
}

function handleTokenResponse(response) {
  if (response.error) {
    rejectToken(new Error(response.error_description || response.error));
    return;
  }
  state.token = response.access_token;
  state.tokenExpiresAt = Date.now() + Math.max(60, Number(response.expires_in || 3600)) * 1000;
  localStorage.setItem(CONNECTED_KEY, "1");
  scheduleTokenRefresh();
  const waiter = state.tokenWaiter;
  state.tokenWaiter = null;
  waiter?.resolve(state.token);
}

function rejectToken(error) {
  const waiter = state.tokenWaiter;
  state.tokenWaiter = null;
  waiter?.reject(error instanceof Error ? error : new Error(String(error)));
}

function scheduleTokenRefresh() {
  clearTimeout(state.refreshTimer);
  const delay = Math.max(60_000, state.tokenExpiresAt - Date.now() - 5 * 60_000);
  state.refreshTimer = setTimeout(async () => {
    state.token = null;
    try {
      await authorize(false);
      status(el.driveStatus, "Drive connected", "good");
      note("Google Drive token refreshed silently.");
    } catch (error) {
      status(el.driveStatus, "Reconnect required", "warn");
      note(`Drive token refresh needs interaction: ${msg(error)}`);
    }
  }, delay);
}

async function waitGoogle() {
  const start = Date.now();
  while (!window.google?.accounts?.oauth2) {
    if (Date.now() - start > 10_000) throw new Error("Google Identity Services did not load.");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function parseFit() {
  if (!state.file) return;
  el.parse.disabled = true;
  el.results.classList.add("hidden");
  el.save.classList.add("hidden");
  status(el.parseStatus, "Decoding FIT", "working");
  note(`Reading ${state.file.name}...`);

  try {
    const stream = Stream.fromArrayBuffer(await state.file.arrayBuffer());
    const decoder = new Decoder(stream);
    if (!decoder.isFIT()) throw new Error("The selected file does not contain a valid FIT header.");

    let integrity = false;
    try { integrity = decoder.checkIntegrity(); }
    catch (error) { note(`Integrity check warning: ${msg(error)}`); }

    const output = decoder.read({
      applyScaleAndOffset: true,
      expandSubFields: true,
      expandComponents: true,
      convertTypesToStrings: true,
      convertDateTimesToDates: true,
      includeUnknownData: true,
      mergeHeartRates: true,
      decodeMemoGlobs: true,
      legacyArrayMode: false,
    });

    const messages = safe(output.messages);
    const errors = safe(output.errors || []);
    const summary = summarize(messages, state.file, integrity, errors);
    const athleteNotes = el.notes.value.trim();

    state.full = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      source: fileMeta(state.file),
      fitIntegrityPassed: integrity,
      decodeErrors: errors,
      athleteNotes,
      messages,
    };

    state.analysis = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      purpose: "Analysis-ready Garmin FIT extraction for the Iron Man Haines City ChatGPT project",
      source: {
        fileName: state.file.name,
        sizeBytes: state.file.size,
        fitIntegrityPassed: integrity,
        decodeErrors: errors,
      },
      athleteNotes,
      summary,
      sessions: group(messages, "session"),
      laps: group(messages, "lap"),
      records: group(messages, "record"),
      events: group(messages, "event"),
      lengths: group(messages, "length"),
      activities: group(messages, "activity"),
      workoutSteps: group(messages, "workoutStep"),
      workouts: group(messages, "workout"),
      deviceInfos: group(messages, "deviceInfo"),
      fileIds: group(messages, "fileId"),
      fieldDescriptions: group(messages, "fieldDescription"),
      developerDataIds: group(messages, "developerDataId"),
      hrv: group(messages, "hrv"),
      recordFields: summary.recordFields,
      availableMessageGroups: summary.messageGroupCounts,
    };

    renderSummary(summary);
    el.results.classList.remove("hidden");
    el.save.classList.remove("hidden");
    status(el.parseStatus, "Decoded", "good");
    status(el.integrity, integrity ? "Integrity passed" : "Integrity warning", integrity ? "good" : "warn");
    note(`Decoded ${summary.recordCount.toLocaleString()} records across ${Object.keys(summary.messageGroupCounts).length} message groups.`);
  } catch (error) {
    status(el.parseStatus, "Parse failed", "bad");
    fail(error);
  } finally {
    el.parse.disabled = !state.file;
  }
}

function summarize(messages, file, integrity, errors) {
  const sessions = group(messages, "session");
  const laps = group(messages, "lap");
  const records = group(messages, "record");
  const events = group(messages, "event");
  const lengths = group(messages, "length");
  const session = sessions[0] || {};
  const counts = Object.fromEntries(
    Object.entries(messages)
      .map(([key, value]) => [key, Array.isArray(value) ? value.length : value == null ? 0 : 1])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  const fields = [...new Set(records.flatMap((record) => Object.keys(record || {})))].sort();

  return {
    sourceFile: file.name,
    sourceSizeBytes: file.size,
    fitIntegrityPassed: integrity,
    decodeErrorCount: errors.length,
    sport: first(session, ["sport"]) || first(group(messages, "sport")[0] || {}, ["sport"]) || "unknown",
    subSport: first(session, ["subSport", "sub_sport"]),
    startTime: date(first(session, ["startTime", "start_time", "timestamp"])),
    totalElapsedTimeSeconds: num(first(session, ["totalElapsedTime", "total_elapsed_time"])),
    totalTimerTimeSeconds: num(first(session, ["totalTimerTime", "total_timer_time"])),
    totalDistanceMeters: num(first(session, ["totalDistance", "total_distance"])),
    totalAscentMeters: num(first(session, ["totalAscent", "total_ascent"])),
    avgHeartRate: num(first(session, ["avgHeartRate", "avg_heart_rate"])) ?? stats(records, ["heartRate", "heart_rate"]).avg,
    maxHeartRate: num(first(session, ["maxHeartRate", "max_heart_rate"])) ?? stats(records, ["heartRate", "heart_rate"]).max,
    avgPower: num(first(session, ["avgPower", "avg_power"])) ?? stats(records, ["power"]).avg,
    maxPower: num(first(session, ["maxPower", "max_power"])) ?? stats(records, ["power"]).max,
    normalizedPower: num(first(session, ["normalizedPower", "normalized_power"])),
    avgCadence: num(first(session, ["avgCadence", "avg_cadence"])) ?? stats(records, ["cadence"]).avg,
    recordCount: records.length,
    lapCount: laps.length,
    eventCount: events.length,
    lengthCount: lengths.length,
    recordFields: fields,
    messageGroupCounts: counts,
  };
}

function compactSummary(summary) {
  return {
    sport: summary.sport,
    subSport: summary.subSport,
    startTime: summary.startTime,
    totalTimerTimeSeconds: summary.totalTimerTimeSeconds,
    totalElapsedTimeSeconds: summary.totalElapsedTimeSeconds,
    totalDistanceMeters: summary.totalDistanceMeters,
    totalAscentMeters: summary.totalAscentMeters,
    avgHeartRate: summary.avgHeartRate,
    maxHeartRate: summary.maxHeartRate,
    avgPower: summary.avgPower,
    maxPower: summary.maxPower,
    normalizedPower: summary.normalizedPower,
    avgCadence: summary.avgCadence,
    recordCount: summary.recordCount,
    lapCount: summary.lapCount,
  };
}

function group(messages, name) {
  const normalizedName = norm(name);
  const hit = Object.entries(messages).find(([key]) => norm(key).replace(/mesgs$|messages$|message$/g, "") === normalizedName);
  return hit ? (Array.isArray(hit[1]) ? hit[1] : [hit[1]]) : [];
}

const norm = (value) => String(value).replace(/[^a-z0-9]/gi, "").toLowerCase();

function first(object, keys) {
  for (const key of keys) {
    if (object?.[key] !== undefined && object[key] !== null) return object[key];
  }
  return null;
}

function num(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function stats(records, keys) {
  const values = records.map((record) => num(first(record, keys))).filter((value) => value !== null);
  if (!values.length) return { avg: null, max: null };
  return {
    avg: Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10,
    max: Math.max(...values),
  };
}

function date(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function safe(value, seen = new WeakSet()) {
  if (value == null) return value ?? null;
  if (typeof value === "bigint") return String(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof ArrayBuffer) return [...new Uint8Array(value)];
  if (ArrayBuffer.isView(value)) return [...value];
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => safe(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safe(item, seen)]));
}

function renderSummary(summary) {
  const metrics = [
    ["Sport", [summary.sport, summary.subSport].filter(Boolean).join(" / ")],
    ["Started", summary.startTime ? new Date(summary.startTime).toLocaleString() : "Unknown"],
    ["Distance", distance(summary.totalDistanceMeters)],
    ["Timer time", duration(summary.totalTimerTimeSeconds ?? summary.totalElapsedTimeSeconds)],
    ["Records", summary.recordCount.toLocaleString()],
    ["Laps", summary.lapCount.toLocaleString()],
    ["Avg / max HR", pair(summary.avgHeartRate, summary.maxHeartRate, " bpm")],
    ["Avg / NP", pair(summary.avgPower, summary.normalizedPower, " W")],
  ];
  el.grid.innerHTML = metrics
    .map(([label, value]) => `<div class="metric"><span class="metric-label">${html(label)}</span><span class="metric-value">${html(value || "—")}</span></div>`)
    .join("");
  el.groups.textContent = Object.entries(summary.messageGroupCounts).map(([key, value]) => `${key}: ${value}`).join("\n");
}

async function uploadPackage() {
  if (!state.analysis || !state.full || !state.file) return note("Parse a FIT file first.");
  el.upload.disabled = true;
  status(el.uploadStatus, "Uploading", "working");
  el.driveResult.textContent = "";

  try {
    await authorize(false);
    const root = await findRoot(true);
    const summary = state.analysis.summary;
    const folder = await createFolder(folderName(), root.id, {
      app: APP,
      artifactType: "activity-folder",
      sport: String(summary.sport || "unknown").slice(0, 120),
      startTime: String(summary.startTime || "").slice(0, 120),
    });

    await uploadFile(state.file.name, state.file, "application/octet-stream", folder.id, "original-fit");
    await uploadFile(analysisName(), jsonBlob(state.analysis), "application/json", folder.id, "analysis-json");
    await uploadFile(fullName(), jsonBlob(state.full), "application/json", folder.id, "decoded-full-json");
    await uploadFile("athlete-notes.md", notesBlob(), "text/markdown", folder.id, "athlete-notes");

    const manifest = {
      schemaVersion: 1,
      activityId: state.file.name.replace(/\.fit$/i, ""),
      folderId: folder.id,
      folderName: folder.name,
      uploadedAt: new Date().toISOString(),
      source: fileMeta(state.file),
      sport: summary.sport,
      subSport: summary.subSport,
      startTime: summary.startTime,
      athleteNotes: state.analysis.athleteNotes || "",
      summary: compactSummary(summary),
      reviewed: false,
      reviewedAt: null,
      chatUrl: null,
    };
    await uploadFile(MANIFEST_NAME, jsonBlob(manifest), "application/json", folder.id, "activity-manifest");

    const url = `https://drive.google.com/drive/folders/${folder.id}`;
    el.driveResult.innerHTML = `Saved successfully: <a href="${url}" target="_blank" rel="noopener">open activity folder</a>`;
    status(el.uploadStatus, "Saved to Drive", "good");
    note(`Upload complete: ${url}`);
    await loadLibrary();
  } catch (error) {
    status(el.uploadStatus, "Upload failed", "bad");
    fail(error);
  } finally {
    el.upload.disabled = false;
  }
}

async function loadLibrary() {
  if (!state.token && localStorage.getItem(CONNECTED_KEY) !== "1") {
    status(el.libraryStatus, "Connect Drive", "neutral");
    renderLibrary([]);
    return;
  }

  el.refreshLibrary.disabled = true;
  status(el.libraryStatus, "Loading", "working");
  try {
    await authorize(false);
    const root = await findRoot(true);
    const folderQuery = [
      `'${driveEscape(root.id)}' in parents`,
      "mimeType='application/vnd.google-apps.folder'",
      "trashed=false",
      `appProperties has { key='app' and value='${APP}' }`,
      "appProperties has { key='artifactType' and value='activity-folder' }",
    ].join(" and ");
    const manifestQuery = [
      `name='${MANIFEST_NAME}'`,
      "trashed=false",
      `appProperties has { key='app' and value='${APP}' }`,
      "appProperties has { key='artifactType' and value='activity-manifest' }",
    ].join(" and ");

    const [folderResult, manifestResult] = await Promise.all([
      listDriveFiles(folderQuery, "files(id,name,createdTime,modifiedTime,webViewLink,appProperties)"),
      listDriveFiles(manifestQuery, "files(id,name,parents,createdTime,modifiedTime)"),
    ]);

    const manifestEntries = await Promise.all(
      (manifestResult.files || []).map(async (file) => {
        try { return { file, data: await fetchJsonFile(file.id) }; }
        catch (error) {
          note(`Could not read manifest ${file.id}: ${msg(error)}`);
          return { file, data: null };
        }
      }),
    );
    const manifestsByFolder = new Map();
    for (const entry of manifestEntries) {
      for (const parent of entry.file.parents || []) manifestsByFolder.set(parent, entry);
    }

    state.activities = (folderResult.files || [])
      .map((folder) => {
        const entry = manifestsByFolder.get(folder.id);
        return {
          folderId: folder.id,
          folderName: folder.name,
          driveUrl: folder.webViewLink || `https://drive.google.com/drive/folders/${folder.id}`,
          createdTime: folder.createdTime,
          modifiedTime: folder.modifiedTime,
          manifestFileId: entry?.file?.id || null,
          manifest: entry?.data || synthesizeManifest(folder),
        };
      })
      .sort((a, b) => activityTimestamp(b) - activityTimestamp(a));

    renderLibrary(state.activities);
    status(el.libraryStatus, `${state.activities.length} ${state.activities.length === 1 ? "activity" : "activities"}`, "good");
    note(`Loaded ${state.activities.length} uploaded activities from Drive.`);
  } catch (error) {
    status(el.libraryStatus, "Load failed", "bad");
    fail(error);
  } finally {
    el.refreshLibrary.disabled = false;
  }
}

function synthesizeManifest(folder) {
  const parts = folder.name.match(/^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})_([^_]+)/);
  const startTime = parts ? `${parts[1]}T${parts[2]}:${parts[3]}:00Z` : folder.createdTime;
  return {
    schemaVersion: 1,
    activityId: folder.name,
    folderId: folder.id,
    folderName: folder.name,
    uploadedAt: folder.createdTime,
    source: { fileName: folder.name },
    sport: parts?.[4] || folder.appProperties?.sport || "activity",
    subSport: null,
    startTime: folder.appProperties?.startTime || startTime,
    athleteNotes: "",
    summary: {},
    reviewed: false,
    reviewedAt: null,
    chatUrl: null,
  };
}

function activityTimestamp(activity) {
  const value = activity.manifest?.startTime || activity.createdTime;
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function renderLibrary(activities) {
  if (!activities.length) {
    el.activityList.innerHTML = '<p class="empty-state">No uploaded activities found yet.</p>';
    return;
  }

  el.activityList.innerHTML = activities.map((activity) => {
    const manifest = activity.manifest || {};
    const summary = manifest.summary || {};
    const started = manifest.startTime ? new Date(manifest.startTime) : null;
    const when = started && !Number.isNaN(started.getTime()) ? started.toLocaleString() : activity.folderName;
    const sport = [manifest.sport, manifest.subSport].filter(Boolean).join(" / ") || "activity";
    const sourceName = manifest.source?.fileName || manifest.activityId || activity.folderName;
    const reviewed = Boolean(manifest.reviewed || manifest.chatUrl);
    const chatUrl = manifest.chatUrl || "";
    const meta = [distance(summary.totalDistanceMeters), duration(summary.totalTimerTimeSeconds ?? summary.totalElapsedTimeSeconds)]
      .filter((value) => value && value !== "—")
      .join(" · ");

    return `<article class="activity-card" data-folder-id="${html(activity.folderId)}">
      <div class="activity-main">
        <div>
          <div class="activity-kicker">${html(sport)}</div>
          <h3>${html(when)}</h3>
          <p class="activity-source">${html(sourceName)}${meta ? ` · ${html(meta)}` : ""}</p>
        </div>
        <span class="review-state ${reviewed ? "reviewed" : "uploaded"}">${reviewed ? "Reviewed" : "Uploaded"}</span>
      </div>
      <div class="activity-links">
        <a href="${html(activity.driveUrl)}" target="_blank" rel="noopener">Open Drive folder</a>
        ${chatUrl ? `<a href="${html(chatUrl)}" target="_blank" rel="noopener">Open ChatGPT conversation</a>` : ""}
      </div>
      <div class="review-editor">
        <label class="review-check"><input type="checkbox" data-review-check ${reviewed ? "checked" : ""}/> Reviewed</label>
        <input type="text" data-chat-url value="${html(chatUrl)}" placeholder="Paste ChatGPT conversation URL" autocomplete="off" spellcheck="false" />
        <button type="button" class="secondary small" data-save-review>Save review link</button>
      </div>
    </article>`;
  }).join("");
}

async function handleLibraryClick(event) {
  const button = event.target.closest("[data-save-review]");
  if (!button) return;
  const card = button.closest("[data-folder-id]");
  const folderId = card?.dataset.folderId;
  const activity = state.activities.find((item) => item.folderId === folderId);
  if (!activity) return;

  const url = card.querySelector("[data-chat-url]").value.trim();
  const reviewed = card.querySelector("[data-review-check]").checked || Boolean(url);
  if (url && !isChatGptUrl(url)) {
    note("Please paste a valid https://chatgpt.com conversation URL.");
    card.querySelector("[data-chat-url]").focus();
    return;
  }

  button.disabled = true;
  button.textContent = "Saving...";
  try {
    const now = new Date().toISOString();
    const manifest = {
      ...activity.manifest,
      folderId: activity.folderId,
      folderName: activity.folderName,
      reviewed,
      reviewedAt: reviewed ? (activity.manifest?.reviewedAt || now) : null,
      chatUrl: url || null,
      updatedAt: now,
    };
    const blob = jsonBlob(manifest);
    if (activity.manifestFileId) {
      await updateFileMedia(activity.manifestFileId, blob, "application/json");
    } else {
      const file = await uploadFile(MANIFEST_NAME, blob, "application/json", activity.folderId, "activity-manifest");
      activity.manifestFileId = file.id;
    }
    activity.manifest = manifest;
    renderLibrary(state.activities);
    status(el.libraryStatus, `${state.activities.length} ${state.activities.length === 1 ? "activity" : "activities"}`, "good");
    note(`Saved review metadata for ${activity.folderName}.`);
  } catch (error) {
    fail(error);
    button.disabled = false;
    button.textContent = "Save review link";
  }
}

function isChatGptUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "chatgpt.com" || url.hostname.endsWith(".chatgpt.com") || url.hostname === "chat.openai.com");
  } catch {
    return false;
  }
}

async function findRoot(createIfMissing) {
  if (state.root) return state.root;
  const query = [
    `name='${driveEscape(ROOT)}'`,
    "mimeType='application/vnd.google-apps.folder'",
    "trashed=false",
    `appProperties has { key='app' and value='${APP}' }`,
  ].join(" and ");
  const result = await listDriveFiles(query, "files(id,name,webViewLink,createdTime,modifiedTime)");
  if (result.files?.[0]) {
    state.root = result.files[0];
    return state.root;
  }
  if (!createIfMissing) return null;
  note(`Creating Drive folder: ${ROOT}`);
  state.root = await createFolder(ROOT, null, { app: APP, artifactType: "root-folder" });
  return state.root;
}

async function listDriveFiles(query, fields) {
  return drive(`https://www.googleapis.com/drive/v3/files?spaces=drive&pageSize=1000&orderBy=modifiedTime%20desc&fields=${encodeURIComponent(fields)}&q=${encodeURIComponent(query)}`);
}

async function createFolder(name, parent, properties) {
  return drive("https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink,createdTime,modifiedTime", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      mimeType: "application/vnd.google-apps.folder",
      ...(parent ? { parents: [parent] } : {}),
      appProperties: properties,
    }),
  });
}

async function uploadFile(name, blob, type, parent, artifactType) {
  note(`Uploading ${name} (${bytes(blob.size)})...`);
  const metadata = await drive("https://www.googleapis.com/drive/v3/files?fields=id,name,parents,webViewLink", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      parents: [parent],
      mimeType: type,
      appProperties: { app: APP, artifactType },
    }),
  });
  await updateFileMedia(metadata.id, blob, type);
  return metadata;
}

async function updateFileMedia(fileId, blob, type) {
  return drive(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&fields=id,name,size,modifiedTime`, {
    method: "PATCH",
    headers: { "Content-Type": type },
    body: blob,
  });
}

async function fetchJsonFile(fileId) {
  return drive(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
}

async function drive(url, options = {}, retried = false) {
  await authorize(false);
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${state.token}`, ...(options.headers || {}) },
  });

  if (response.status === 401 && !retried) {
    state.token = null;
    state.tokenExpiresAt = 0;
    await authorize(false);
    return drive(url, options, true);
  }

  if (!response.ok) throw new Error(`Google Drive API ${response.status}: ${(await response.text()).slice(0, 1200)}`);
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

function folderName() {
  const summary = state.analysis.summary;
  const value = summary.startTime ? new Date(summary.startTime) : new Date(state.file.lastModified || Date.now());
  const dateValue = Number.isNaN(value.getTime()) ? new Date() : value;
  const stamp = dateValue.toISOString().slice(0, 16).replace("T", "_").replace(":", "-");
  return `${stamp}_${slug(summary.sport || "activity")}_${slug(state.file.name.replace(/\.fit$/i, ""))}`.slice(0, 170);
}

const analysisName = () => `${state.file?.name.replace(/\.fit$/i, "") || "activity"}.analysis.json`;
const fullName = () => `${state.file?.name.replace(/\.fit$/i, "") || "activity"}.decoded-full.json`;

function notesBlob() {
  const summary = state.analysis.summary;
  const notes = state.analysis.athleteNotes || "No subjective notes were entered.";
  return new Blob([
    [
      `# ${state.file.name}`,
      "",
      `- Sport: ${summary.sport}${summary.subSport ? ` / ${summary.subSport}` : ""}`,
      `- Start: ${summary.startTime || "unknown"}`,
      `- Source FIT integrity: ${summary.fitIntegrityPassed ? "passed" : "warning"}`,
      "",
      "## Athlete notes",
      "",
      notes,
      "",
      "## Suggested ChatGPT prompt",
      "",
      "Review this activity using my Iron Man Haines City project context. Start with the athlete notes, then evaluate execution, physiology, technique, and the next training decision.",
      "",
    ].join("\n"),
  ], { type: "text/markdown" });
}

const jsonBlob = (value) => new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });

function download(value, name) {
  if (!value) return;
  const url = URL.createObjectURL(jsonBlob(value));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const fileMeta = (file) => ({
  fileName: file.name,
  sizeBytes: file.size,
  lastModified: file.lastModified ? new Date(file.lastModified).toISOString() : null,
  mediaType: file.type || "application/octet-stream",
});

function status(node, text, kind) {
  node.textContent = text;
  node.className = `status ${kind}`;
}

function note(text) {
  const stamp = new Date().toLocaleTimeString();
  el.log.textContent = `${el.log.textContent ? `${el.log.textContent}\n` : ""}[${stamp}] ${text}`;
  el.log.scrollTop = el.log.scrollHeight;
}

function fail(error) {
  console.error(error);
  note(`ERROR: ${msg(error)}`);
}

const msg = (error) => error instanceof Error ? error.message : String(error);

function bytes(value) {
  if (!Number.isFinite(value)) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

function distance(meters) {
  if (meters == null) return "—";
  return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`;
}

function duration(seconds) {
  if (seconds == null) return "—";
  const value = Math.max(0, Math.round(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remaining = value % 60;
  return [hours, minutes, remaining].map((item, index) => index ? String(item).padStart(2, "0") : String(item)).join(":");
}

const pair = (a, b, suffix) => a == null && b == null ? "—" : `${a ?? "—"} / ${b ?? "—"}${suffix}`;
const slug = (value) => String(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "activity";
const driveEscape = (value) => String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const html = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
