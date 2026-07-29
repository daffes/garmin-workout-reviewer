import { Decoder, Stream } from "https://cdn.jsdelivr.net/npm/@garmin/fitsdk@21.208.0/src/index.js";
import JSZip from "https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm";

const CLIENT_ID = "876189937046-luqlkqg5vv7qjqa4srcudu9ie4u5q97g.apps.googleusercontent.com";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const ROOT = "Iron Man Training Data";
const APP = "garmin-workout-reviewer";
const MANIFEST_NAME = "activity-manifest.json";
const TOKEN_KEY = "gwr.drive.access-token.v1";
const CONNECTED_KEY = "gwr.drive.connected";
const TOKEN_MARGIN_MS = 60_000;
const PROJECT_URL = "https://chatgpt.com/g/g-p-6a5f5d0e62c08191ad5f73463e7a4e64-iron-man-haines-city/project";

const $ = (selector) => document.querySelector(selector);
const el = {
  connect: $("#connect-drive"),
  refresh: $("#refresh-library"),
  libraryStatus: $("#library-status"),
  list: $("#activity-list"),
  file: $("#fit-file"),
  fileName: $("#file-name"),
  notes: $("#athlete-notes"),
  parse: $("#parse-fit"),
  parseStatus: $("#parse-status"),
  upload: $("#upload-drive"),
  uploadStatus: $("#upload-status"),
  driveResult: $("#drive-result"),
  results: $("#results-panel"),
  integrity: $("#integrity-status"),
  grid: $("#summary-grid"),
  log: $("#log"),
  clear: $("#clear-log"),
};

const state = {
  sourceFile: null,
  fitFile: null,
  token: null,
  tokenExpiresAt: 0,
  tokenClient: null,
  tokenWaiter: null,
  full: null,
  analysis: null,
  root: null,
  activities: [],
  referencesPersisted: new Set(),
};

el.connect.addEventListener("click", () => connectDrive(true));
el.refresh.addEventListener("click", () => loadLibrary({ interactive: true }));
el.file.addEventListener("change", selectSourceFile);
el.parse.addEventListener("click", parseActivity);
el.upload.addEventListener("click", uploadPackage);
el.clear.addEventListener("click", () => { el.log.textContent = ""; });
el.list.addEventListener("click", handleActivityListClick);
el.list.addEventListener("keydown", handleActivityListKeydown);

boot();

async function boot() {
  note("Initializing application...");
  restoreCachedToken();
  await initTokenClient();

  if (hasUsableToken()) {
    setConnectedUi(true);
    note("Restored cached Drive access token.");
    await loadLibrary({ interactive: false });
  } else {
    setConnectedUi(false);
    status(el.libraryStatus, localStorage.getItem(CONNECTED_KEY) === "1" ? "Reconnect Drive" : "Connect Drive", "neutral");
  }
}

async function initTokenClient() {
  if (state.tokenClient) return;
  await waitForGoogleIdentity();
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
    el.connect.disabled = true;
    el.connect.textContent = "Connecting…";
    await authorize(interactive);
    setConnectedUi(true);
    localStorage.setItem(CONNECTED_KEY, "1");
    note("Google Drive connected.");
    await loadLibrary({ interactive: false });
  } catch (error) {
    setConnectedUi(false);
    fail(error);
  } finally {
    el.connect.disabled = false;
  }
}

async function authorize(interactive = false) {
  if (hasUsableToken()) return state.token;
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
    state.tokenClient.requestAccessToken({ prompt: interactive ? "" : "" });
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
  localStorage.setItem(TOKEN_KEY, JSON.stringify({
    accessToken: state.token,
    expiresAt: state.tokenExpiresAt,
    scope: response.scope || SCOPE,
  }));
  localStorage.setItem(CONNECTED_KEY, "1");
  const waiter = state.tokenWaiter;
  state.tokenWaiter = null;
  waiter?.resolve(state.token);
}

function rejectToken(error) {
  const waiter = state.tokenWaiter;
  state.tokenWaiter = null;
  waiter?.reject(error instanceof Error ? error : new Error(String(error)));
}

function restoreCachedToken() {
  try {
    const cached = JSON.parse(localStorage.getItem(TOKEN_KEY) || "null");
    if (!cached?.accessToken || !Number.isFinite(cached.expiresAt) || Date.now() >= cached.expiresAt - TOKEN_MARGIN_MS) {
      localStorage.removeItem(TOKEN_KEY);
      return;
    }
    state.token = cached.accessToken;
    state.tokenExpiresAt = cached.expiresAt;
  } catch {
    localStorage.removeItem(TOKEN_KEY);
  }
}

