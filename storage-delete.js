const TOKEN_KEY = "gwr.drive.access-token.v1";
const skippedUploads = new Map();
const previousFetch = window.fetch.bind(window);

window.fetch = async (input, init = {}) => {
  const url = requestUrl(input);

  if (isDriveMetadataCreate(url, init)) {
    const metadata = parseJsonBody(init.body);
    if (metadata?.appProperties?.artifactType === "original-source" && /\.zip$/i.test(metadata.name || "")) {
      const fakeId = `gwr-skip-zip-${crypto.randomUUID()}`;
      skippedUploads.set(fakeId, metadata.name || "source.zip");
      return jsonResponse({
        id: fakeId,
        name: metadata.name,
        parents: metadata.parents || [],
      });
    }
  }

  const mediaId = mediaUploadFileId(url, init);
  if (mediaId && skippedUploads.has(mediaId)) {
    const name = skippedUploads.get(mediaId);
    skippedUploads.delete(mediaId);
    return jsonResponse({ id: mediaId, name, size: "0", skipped: true });
  }

  return previousFetch(input, init);
};

const list = document.querySelector("#activity-list");
if (list) {
  decorateDeleteButtons();
  new MutationObserver(decorateDeleteButtons).observe(list, { childList: true });
}

document.addEventListener("click", handleDeleteCapture, true);
installDeleteStyles();

function decorateDeleteButtons() {
  for (const row of list.querySelectorAll(":scope > .activity-row:not([data-delete-ready])")) {
    row.dataset.deleteReady = "1";
    const editor = row.querySelector(".review-editor");
    if (!editor) continue;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary small danger-button";
    button.dataset.deleteActivity = "1";
    button.textContent = "Delete";
    editor.appendChild(button);
  }
}

async function handleDeleteCapture(event) {
  const button = event.target.closest("[data-delete-activity]");
  if (!button) return;

  const row = button.closest(".activity-row");
  if (!row) return;

  event.preventDefault();
  event.stopImmediatePropagation();

  const folderId = row.dataset.folderId;
  const referenceId = row.querySelector("[data-copy-reference]")?.dataset.copyReference || "this activity";
  if (!folderId) return;

  const confirmed = window.confirm(
    `Delete ${referenceId}?\n\nThe activity folder and all files inside it will be moved to Google Drive Trash.`,
  );
  if (!confirmed) return;

  const token = readToken();
  if (!token) {
    appendLog("Reconnect Google Drive before deleting an activity.");
    return;
  }

  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Deleting…";

  try {
    const response = await previousFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?fields=id,trashed`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ trashed: true }),
      },
    );

    if (!response.ok) {
      throw new Error(`Google Drive API ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }

    row.remove();
    updateActivityCount();
    appendLog(`Moved ${referenceId} to Google Drive Trash.`);
  } catch (error) {
    console.error(error);
    appendLog(`Delete failed: ${error instanceof Error ? error.message : String(error)}`);
    button.disabled = false;
    button.textContent = originalText;
  }
}

function updateActivityCount() {
  const remaining = list.querySelectorAll(":scope > .activity-row").length;
  const status = document.querySelector("#library-status");
  if (status) status.textContent = `${remaining} ${remaining === 1 ? "activity" : "activities"}`;
  if (!remaining) list.innerHTML = '<p class="empty-state">No uploaded activities found.</p>';
}

function readToken() {
  try {
    const cached = JSON.parse(localStorage.getItem(TOKEN_KEY) || "null");
    return cached?.accessToken || null;
  } catch {
    return null;
  }
}

function appendLog(text) {
  const log = document.querySelector("#log");
  if (!log) return;
  const stamp = new Date().toLocaleTimeString();
  log.textContent = `${log.textContent ? `${log.textContent}\n` : ""}[${stamp}] ${text}`;
  log.scrollTop = log.scrollHeight;
}

function installDeleteStyles() {
  const style = document.createElement("style");
  style.textContent = `
    .review-editor { grid-template-columns: minmax(220px, 1fr) auto auto auto !important; }
    .danger-button { color: #8a2730 !important; border-color: #e5b8bd !important; background: #fff7f8 !important; }
    .danger-button:hover:not(:disabled) { background: #fde6e8 !important; }
    @media (max-width: 720px) {
      .review-editor { grid-template-columns: 1fr !important; }
    }
  `;
  document.head.appendChild(style);
}

function isDriveMetadataCreate(url, init) {
  return init?.method === "POST"
    && url.startsWith("https://www.googleapis.com/drive/v3/files?")
    && String(headerValue(init.headers, "Content-Type") || "").includes("application/json");
}

function mediaUploadFileId(url, init) {
  if (init?.method !== "PATCH" || !url.includes("/upload/drive/v3/files/")) return null;
  const encoded = url.match(/\/upload\/drive\/v3\/files\/([^?]+)/)?.[1] || null;
  return encoded ? decodeURIComponent(encoded) : null;
}

function parseJsonBody(body) {
  if (typeof body !== "string") return null;
  try { return JSON.parse(body); } catch { return null; }
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

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
