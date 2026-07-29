const TOKEN_KEY = "gwr.drive.access-token.v1";
const TOKEN_MARGIN_MS = 60_000;

export function installGoogleTokenCache() {
  const oauth2 = window.google?.accounts?.oauth2;
  if (!oauth2?.initTokenClient) {
    throw new Error("Google Identity Services is unavailable.");
  }

  const originalInitTokenClient = oauth2.initTokenClient.bind(oauth2);
  oauth2.initTokenClient = (configuration) => {
    const originalCallback = configuration.callback;
    const wrappedConfiguration = {
      ...configuration,
      callback: (response) => {
        if (response?.access_token) saveToken(response, configuration.scope);
        originalCallback?.(response);
      },
    };

    const client = originalInitTokenClient(wrappedConfiguration);
    const originalRequestAccessToken = client.requestAccessToken.bind(client);

    client.requestAccessToken = (overrides = {}) => {
      const prompt = overrides?.prompt || "";
      const isInteractive = Boolean(prompt && prompt !== "none");
      const cached = !isInteractive ? readToken() : null;

      if (cached) {
        queueMicrotask(() => wrappedConfiguration.callback({
          access_token: cached.accessToken,
          expires_in: Math.max(60, Math.floor((cached.expiresAt - Date.now()) / 1000)),
          scope: cached.scope || configuration.scope,
          token_type: "Bearer",
        }));
        return undefined;
      }

      return originalRequestAccessToken(overrides);
    };

    return client;
  };

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...arguments_) => {
    const response = await originalFetch(...arguments_);
    const url = requestUrl(arguments_[0]);
    if (response.status === 401 && url.startsWith("https://www.googleapis.com/drive/")) {
      clearToken();
    }
    return response;
  };
}

function saveToken(response, requestedScope) {
  const expiresInSeconds = Math.max(60, Number(response.expires_in || 3600));
  const token = {
    accessToken: response.access_token,
    expiresAt: Date.now() + expiresInSeconds * 1000,
    scope: response.scope || requestedScope || "",
  };
  localStorage.setItem(TOKEN_KEY, JSON.stringify(token));
}

function readToken() {
  try {
    const token = JSON.parse(localStorage.getItem(TOKEN_KEY) || "null");
    if (!token?.accessToken || !Number.isFinite(token.expiresAt)) return null;
    if (Date.now() >= token.expiresAt - TOKEN_MARGIN_MS) {
      clearToken();
      return null;
    }
    return token;
  } catch {
    clearToken();
    return null;
  }
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

function requestUrl(request) {
  if (typeof request === "string") return request;
  if (request instanceof URL) return request.href;
  return request?.url || "";
}