function clearToken() {
  state.token = null;
  state.tokenExpiresAt = 0;
  localStorage.removeItem(TOKEN_KEY);
  setConnectedUi(false);
}

function hasUsableToken() {
  return Boolean(state.token && Date.now() < state.tokenExpiresAt - TOKEN_MARGIN_MS);
}

function setConnectedUi(connected) {
  el.connect.textContent = connected ? "Drive connected" : (localStorage.getItem(CONNECTED_KEY) === "1" ? "Reconnect Drive" : "Connect Drive");
  el.connect.classList.toggle("connected", connected);
}

async function waitForGoogleIdentity() {
  const started = Date.now();
  while (!window.google?.accounts?.oauth2) {
    if (Date.now() - started > 12_000) throw new Error("Google Identity Services did not load.");
    await sleep(100);
  }
}

function selectSourceFile() {
  state.sourceFile = el.file.files?.[0] || null;
  state.fitFile = null;
  state.full = null;
  state.analysis = null;
  el.results.classList.add("hidden");
  el.upload.disabled = true;
  status(el.uploadStatus, "Parse first", "neutral");
  el.driveResult.textContent = "";

  if (!state.sourceFile) {
    el.fileName.textContent = "No file selected";
    el.parse.disabled = true;
    status(el.parseStatus, "Waiting for file", "neutral");
    return;
  }

  const supported = /\.(fit|zip)$/i.test(state.sourceFile.name);
  el.fileName.textContent = `${state.sourceFile.name} · ${bytes(state.sourceFile.size)}`;
  el.parse.disabled = !supported;
  status(el.parseStatus, supported ? "Ready to parse" : "Unsupported file", supported ? "good" : "bad");
}

