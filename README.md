# Garmin Workout Reviewer

A browser-only utility for the Iron Man Haines City training workflow.

It accepts Garmin `.fit` activities and Garmin Connect `.zip` exports containing a FIT file. The app decodes the activity locally, saves the source and review artifacts to Google Drive, assigns a stable `GWR-...` reference ID, and stores an optional ChatGPT conversation link.

## Deployment

GitHub Pages deploys automatically from `main` using `.github/workflows/pages.yml`.

Public app: `https://daffes.github.io/garmin-workout-reviewer/`

## Google authorization

The browser app uses Google Identity Services and the `https://www.googleapis.com/auth/drive.file` scope. The OAuth web client must allow the JavaScript origin `https://daffes.github.io`.

The client ID is public browser configuration. No client secret belongs in this repository.
