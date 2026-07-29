const INDEX_NAME = "activity-index.json";
const APP = "garmin-workout-reviewer";
const TOKEN_KEY = "gwr.drive.access-token.v1";
const PSEUDO_PREFIX = "gwr-index-manifest:";
const nativeFetch = window.fetch.bind(window);

let rootId = null;
let indexFileId = null;
let indexCache = null;
let indexPromise = null;
let writeQueue = Promise.resolve();
const manifestIds = new Set();
const pendingManifestParents = new Map();

window.fetch = async (input, init = {}) => {
  const url = requestUrl(input);
  const method = String(init?.method || "GET").toUpperCase();

  if (method === "GET" && isDriveFileList(url)) {
    const query = driveQuery(url);

    if (isRootFolderQuery(query)) {
      const response = await nativeFetch(input, init);
      await captureRoot(response);
      return response;
    }

    if (isActivityFolderQuery(query)) {
      const index = await ensureIndex(authToken(init));
      return jsonResponse({ files: index.activities.map(folderFileFromEntry) });
    }

    if (isActivityManifestQuery(query)) {
      const index = await ensureIndex(authToken(init));
      return jsonResponse({ files: index.activities.map(manifestFileFromEntry) });
    }
  }

  const mediaReadId = driveMediaReadId(url, method);
  if (mediaReadId?.startsWith(PSEUDO_PREFIX)) {
    const folderId = decodeURIComponent(mediaReadId.slice(PSEUDO_PREFIX.length));
    const index = await ensureIndex(authToken(init));
    const entry = index.activities.find((item) => item.folderId === folderId);
    if (!entry) return jsonResponse({ error: "Indexed activity not found" }, 404);
    return jsonResponse(entry.manifest || synthesizeManifest(entry));
  }

  if (isDriveMetadataCreate(url, init)) {
    const metadata = parseJsonBody(init.body);
    if (metadata?.appProperties?.artifactType === "root-folder") {
      const response = await nativeFetch(input, init);
      if (response.ok) {
        const created = await response.clone().json().catch(() => null);
        if (created?.id) rootId = String(created.id);
      }
      return response;
    }

    if (metadata?.appProperties?.artifactType === "activity-manifest") {
      const response = await nativeFetch(input, init);
      if (response.ok) {
        const created = await response.clone().json().catch(() => null);
        if (created?.id) {
          manifestIds.add(String(created.id));
          pendingManifestParents.set(String(created.id), metadata.parents?.[0] || null);
        }
      }
      return response;
    }
  }

  const uploadId = mediaUploadFileId(url, method);
  if (uploadId?.startsWith(PSEUDO_PREFIX)) {
    const folderId = decodeURIComponent(uploadId.slice(PSEUDO_PREFIX.length));
    const manifest = await parseBodyJson(init.body);
    if (!manifest) return jsonResponse({ error: "Invalid activity manifest" }, 400);
    return updateManifestThroughIndex(folderId, manifest, init);
  }

  if (uploadId && (manifestIds.has(uploadId) || pendingManifestParents.has(uploadId))) {
    const response = await nativeFetch(input, init);
    if (response.ok) {
      const manifest = await parseBodyJson(init.body);
      if (manifest) {
        const parentId = manifest.folderId || pendingManifestParents.get(uploadId) || null;
        await upsertManifest(manifest, uploadId, parentId, authToken(init));
      }
    }
    return response;
  }

  if (isTrashPatch(url, init)) {
    const response = await nativeFetch(input, init);
    if (response.ok) {
      const folderId = driveMetadataFileId(url);
      if (folderId) await removeActivity(folderId, authToken(init));
    }
    return response;
  }

  return nativeFetch(input, init);
};

async function captureRoot(response) {
  if (!response.ok) return;
  const data = await response.clone().json().catch(() => null);
  const id = data?.files?.[0]?.id;
  if (id && id !== rootId) {
    rootId = String(id);
    indexCache = null;
    indexFileId = null;
    indexPromise = null;
  }
}

async function ensureIndex(token) {
  if (indexCache) return indexCache;
  if (indexPromise) return indexPromise;
  if (!rootId) throw new Error("The Iron Man Training Data folder has not been resolved yet.");

  const accessToken = token || readToken();
  if (!accessToken) throw new Error("Reconnect Google Drive to load the activity index.");

  indexPromise = loadOrRebuildIndex(accessToken)
    .finally(() => { indexPromise = null; });
  return indexPromise;
}