async function parseActivity() {
  if (!state.sourceFile) return;
  el.parse.disabled = true;
  el.upload.disabled = true;
  el.results.classList.add("hidden");
  status(el.parseStatus, "Preparing file", "working");

  try {
    state.fitFile = await resolveFitFile(state.sourceFile);
    note(`Reading ${state.fitFile.name}...`);
    status(el.parseStatus, "Decoding FIT", "working");

    const stream = Stream.fromArrayBuffer(await state.fitFile.arrayBuffer());
    const decoder = new Decoder(stream);
    if (!decoder.isFIT()) throw new Error("The selected file does not contain a valid FIT activity.");

    let integrity = false;
    try { integrity = decoder.checkIntegrity(); }
    catch (error) { note(`Integrity check warning: ${message(error)}`); }

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
    const summary = summarize(messages, state.fitFile, integrity, errors);
    const athleteNotes = el.notes.value.trim();

    state.full = {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      source: sourceMetadata(),
      fitIntegrityPassed: integrity,
      decodeErrors: errors,
      athleteNotes,
      messages,
    };

    state.analysis = {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      purpose: "Analysis-ready Garmin FIT extraction for the Iron Man Haines City ChatGPT project",
      source: sourceMetadata(),
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
    status(el.parseStatus, "Decoded", "good");
    status(el.integrity, integrity ? "Integrity passed" : "Integrity warning", integrity ? "good" : "warn");
    status(el.uploadStatus, "Ready to upload", "good");
    el.upload.disabled = false;
    note(`Decoded ${summary.recordCount.toLocaleString()} records from ${state.fitFile.name}.`);
  } catch (error) {
    status(el.parseStatus, "Parse failed", "bad");
    status(el.uploadStatus, "Parse first", "neutral");
    fail(error);
  } finally {
    el.parse.disabled = !state.sourceFile;
  }
}

async function resolveFitFile(sourceFile) {
  if (/\.fit$/i.test(sourceFile.name)) return sourceFile;
  if (!/\.zip$/i.test(sourceFile.name)) throw new Error("Choose a .fit file or a .zip export containing a .fit file.");

  note(`Opening Garmin Connect ZIP export ${sourceFile.name}...`);
  const archive = await JSZip.loadAsync(sourceFile);
  const fitEntries = Object.values(archive.files)
    .filter((entry) => !entry.dir && /\.fit$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!fitEntries.length) throw new Error("The ZIP file does not contain a .fit activity.");
  if (fitEntries.length > 1) note(`ZIP contains ${fitEntries.length} FIT files; using ${fitEntries[0].name}.`);

  const blob = await fitEntries[0].async("blob");
  const extractedName = fitEntries[0].name.split("/").pop() || "activity.fit";
  return new File([blob], extractedName, { type: "application/octet-stream", lastModified: sourceFile.lastModified });
}

function summarize(messages, file, integrity, errors) {
  const sessions = group(messages, "session");
  const laps = group(messages, "lap");
  const records = group(messages, "record");
  const events = group(messages, "event");
  const lengths = group(messages, "length");
  const session = sessions[0] || {};
  const counts = Object.fromEntries(Object.entries(messages)
    .map(([key, value]) => [key, Array.isArray(value) ? value.length : value == null ? 0 : 1])
    .sort(([a], [b]) => a.localeCompare(b)));
  const fields = [...new Set(records.flatMap((record) => Object.keys(record || {})))].sort();

  return {
    sourceFile: file.name,
    sourceSizeBytes: file.size,
    fitIntegrityPassed: integrity,
    decodeErrorCount: errors.length,
    sport: first(session, ["sport"]) || first(group(messages, "sport")[0] || {}, ["sport"]) || "unknown",
    subSport: first(session, ["subSport", "sub_sport"]),
    startTime: isoDate(first(session, ["startTime", "start_time", "timestamp"])),
    totalElapsedTimeSeconds: number(first(session, ["totalElapsedTime", "total_elapsed_time"])),
    totalTimerTimeSeconds: number(first(session, ["totalTimerTime", "total_timer_time"])),
    totalDistanceMeters: number(first(session, ["totalDistance", "total_distance"])),
    totalAscentMeters: number(first(session, ["totalAscent", "total_ascent"])),
    avgHeartRate: number(first(session, ["avgHeartRate", "avg_heart_rate"])) ?? stats(records, ["heartRate", "heart_rate"]).avg,
    maxHeartRate: number(first(session, ["maxHeartRate", "max_heart_rate"])) ?? stats(records, ["heartRate", "heart_rate"]).max,
    avgPower: number(first(session, ["avgPower", "avg_power"])) ?? stats(records, ["power"]).avg,
    maxPower: number(first(session, ["maxPower", "max_power"])) ?? stats(records, ["power"]).max,
    normalizedPower: number(first(session, ["normalizedPower", "normalized_power"])),
    avgCadence: number(first(session, ["avgCadence", "avg_cadence"])) ?? stats(records, ["cadence"]).avg,
    recordCount: records.length,
    lapCount: laps.length,
    eventCount: events.length,
    lengthCount: lengths.length,
    recordFields: fields,
    messageGroupCounts: counts,
  };
}

function renderSummary(summary) {
  const metrics = [
    ["Sport", [summary.sport, summary.subSport].filter(Boolean).join(" / ")],
    ["Started", summary.startTime ? formatDateTime(summary.startTime) : "Unknown"],
    ["Distance", formatDistance(summary.totalDistanceMeters)],
    ["Timer time", formatDuration(summary.totalTimerTimeSeconds ?? summary.totalElapsedTimeSeconds)],
    ["Records", summary.recordCount.toLocaleString()],
    ["Laps", summary.lapCount.toLocaleString()],
    ["Avg / max HR", pair(summary.avgHeartRate, summary.maxHeartRate, " bpm")],
    ["Avg / NP", pair(summary.avgPower, summary.normalizedPower, " W")],
  ];
  el.grid.innerHTML = metrics.map(([label, value]) => `<div class="metric"><span class="metric-label">${html(label)}</span><span class="metric-value">${html(value || "—")}</span></div>`).join("");
}

async function uploadPackage() {
  if (!state.analysis || !state.full || !state.fitFile || !state.sourceFile) {
    note("Parse an activity first.");
    return;
  }

  el.upload.disabled = true;
  el.parse.disabled = true;
  status(el.uploadStatus, "Uploading", "working");
  el.driveResult.textContent = "";

  try {
    await authorize(true);
    setConnectedUi(true);
    const root = await findRoot(true);
    const summary = state.analysis.summary;
    const folder = await createFolder(folderName(), root.id, {
      app: APP,
      artifactType: "activity-folder",
      sport: String(summary.sport || "unknown").slice(0, 120),
      startTime: String(summary.startTime || "").slice(0, 120),
    });
    const referenceId = makeReferenceId(folder.id);
    await patchFileMetadata(folder.id, { appProperties: { ...folder.appProperties, app: APP, artifactType: "activity-folder", referenceId, sport: String(summary.sport || "unknown").slice(0, 120), startTime: String(summary.startTime || "").slice(0, 120) } });

    const manifest = {
      schemaVersion: 2,
      activityId: state.fitFile.name.replace(/\.fit$/i, ""),
      referenceId,
      folderId: folder.id,
      folderName: folder.name,
      uploadedAt: new Date().toISOString(),
      source: sourceMetadata(),
      sport: summary.sport,
      subSport: summary.subSport,
      startTime: summary.startTime,
      athleteNotes: state.analysis.athleteNotes || "",
      summary: compactSummary(summary),
      reviewed: false,
      reviewedAt: null,
      chatUrl: null,
    };

    const artifacts = [
      uploadFile(state.sourceFile.name, state.sourceFile, mimeForSource(state.sourceFile), folder.id, "original-source", referenceId),
      uploadFile(analysisName(), jsonBlob(state.analysis), "application/json", folder.id, "analysis-json", referenceId),
      uploadFile(fullName(), jsonBlob(state.full), "application/json", folder.id, "decoded-full-json", referenceId),
      uploadFile("athlete-notes.md", notesBlob(referenceId), "text/markdown", folder.id, "athlete-notes", referenceId),
      uploadFile(MANIFEST_NAME, jsonBlob(manifest), "application/json", folder.id, "activity-manifest", referenceId),
    ];
    if (state.sourceFile.name !== state.fitFile.name) {
      artifacts.push(uploadFile(state.fitFile.name, state.fitFile, "application/octet-stream", folder.id, "extracted-fit", referenceId));
    }

    note(`Uploading ${artifacts.length} files in parallel...`);
    await Promise.all(artifacts);

    const url = `https://drive.google.com/drive/folders/${folder.id}`;
    el.driveResult.innerHTML = `Saved as <strong>${html(referenceId)}</strong>: <a href="${url}" target="_blank" rel="noopener">open Drive folder</a>`;
    status(el.uploadStatus, "Saved to Drive", "good");
    note(`Upload complete: ${referenceId}`);
    await loadLibrary({ interactive: false });
  } catch (error) {
    status(el.uploadStatus, "Upload failed", "bad");
    fail(error);
  } finally {
    el.parse.disabled = !state.sourceFile;
    el.upload.disabled = !state.analysis;
  }
}

async function loadLibrary({ interactive = false } = {}) {
  if (!hasUsableToken()) {
    if (!interactive) {
      status(el.libraryStatus, localStorage.getItem(CONNECTED_KEY) === "1" ? "Reconnect Drive" : "Connect Drive", "neutral");
      renderLibrary([]);
      return;
    }
    await authorize(true);
    setConnectedUi(true);
  }

  el.refresh.disabled = true;
  status(el.libraryStatus, "Loading", "working");
  try {
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
      listDriveFiles(manifestQuery, "files(id,name,parents,createdTime,modifiedTime,appProperties)"),
    ]);

    const manifestEntries = await Promise.all((manifestResult.files || []).map(async (file) => {
      try { return { file, data: await fetchJsonFile(file.id) }; }
      catch (error) {
        note(`Could not read manifest ${file.id}: ${message(error)}`);
        return { file, data: null };
      }
    }));
    const manifestsByFolder = new Map();
    for (const entry of manifestEntries) {
      for (const parent of entry.file.parents || []) manifestsByFolder.set(parent, entry);
    }

    state.activities = (folderResult.files || []).map((folder) => {
      const entry = manifestsByFolder.get(folder.id);
      const referenceId = entry?.data?.referenceId || folder.appProperties?.referenceId || makeReferenceId(folder.id);
      return {
        folderId: folder.id,
        folderName: folder.name,
        driveUrl: folder.webViewLink || `https://drive.google.com/drive/folders/${folder.id}`,
        createdTime: folder.createdTime,
        modifiedTime: folder.modifiedTime,
        referenceId,
        manifestFileId: entry?.file?.id || null,
        manifest: { ...(entry?.data || synthesizeManifest(folder)), referenceId },
      };
    }).sort((a, b) => activityTimestamp(b) - activityTimestamp(a));

    renderLibrary(state.activities);
    status(el.libraryStatus, `${state.activities.length} ${state.activities.length === 1 ? "activity" : "activities"}`, "good");
    note(`Loaded ${state.activities.length} activities from Drive.`);

    for (const activity of state.activities) persistReference(activity).catch((error) => note(`Reference sync warning for ${activity.referenceId}: ${message(error)}`));
  } catch (error) {
    status(el.libraryStatus, "Load failed", "bad");
    if (String(error).includes("401")) clearToken();
    fail(error);
  } finally {
    el.refresh.disabled = false;
  }
}

