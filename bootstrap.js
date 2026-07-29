import { installGoogleTokenCache } from "./auth-cache.js?v=20260729-1637";

await loadGoogleIdentityServices();
installGoogleTokenCache();
await import("./app.js?v=20260729-1637");
await import("./library-ui.js?v=20260729-1637");

function loadGoogleIdentityServices() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error("Google Identity Services failed to load."));
    document.head.append(script);
  });
}
