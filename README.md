# Garmin Workout Reviewer

A browser-only utility for Davi's Iron Man training workflow.

It decodes Garmin FIT activities with Garmin's official JavaScript FIT SDK and can save four artifacts directly to Google Drive:

- the original `.fit` file
- a compact analysis-ready `.json`
- the complete decoded `.json`
- athlete notes and a suggested ChatGPT prompt in Markdown

Workout data is parsed in the browser. There is no application server or database.

## First deployment

The repository includes a GitHub Pages workflow. In the repository, open **Settings → Pages** and set **Build and deployment → Source** to **GitHub Actions**. The deployed URL will be:

`https://daffes.github.io/garmin-workout-reviewer/`

## One-time Google setup

The app uses Google Identity Services and the non-sensitive `drive.file` scope. It creates and accesses only Drive files created by this OAuth application.

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Create or select a project, for example `garmin-workout-reviewer`.
3. Open **APIs & Services → Library** and enable **Google Drive API**.
4. Open **Google Auth Platform** and configure the consent screen.
   - Audience: External
   - Publishing status: Testing
   - Add your own Google account as a test user
5. Open **Clients → Create client → Web application**.
6. Add this authorized JavaScript origin:

   `https://daffes.github.io`

7. Copy the client ID ending in `.apps.googleusercontent.com`.
8. Open the deployed site, paste the client ID, and click **Connect Drive**.

The OAuth client ID is public configuration, not a secret. Do not commit a client secret; this static app does not need one.

## Use

1. Connect Google Drive.
2. Select a Garmin `.fit` activity.
3. Add subjective notes.
4. Parse the file.
5. Inspect or download the JSON.
6. Upload the package to Drive.
7. In the Iron Man Haines City ChatGPT project, ask to review the latest activity in the Drive folder.

## Privacy and security

- FIT decoding occurs in the browser.
- No workout data is sent to this app's hosting provider.
- The Garmin SDK is pinned to version `21.208.0` and loaded from jsDelivr.
- Google access tokens live only in page memory and expire normally.
- The app requests `https://www.googleapis.com/auth/drive.file`, not full Drive access.
- The app creates its own `Iron Man Training Data` folder because `drive.file` cannot freely browse arbitrary pre-existing Drive folders.

## Local test

A static server is enough:

```bash
python3 -m http.server 8000
```

Then add `http://localhost:8000` as an authorized JavaScript origin in the Google OAuth client and open it in the browser.