function renderLibrary(activities) {
  if (!activities.length) {
    el.list.innerHTML = '<p class="empty-state">No uploaded activities found.</p>';
    return;
  }

  el.list.innerHTML = activities.map((activity) => {
    const manifest = activity.manifest || {};
    const summary = manifest.summary || {};
    const start = manifest.startTime || activity.createdTime;
    const when = start ? formatDateTime(start) : "Unknown";
    const sport = [manifest.sport, manifest.subSport].filter(Boolean).join(" / ") || "activity";
    const title = [formatDistance(summary.totalDistanceMeters), formatDuration(summary.totalTimerTimeSeconds ?? summary.totalElapsedTimeSeconds)]
      .filter((value) => value && value !== "—").join(" · ") || manifest.source?.fitFileName || manifest.source?.fileName || activity.folderName;
    const reviewed = Boolean(manifest.reviewed || manifest.chatUrl);
    const chatUrl = manifest.chatUrl || "";

    return `<article class="activity-row" tabindex="0" role="button" aria-expanded="false" data-folder-id="${html(activity.folderId)}">
      <time class="activity-when" datetime="${html(start || "")}">${html(when)}</time>
      <div class="activity-summary">
        <button type="button" class="activity-reference" data-copy-reference="${html(activity.referenceId)}" title="Copy activity ID">${html(activity.referenceId)}</button>
        <span class="activity-sport">${html(sport)}</span>
        <span class="activity-title">${html(title)}</span>
      </div>
      <div class="activity-links">
        <a href="${html(activity.driveUrl)}" target="_blank" rel="noopener">Drive</a>
        ${chatUrl ? `<a href="${html(chatUrl)}" target="_blank" rel="noopener">ChatGPT</a>` : ""}
      </div>
      <div class="review-editor">
        <label class="review-check"><input type="checkbox" data-review-check ${reviewed ? "checked" : ""}/> Reviewed</label>
        <input type="text" data-chat-url value="${html(chatUrl)}" placeholder="Paste ChatGPT conversation URL" autocomplete="off" spellcheck="false" />
        <button type="button" class="secondary small" data-start-review>Start ChatGPT review</button>
        <button type="button" class="secondary small" data-save-review>Save link</button>
      </div>
    </article>`;
  }).join("");
}