async function loadOrRebuildIndex(token) {
  const query = [
    `name='${driveEscape(INDEX_NAME)}'`,
    `'${driveEscape(rootId)}' in parents`,
    "trashed=false",
  ].join(" and ");
  const listed = await driveJson(
    `https://www.googleapis.com/drive/v3/files?spaces=drive&pageSize=10&fields=${encodeURIComponent("files(id,name,modifiedTime,appProperties)")}&q=${encodeURIComponent(query)}`,
    token,
  );
  const file = listed.files?.[0] || null;

  if (file?.id) {
    try {
      const parsed = await driveJson(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`,
        token,
      );
      if (isValidIndex(parsed)) {
        indexFileId = String(file.id);
        indexCache = normalizeIndex(parsed);
        seedManifestIds(indexCache);
        appendLog(`Loaded activity index (${indexCache.activities.length} activities).`);
        return indexCache;
      }
    } catch (error) {
      appendLog(`Activity index could not be read; rebuilding it. ${errorMessage(error)}`);
    }
  }

  indexFileId = file?.id ? String(file.id) : null;
  return rebuildIndex(token);
}

async function rebuildIndex(token) {
  appendLog("Building activity-index.json from existing activity manifests…");

  const folderQuery = [
    `'${driveEscape(rootId)}' in parents`,
    "mimeType='application/vnd.google-apps.folder'",
    "trashed=false",
    `appProperties has { key='app' and value='${APP}' }`,
    "appProperties has { key='artifactType' and value='activity-folder' }",
  ].join(" and ");
  const manifestQuery = [
    "name='activity-manifest.json'",
    "trashed=false",
    `appProperties has { key='app' and value='${APP}' }`,
    "appProperties has { key='artifactType' and value='activity-manifest' }",
  ].join(" and ");

  const [folderResult, manifestResult] = await Promise.all([
    driveJson(`https://www.googleapis.com/drive/v3/files?spaces=drive&pageSize=1000&orderBy=modifiedTime%20desc&fields=${encodeURIComponent("files(id,name,createdTime,modifiedTime,webViewLink,appProperties)")}&q=${encodeURIComponent(folderQuery)}`, token),
    driveJson(`https://www.googleapis.com/drive/v3/files?spaces=drive&pageSize=1000&orderBy=modifiedTime%20desc&fields=${encodeURIComponent("files(id,name,parents,createdTime,modifiedTime,appProperties)")}&q=${encodeURIComponent(manifestQuery)}`, token),
  ]);

  const manifestFiles = manifestResult.files || [];
  const hydrated = await mapLimit(manifestFiles, 8, async (file) => {
    try {
      const manifest = await driveJson(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`,
        token,
      );
      return { file, manifest };
    } catch (error) {
      appendLog(`Skipped unreadable manifest ${file.id}: ${errorMessage(error)}`);
      return { file, manifest: null };
    }
  });

  const byFolder = new Map();
  for (const item of hydrated) {
    for (const parent of item.file.parents || []) byFolder.set(parent, item);
  }

  const activities = (folderResult.files || []).map((folder) => {
    const indexedManifest = byFolder.get(folder.id);
    const manifest = indexedManifest?.manifest || synthesizeManifest({
      folderId: folder.id,
      folderName: folder.name,
      createdTime: folder.createdTime,
      modifiedTime: folder.modifiedTime,
      referenceId: folder.appProperties?.referenceId,
      driveUrl: folder.webViewLink,
      sport: folder.appProperties?.sport,
      startTime: folder.appProperties?.startTime,
    });
    return normalizeEntry({
      folderId: folder.id,
      folderName: folder.name,
      driveUrl: folder.webViewLink || `https://drive.google.com/drive/folders/${folder.id}`,
      createdTime: folder.createdTime,
      modifiedTime: folder.modifiedTime,
      referenceId: manifest.referenceId || folder.appProperties?.referenceId || null,
      manifestFileId: indexedManifest?.file?.id || null,
      manifest,
      appProperties: folder.appProperties || {},
    });
  });

  indexCache = normalizeIndex({ schemaVersion: 1, updatedAt: new Date().toISOString(), activities });
  seedManifestIds(indexCache);
  await saveIndex(token);
  appendLog(`Built activity index (${indexCache.activities.length} activities).`);
  return indexCache;
}

async function updateManifestThroughIndex(folderId, manifest, init) {
  const token = authToken(init) || readToken();
  const index = await ensureIndex(token);
  let entry = index.activities.find((item) => item.folderId === folderId);
  let response;

  if (entry?.manifestFileId) {
    response = await nativeFetch(
      `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(entry.manifestFileId)}?uploadType=media&fields=id,name,size,modifiedTime`,
      { ...init, method: "PATCH" },
    );
  } else {
    const created = await createManifestFile(folderId, manifest, token);
    entry = entry || normalizeEntry({ folderId, manifest, folderName: manifest.folderName });
    entry.manifestFileId = created.id;
    manifestIds.add(String(created.id));
    response = jsonResponse(created);
  }

  if (response.ok) await upsertManifest(manifest, entry?.manifestFileId || null, folderId, token);
  return response;
}

async function createManifestFile(folderId, manifest, token) {
  const metadata = await driveJson("https://www.googleapis.com/drive/v3/files?fields=id,name,parents", token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "activity-manifest.json",
      parents: [folderId],
      mimeType: "application/json",
      appProperties: {
        app: APP,
        artifactType: "activity-manifest",
        referenceId: manifest.referenceId || "",
      },
    }),
  });
  await driveJson(
    `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(metadata.id)}?uploadType=media&fields=id,name,size,modifiedTime`,
    token,
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: jsonBlob(manifest) },
  );
  return metadata;
}

