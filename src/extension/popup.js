document.addEventListener('DOMContentLoaded', async () => {
  const serverInput = document.getElementById('serverUrl');
  const urlInput = document.getElementById('pageUrl');
  const titleInput = document.getElementById('pageTitle');
  const intervalSelect = document.getElementById('interval');
  const form = document.getElementById('monitorForm');
  const submitBtn = document.getElementById('submitBtn');
  const statusDiv = document.getElementById('status');

  // Load saved server URL preference
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['serverUrl'], (res) => {
      if (res && res.serverUrl) serverInput.value = res.serverUrl;
    });
  }

  // Query active tab URL & title
  if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0]) {
        const activeTab = tabs[0];
        urlInput.value = activeTab.url || '';
        titleInput.value = activeTab.title || '';
      }
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submitBtn.disabled = true;
    submitBtn.textContent = 'Adding Monitor...';
    statusDiv.style.display = 'none';

    const serverUrl = serverInput.value.replace(/\/+$/, '');
    const targetUrl = urlInput.value;
    const name = titleInput.value.trim() || new URL(targetUrl).hostname;
    const intervalMinutes = parseInt(intervalSelect.value, 10);

    // Save server URL preference
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ serverUrl });
    }

    try {
      // 1. Fetch CSRF token from ChangeWatch server
      const csrfRes = await fetch(`${serverUrl}/api/auth/csrf`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!csrfRes.ok) {
        throw new Error('Not logged into ChangeWatch server. Please log in first at ' + serverUrl);
      }
      const csrfData = await csrfRes.json();
      const csrfToken = csrfData.csrfToken;

      // 2. Submit new subscription
      const payload = {
        url: targetUrl,
        name,
        interval_minutes: intervalMinutes,
        sensitivity: 'balanced',
        capture_config: { engine: 'playwright', captureScreenshot: true },
        noise_filters: { timestamps: true, counters: true, tokens: true },
      };

      const subRes = await fetch(`${serverUrl}/api/subscriptions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        credentials: 'include',
        body: JSON.stringify(payload),
      });

      const subData = await subRes.json();
      if (!subRes.ok) {
        throw new Error(subData.error || 'Failed to create monitor');
      }

      statusDiv.className = 'success';
      statusDiv.textContent = `✓ Monitor "${name}" created successfully!`;
      statusDiv.style.display = 'block';
      submitBtn.textContent = 'Monitor Added';
    } catch (err) {
      statusDiv.className = 'error';
      statusDiv.textContent = err.message || 'An error occurred';
      statusDiv.style.display = 'block';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Add Monitor';
    }
  });
});