async function handleActivityListClick(event) {
  const copy = event.target.closest("[data-copy-reference]");
  if (copy) {
    event.preventDefault();
    event.stopPropagation();
    await copyText(copy.dataset.copyReference, copy);
    return;
  }

  const row = event.target.closest(".activity-row");
  if (!row) return;

  if (event.target.closest("[data-start-review]")) {
    event.preventDefault();
    event.stopPropagation();
    const activity = activityForRow(row);
    if (activity) await startChatGptReview(activity);
    return;
  }

  if (event.target.closest("[data-save-review]")) {
    event.preventDefault();
    event.stopPropagation();
    await saveReviewLink(row);
    return;
  }

  if (event.target.closest("a,input,label,button")) return;
  toggleActivityRow(row);
}

function handleActivityListKeydown(event) {
  if (event.target.closest("a,input,button")) return;
  const row = event.target.closest(".activity-row");
  if (!row || !["Enter", " "].includes(event.key)) return;
  event.preventDefault();
  toggleActivityRow(row);
}

function toggleActivityRow(row) {
  const expanded = !row.classList.contains("expanded");
  row.classList.toggle("expanded", expanded);
  row.setAttribute("aria-expanded", String(expanded));
  if (expanded) row.querySelector("[data-chat-url]")?.focus();
}

async function startChatGptReview(activity) {
  const prompt = `Please review this new activity: ${activity.referenceId}`;
  const copied = await copyText(prompt);
  window.open(PROJECT_URL, "_blank", "noopener");
  note(copied
    ? `Opened Iron Man Haines City and copied: ${prompt}`
    : `Opened Iron Man Haines City. Use this prompt: ${prompt}`);
}