async function upsertManifest(manifest, manifestFileId, parentId, token) {
  return enqueueWrite(async () => {
    const index = await ensureIndex(token);
    const folderId = manifest.folderId || parentId;
    if (!folderId) return;

    const existing = index.activities.find((item) => item.folderId === folderId);
    const entry = normalizeEntry({
      ...(existing || {}),
      folderId,
      folderName: manifest.folderName || existing?.folderName,
      driveUrl: existing?.driveUrl || `https://drive.google.com/drive/folders/${folderId}`,
      createdTime: existing?.createdTime || manifest.uploadedAt || manifest.startTime || new Date().toISOString(),
      modifiedTime: new Date().toISOString(),
      referenceId: manifest.referenceId || existing?.referenceId || null,
      manifestFileId: manifestFileId || existing?.manifestFileId || null,
      manifest,
    });

    const next = index.activities.filter((item) => item.folderId !== folderId);
    next.push(entry);
    index.activities = sortActivities(next);
    if (entry.manifestFileId) manifestIds.add(String(entry.manifestFileId));
    await saveIndex(token);
  });
}

async function removeActivity(folderId, token) {
  return enqueueWrite(async () => {
    const index = await ensureIndex(token);
    const before = index.activities.length;
    index.activities = index.activities.filter((item) => item.folderId !== folderId);
    if (index.activities.length !== before) await saveIndex(token);
  });
}

function enqueueWrite(task) {
  writeQueue = writeQueue.then(task, task);
  return writeQueue;
}

async function saveIndex(token) {
  if (!indexCache) return;
  indexCache.updatedAt = new Date().toISOString();
  indexCache.activities = sortActivities(indexCache.activities.map(normalizeEntry));
  const body = jsonBlob(indexCache);

  if (!indexFileId) {
    const created = await driveJson("https://www.googleapis.com/drive/v3/files?fields=id,name,parents", token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: INDEX_NAME,
        parents: [rootId],
        mimeType: "application/json",
        appProperties: { app: APP, artifactType: "activity-index" },
      }),
    });
    indexFileId = String(created.id);
  }

  const response = await nativeFetch(
    `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(indexFileId)}?uploadType=media&fields=id,name,size,modifiedTime`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body,
    },
  );
  if (!response.ok) throw new Error(`Could not save activity index: Google Drive API ${response.status}`);
}

function folderFileFromEntry(entry) {
  return {
    id: entry.folderId,
    name: entry.folderName,
    createdTime: entry.createdTime,
    modifiedTime: entry.modifiedTime,
    webViewLink: entry.driveUrl || `https://drive.google.com/drive/folders/${entry.folderId}`,
    appProperties: {
      app: APP,
      artifactType: "activity-folder",
      referenceId: entry.referenceId || "",
      sport: entry.manifest?.sport || entry.appProperties?.sport || "activity",
      startTime: entry.manifest?.startTime || entry.appProperties?.startTime || "",
    },
  };
}

function manifestFileFromEntry(entry) {
  return {
    id: `${PSEUDO_PREFIX}${encodeURIComponent(entry.folderId)}`,
    name: "activity-manifest.json",
    parents: [entry.folderId],
    createdTime: entry.createdTime,
    modifiedTime: entry.modifiedTime,
    appProperties: {
      app: APP,
      artifactType: "activity-manifest",
      referenceId: entry.referenceId || "",
    },
  };
}

function normalizeIndex(value) {
  return {
    schemaVersion: 1,
    updatedAt: value?.updatedAt || new Date().toISOString(),
    activities: sortActivities((value?.activities || []).map(normalizeEntry)),
  };
}

