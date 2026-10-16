# ChangeWatch Companion Extension (Manifest V3)

A lightweight browser companion extension for ChangeWatch that allows one-click subscription creation directly from any active tab.

## Features
- **1-Click Active Tab Ingestion**: Pre-populates the target URL and tab title automatically.
- **Configurable ChangeWatch Host**: Defaults to `http://localhost:3000` with local storage persistence.
- **Session & CSRF Awareness**: Automatically fetches the CSRF token from `/api/auth/csrf` and sends authenticated subscription requests.
- **Adjustable Check Interval**: Choose between 15m, 1h, 6h, or 24h intervals.

## Installation
1. Open Google Chrome, Chromium, or Brave and navigate to `chrome://extensions/`.
2. Enable **Developer mode** in the top right corner.
3. Click **Load unpacked** in the top left toolbar.
4. Select the directory:
   `<repo-root>/src/extension`
5. The ChangeWatch extension icon will appear in your browser toolbar.

## Usage
1. Make sure ChangeWatch server is running (`npm start` or `npm run dev`) and you are logged into the ChangeWatch dashboard.
2. Navigate to any website you want to track.
3. Click the ChangeWatch extension icon in your browser toolbar.
4. Confirm or adjust the monitor title and check interval.
5. Click **Add to ChangeWatch**. The subscription will be scheduled immediately.
