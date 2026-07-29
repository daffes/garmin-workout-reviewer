const manifestsByFolder = window.__gwrManifestsByFolder instanceof Map
  ? window.__gwrManifestsByFolder
  : new Map();
window.__gwrManifestsByFolder = manifestsByFolder;

const previousFetch = window.fetch.bind(window);

window.fetch = async (input, init = {}) => {
  const response = await previousFetch(input, init);
  const method = String(init?.method || "GET").toUpperCase();
  const url = requestUrl(input);

  if (method === "GET" && response.ok && url.includes("alt=media")) {
    captureManifest(response).catch(() => {});
  }

  return response;
};

async function captureManifest(response) {
  const data = await response.clone().json();
  if (!looksLikeManifest(data)) return;

  const folderId = String(data.folderId);
  manifestsByFolder.set(folderId, data);
  window.dispatchEvent(new CustomEvent("gwr-manifest-available", {
    detail: { folderId },
  }));
}

function looksLikeManifest(value) {
  return Boolean(
    value
    && typeof value === "object"
    && value.folderId
    && (value.referenceId || value.activityId || value.sport || value.summary),
  );
}

function requestUrl(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input?.url || "";
}