function normalizeEntry(value) {
  const manifest = value?.manifest || {};
  const folderId = String(value?.folderId || manifest.folderId || "");
  return {
    folderId,
    folderName: value?.folderName || manifest.folderName || folderId,
    driveUrl: value?.driveUrl || (folderId ? `https://drive.google.com/drive/folders/${folderId}` : ""),
    createdTime: value?.createdTime || manifest.uploadedAt || manifest.startTime || new Date().toISOString(),
    modifiedTime: value?.modifiedTime || manifest.updatedAt || manifest.uploadedAt || new Date().toISOString(),
    referenceId: value?.referenceId || manifest.referenceId || null,
    manifestFileId: value?.manifestFileId || null,
    manifest: { ...manifest, folderId, folderName: value?.folderName || manifest.folderName || folderId },
    appProperties: value?.appProperties || {},
  };
}

function synthesizeManifest(entry) {
  return {
    schemaVersion: 2,
    activityId: entry.folderName || entry.folderId,
    referenceId: entry.referenceId || null,
    folderId: entry.folderId,
    folderName: entry.folderName || entry.folderId,
    uploadedAt: entry.createdTime || new Date().toISOString(),
    source: { fileName: entry.folderName || entry.folderId },
    sport: entry.sport || entry.appProperties?.sport || "activity",
    subSport: null,
    startTime: entry.startTime || entry.appProperties?.startTime || entry.createdTime || null,
    athleteNotes: "",
    summary: {},
    reviewed: false,
    reviewedAt: null,
    chatUrl: null,
  };
}

function seedManifestIds(index) {
  manifestIds.clear();
  for (const entry of index.activities) {
    if (entry.manifestFileId) manifestIds.add(String(entry.manifestFileId));
  }
}

function sortActivities(activities) {
  return [...activities].sort((a, b) => activityTime(b) - activityTime(a));
}

function activityTime(entry) {
  const value = entry.manifest?.startTime || entry.createdTime || entry.modifiedTime;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function isValidIndex(value) {
  return value && Number(value.schemaVersion) >= 1 && Array.isArray(value.activities);
}

function isDriveFileList(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin === "https://www.googleapis.com" && parsed.pathname === "/drive/v3/files";
  } catch {
    return false;
  }
}

function driveQuery(url) {
  try { return new URL(url).searchParams.get("q") || ""; }
  catch { return ""; }
}

function isRootFolderQuery(query) {
  return query.includes("Iron Man Training Data")
    && query.includes("mimeType='application/vnd.google-apps.folder'")
    && !query.includes("activity-folder");
}

function isActivityFolderQuery(query) {
  return query.includes("artifactType") && query.includes("activity-folder");
}

function isActivityManifestQuery(query) {
  return query.includes("activity-manifest.json") && query.includes("activity-manifest");
}

function isDriveMetadataCreate(url, init) {
  return String(init?.method || "GET").toUpperCase() === "POST"
    && isDriveFileList(url)
    && String(headerValue(init.headers, "Content-Type") || "").includes("application/json");
}

function driveMediaReadId(url, method) {
  if (method !== "GET") return null;
  try {
    const parsed = new URL(url);
    if (parsed.origin !== "https://www.googleapis.com" || parsed.searchParams.get("alt") !== "media") return null;
    const match = parsed.pathname.match(/^\/drive\/v3\/files\/(.+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

function mediaUploadFileId(url, method) {
  if (method !== "PATCH") return null;
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/upload\/drive\/v3\/files\/(.+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

function isTrashPatch(url, init) {
  if (String(init?.method || "GET").toUpperCase() !== "PATCH") return false;
  const body = parseJsonBody(init.body);
  return body?.trashed === true && Boolean(driveMetadataFileId(url));
}

function driveMetadataFileId(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

async function driveJson(url, token, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  const response = await nativeFetch(url, { ...init, headers });
  if (!response.ok) throw new Error(`Google Drive API ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response.json();
}

async function mapLimit(items, limit, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}

function readToken() {
  try {
    const cached = JSON.parse(localStorage.getItem(TOKEN_KEY) || "null");
    return cached?.accessToken || null;
  } catch {
    return null;
  }
}

function authToken(init) {
  const authorization = headerValue(init?.headers, "Authorization") || "";
  const match = String(authorization).match(/^Bearer\s+(.+)$/i);
  return match?.[1] || readToken();
}

function headerValue(headers, name) {
  if (headers instanceof Headers) return headers.get(name);
  const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1] || null;
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

function requestUrl(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input?.url || "";
}

function driveEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function jsonBlob(value) {
  return new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function appendLog(text) {
  const log = document.querySelector("#log");
  if (!log) return;
  const stamp = new Date().toLocaleTimeString();
  log.textContent = `${log.textContent ? `${log.textContent}\n` : ""}[${stamp}] ${text}`;
  log.scrollTop = log.scrollHeight;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
