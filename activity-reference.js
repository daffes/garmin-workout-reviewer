const TOKEN_KEY = "gwr.drive.access-token.v1";
const MANIFEST_NAME = "activity-manifest.json";
const APP = "garmin-workout-reviewer";
const TOKEN_MARGIN_MS = 60_000;
const processed = new Set();
const pending = new Set();

installStyles();
installReferenceIds();

function installReferenceIds() {
  const list = document.querySelector("#activity-list");
  if (!list) return;

  decorateAndPersist(list);
  new MutationObserver(() => decorateAndPersist(list)).observe(list, {
    childList: true,
  });

  list.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-copy-reference]");
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const referenceId = button.dataset.copyReference;
    try {
      await navigator.clipboard.writeText(referenceId);
      const original = button.textContent;
      button.textContent = "Copied";
      setTimeout(() => { button.textContent = original; }, 900);
    } catch {
      button.title = `Activity reference: ${referenceId}`;
    }
  });
}

function decorateAndPersist(list) {
  for (const row of list.querySelectorAll(":scope > .activity-card[data-folder-id]")) {
    const folderId = row.dataset.folderId;
    if (!folderId) continue;
    const referenceId = makeReferenceId(folderId);
    decorateRow(row, referenceId);
    persistReference(folderId, referenceId).catch((error) => {
      console.warn(`Could not persist ${referenceId}:`, error);
    });
  }
}

function decorateRow(row, referenceId) {
  let reference = row.querySelector("[data-activity-reference]");
  if (!reference) {
    reference = document.createElement("button");
    reference.type = "button";
    reference.className = "activity-reference";
    reference.dataset.activityReference = "";
    const heading = row.querySelector(".activity-main > div");
    const date = row.querySelector(".activity-main h3");
    if (heading) heading.insertBefore(reference, date || null);
    else row.prepend(reference);
  }
  reference.textContent = referenceId;
  reference.dataset.copyReference = referenceId;
  reference.title = `Copy activity reference ${referenceId}`;
  row.dataset.referenceId = referenceId;
}

async function persistReference(folderId, referenceId) {
  if (processed.has(folderId) || pending.has(folderId)) return;
  const token = readToken();
  if (!token) return;
  pending.add(folderId);

  try {
    const folder = await driveJson(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?fields=id,name,appProperties`,
      token,
    );
    if (folder.appProperties?.referenceId !== referenceId) {
      await patchMetadata(folderId, {
        ...(folder.appProperties || {}),
        app: folder.appProperties?.app || APP,
        referenceId,
      }, token);
    }

    const query = [
      `'${driveEscape(folderId)}' in parents`,
      `name='${MANIFEST_NAME}'`,
      "trashed=false",
    ].join(" and ");
    const result = await driveJson(
      `https://www.googleapis.com/drive/v3/files?spaces=drive&pageSize=10&fields=${encodeURIComponent("files(id,name,appProperties)")}&q=${encodeURIComponent(query)}`,
      token,
    );
    const manifestFile = result.files?.[0];

    if (manifestFile) {
      const manifest = await driveJson(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(manifestFile.id)}?alt=media`,
        token,
      );
      if (manifest.referenceId !== referenceId) {
        await driveJson(
          `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(manifestFile.id)}?uploadType=media&fields=id,modifiedTime`,
          token,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...manifest,
              referenceId,
              updatedAt: new Date().toISOString(),
            }, null, 2),
          },
        );
      }
      if (manifestFile.appProperties?.referenceId !== referenceId) {
        await patchMetadata(manifestFile.id, {
          ...(manifestFile.appProperties || {}),
          app: manifestFile.appProperties?.app || APP,
          artifactType: manifestFile.appProperties?.artifactType || "activity-manifest",
          referenceId,
        }, token);
      }
    }

    processed.add(folderId);
  } finally {
    pending.delete(folderId);
  }
}

async function patchMetadata(fileId, appProperties, token) {
  return driveJson(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,appProperties`,
    token,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appProperties }),
    },
  );
}

async function driveJson(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    throw new Error(`Google Drive API ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

function readToken() {
  try {
    const cached = JSON.parse(localStorage.getItem(TOKEN_KEY) || "null");
    if (!cached?.accessToken || !Number.isFinite(cached.expiresAt)) return null;
    if (Date.now() >= cached.expiresAt - TOKEN_MARGIN_MS) return null;
    return cached.accessToken;
  } catch {
    return null;
  }
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

function driveEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function installStyles() {
  const style = document.createElement("style");
  style.textContent = `
    .activity-reference {
      flex: 0 0 auto;
      padding: 2px 6px;
      border: 1px solid #d8e1e5;
      border-radius: 5px;
      background: #f5f8f9;
      color: #52626e;
      font: 700 .7rem ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: .02em;
      cursor: copy;
    }
    .activity-reference:hover,
    .activity-reference:focus-visible {
      border-color: #8eabb3;
      background: #edf4f5;
      color: #164f59;
    }
    @media (max-width: 680px) {
      .activity-reference { display: inline-block; margin: 3px 6px 0 0; }
    }
  `;
  document.head.append(style);
}