async function saveReviewLink(row) {
  const activity = activityForRow(row);
  if (!activity) return;
  const button = row.querySelector("[data-save-review]");
  const url = row.querySelector("[data-chat-url]").value.trim();
  const reviewed = row.querySelector("[data-review-check]").checked || Boolean(url);

  if (url && !isChatGptUrl(url)) {
    note("Please paste a valid ChatGPT conversation URL.");
    row.querySelector("[data-chat-url]").focus();
    return;
  }

  button.disabled = true;
  button.textContent = "Saving…";
  try {
    const now = new Date().toISOString();
    const manifest = {
      ...activity.manifest,
      referenceId: activity.referenceId,
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
      const file = await uploadFile(MANIFEST_NAME, blob, "application/json", activity.folderId, "activity-manifest", activity.referenceId);
      activity.manifestFileId = file.id;
    }
    activity.manifest = manifest;
    renderLibrary(state.activities);
    note(`Saved ChatGPT review link for ${activity.referenceId}.`);
  } catch (error) {
    fail(error);
    button.disabled = false;
    button.textContent = "Save link";
  }
}

function activityForRow(row) {
  return state.activities.find((activity) => activity.folderId === row.dataset.folderId);
}

async function persistReference(activity) {
  if (state.referencesPersisted.has(activity.folderId)) return;
  state.referencesPersisted.add(activity.folderId);
  try {
    await patchFileMetadata(activity.folderId, {
      appProperties: {
        app: APP,
        artifactType: "activity-folder",
        referenceId: activity.referenceId,
        sport: String(activity.manifest?.sport || "activity").slice(0, 120),
        startTime: String(activity.manifest?.startTime || "").slice(0, 120),
      },
    });

    if (activity.manifestFileId && activity.manifest?.referenceId !== activity.referenceId) {
      const manifest = { ...activity.manifest, referenceId: activity.referenceId, updatedAt: new Date().toISOString() };
      await updateFileMedia(activity.manifestFileId, jsonBlob(manifest), "application/json");
      activity.manifest = manifest;
    }
  } catch (error) {
    state.referencesPersisted.delete(activity.folderId);
    throw error;
  }
}

function synthesizeManifest(folder) {
  const parts = folder.name.match(/^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})_([^_]+)/);
  const startTime = parts ? `${parts[1]}T${parts[2]}:${parts[3]}:00Z` : folder.createdTime;
  return {
    schemaVersion: 2,
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

async function findRoot(createIfMissing) {
  if (state.root) return state.root;
  const query = [
    `name='${driveEscape(ROOT)}'`,
    "mimeType='application/vnd.google-apps.folder'",
    "trashed=false",
    `appProperties has { key='app' and value='${APP}' }`,
  ].join(" and ");
  const result = await listDriveFiles(query, "files(id,name,webViewLink,createdTime,modifiedTime,appProperties)");
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
  return drive("https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink,createdTime,modifiedTime,appProperties", {
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

async function uploadFile(name, blob, type, parent, artifactType, referenceId) {
  note(`Uploading ${name} (${bytes(blob.size)})...`);
  const metadata = await drive("https://www.googleapis.com/drive/v3/files?fields=id,name,parents,webViewLink", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      parents: [parent],
      mimeType: type,
      appProperties: { app: APP, artifactType, referenceId },
    }),
  });
  await updateFileMedia(metadata.id, blob, type);
  return metadata;
}

async function updateFileMedia(fileId, blob, type) {
  return drive(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id,name,size,modifiedTime`, {
    method: "PATCH",
    headers: { "Content-Type": type },
    body: blob,
  });
}

async function patchFileMetadata(fileId, metadata) {
  return drive(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,appProperties`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(metadata),
  });
}

async function fetchJsonFile(fileId) {
  return drive(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`);
}

async function drive(url, options = {}, retried = false) {
  if (!hasUsableToken()) throw new Error("Drive connection expired. Click Reconnect Drive.");
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${state.token}`, ...(options.headers || {}) },
  });

  if (response.status === 401 && !retried) {
    clearToken();
    throw new Error("Drive connection expired. Click Reconnect Drive.");
  }
  if (!response.ok) throw new Error(`Google Drive API ${response.status}: ${(await response.text()).slice(0, 1000)}`);
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

function folderName() {
  const summary = state.analysis.summary;
  const value = summary.startTime ? new Date(summary.startTime) : new Date(state.fitFile.lastModified || Date.now());
  const dateValue = Number.isNaN(value.getTime()) ? new Date() : value;
  const stamp = dateValue.toISOString().slice(0, 16).replace("T", "_").replace(":", "-");
  return `${stamp}_${slug(summary.sport || "activity")}_${slug(state.fitFile.name.replace(/\.fit$/i, ""))}`.slice(0, 170);
}

function sourceMetadata() {
  return {
    sourceFileName: state.sourceFile?.name || null,
    sourceSizeBytes: state.sourceFile?.size || null,
    sourceMediaType: state.sourceFile?.type || mimeForSource(state.sourceFile),
    fitFileName: state.fitFile?.name || null,
    fitSizeBytes: state.fitFile?.size || null,
    archiveUsed: Boolean(state.sourceFile && state.fitFile && state.sourceFile.name !== state.fitFile.name),
    lastModified: state.sourceFile?.lastModified ? new Date(state.sourceFile.lastModified).toISOString() : null,
  };
}

function notesBlob(referenceId) {
  const summary = state.analysis.summary;
  const notes = state.analysis.athleteNotes || "No subjective notes were entered.";
  return new Blob([[
    `# ${state.fitFile.name}`,
    "",
    `- Activity ID: ${referenceId}`,
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
    `Please review this new activity: ${referenceId}`,
    "",
  ].join("\n")], { type: "text/markdown" });
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

function activityTimestamp(activity) {
  const parsed = new Date(activity.manifest?.startTime || activity.createdTime || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function group(messages, name) {
  const normalized = normalize(name);
  const hit = Object.entries(messages).find(([key]) => normalize(key).replace(/mesgs$|messages$|message$/g, "") === normalized);
  return hit ? (Array.isArray(hit[1]) ? hit[1] : [hit[1]]) : [];
}

function first(object, keys) {
  for (const key of keys) if (object?.[key] !== undefined && object[key] !== null) return object[key];
  return null;
}

function number(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function stats(records, keys) {
  const values = records.map((record) => number(first(record, keys))).filter((value) => value !== null);
  if (!values.length) return { avg: null, max: null };
  return { avg: Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10, max: Math.max(...values) };
}

function isoDate(value) {
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

function makeReferenceId(folderId) {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let hash = 14695981039346656037n;
  for (const character of folderId) {
    hash ^= BigInt(character.codePointAt(0));
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  let code = "";
  for (let index = 0; index < 8; index += 1) {
    code = alphabet[Number(hash & 31n)] + code;
    hash >>= 5n;
  }
  return `GWR-${code}`;
}

async function copyText(text, feedbackNode = null) {
  try {
    await navigator.clipboard.writeText(text);
    if (feedbackNode) {
      const original = feedbackNode.textContent;
      feedbackNode.textContent = "Copied";
      setTimeout(() => { feedbackNode.textContent = original; }, 900);
    }
    return true;
  } catch {
    return false;
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

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

function formatDistance(meters) {
  if (meters == null) return "—";
  return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`;
}

function formatDuration(seconds) {
  if (seconds == null) return "—";
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  return [hours, minutes, remaining].map((item, index) => index ? String(item).padStart(2, "0") : String(item)).join(":");
}

function analysisName() { return `${state.fitFile?.name.replace(/\.fit$/i, "") || "activity"}.analysis.json`; }
function fullName() { return `${state.fitFile?.name.replace(/\.fit$/i, "") || "activity"}.decoded-full.json`; }
function jsonBlob(value) { return new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }); }
function mimeForSource(file) { return /\.zip$/i.test(file?.name || "") ? "application/zip" : "application/octet-stream"; }
function pair(a, b, suffix) { return a == null && b == null ? "—" : `${a ?? "—"} / ${b ?? "—"}${suffix}`; }
function normalize(value) { return String(value).replace(/[^a-z0-9]/gi, "").toLowerCase(); }
function slug(value) { return String(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "activity"; }
function driveEscape(value) { return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'"); }
function html(value) { return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;"); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function message(error) { return error instanceof Error ? error.message : String(error); }

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
  note(`ERROR: ${message(error)}`);
}

function bytes(value) {
  if (!Number.isFinite(value)) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}
