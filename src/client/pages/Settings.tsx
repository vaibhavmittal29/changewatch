import React, { useState, useEffect } from 'react';

interface SettingsProps {
  csrfToken: string;
}

export const Settings: React.FC<SettingsProps> = ({ csrfToken }) => {
  const [discordWebhook, setDiscordWebhook] = useState('');
  const [telegramToken, setTelegramToken] = useState('');
  const [telegramChatId, setTelegramChatId] = useState('');
  const [emailAddress, setEmailAddress] = useState('');
  const [testResult, setTestResult] = useState<{ channel: string; status: string; message?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingChannel, setTestingChannel] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/destinations')
      .then(res => res.json())
      .then(data => {
        if (data.destinations) {
          const map: Record<string, { channel: string; config: Record<string, string> }> = {};
          for (const d of data.destinations) {
            map[d.channel] = d;
          }
          if (map.discord?.config?.webhookUrl) setDiscordWebhook(map.discord.config.webhookUrl);
          if (map.telegram?.config?.botToken) setTelegramToken(map.telegram.config.botToken);
          if (map.telegram?.config?.chatId) setTelegramChatId(map.telegram.config.chatId);
          if (map.email?.config?.toEmail) setEmailAddress(map.email.config.toEmail);
          else if (map.email?.config?.to) setEmailAddress(map.email.config.to);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async (channel: string, config: Record<string, string>) => {
    setSaving(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/destinations', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ channel, config, enabled: true }),
      });
      const data = await res.json();
      if (!res.ok) {
        setTestResult({ channel, status: `ERROR_${res.status}`, message: data.error || 'Failed to save destination' });
        return;
      }
      setTestResult({ channel, status: 'SAVED', message: `${channel.toUpperCase()} destination saved successfully.` });
    } catch (err: unknown) {
      setTestResult({ channel, status: 'ERROR', message: err instanceof Error ? err.message : 'Save failed' });
    } finally {
      setSaving(false);
    }
  };

  const handleSendTest = async (channel: string) => {
    setTestingChannel(channel);
    setTestResult(null);

    let config: Record<string, string> = {};
    if (channel === 'discord') config = { webhookUrl: discordWebhook };
    if (channel === 'telegram') config = { botToken: telegramToken, chatId: telegramChatId };
    if (channel === 'email') config = { toEmail: emailAddress };

    try {
      const res = await fetch('/api/destinations/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ channel, config }),
      });
      const data = await res.json();
      if (!res.ok) {
        setTestResult({
          channel,
          status: data.status || `ERROR_${res.status}`,
          message: data.error || `Test alert failed with status ${res.status}`,
        });
        return;
      }
      setTestResult({
        channel,
        status: data.status || 'SENT',
        message: data.message || `Test alert dispatched: status ${data.status}`,
      });
    } catch (err: unknown) {
      setTestResult({ channel, status: 'FAILED', message: err instanceof Error ? err.message : 'Test failed' });
    } finally {
      setTestingChannel(null);
    }
  };

  if (loading) {
    return <div className="py-12 text-center text-slate-400 text-sm">Loading notification settings...</div>;
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="pb-4 border-b border-slate-800">
        <h1 className="text-2xl font-bold text-white tracking-tight">Alert Destinations</h1>
        <p className="text-xs text-slate-400 mt-1">
          Configure external delivery channels for confirmed changes and outage alerts. Secrets are stored AES-256 encrypted.
        </p>
      </div>

      {testResult && (
        <div className={`p-4 rounded-xl text-xs border ${
          testResult.status === 'SENT_EXTERNAL' || testResult.status === 'SAVED' || testResult.status === 'RECORDED_IN_APP'
            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
            : testResult.status === 'PENDING_CONFIG'
            ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
            : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
        }`}>
          <strong>[{testResult.channel.toUpperCase()}] {testResult.status}:</strong> {testResult.message}
        </div>
      )}

      {/* Discord */}
      <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white font-bold text-xs">DC</div>
            <div>
              <h2 className="text-sm font-bold text-white">Discord Webhook</h2>
              <p className="text-xs text-slate-400">Post rich embed alerts to a Discord channel.</p>
            </div>
          </div>
          <button
            onClick={() => handleSendTest('discord')}
            disabled={testingChannel === 'discord'}
            className="px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl border border-slate-700 transition cursor-pointer"
          >
            {testingChannel === 'discord' ? 'Sending...' : 'Send Test Alert'}
          </button>
        </div>
        <div className="flex gap-2">
          <input
            type="url"
            value={discordWebhook}
            onChange={e => setDiscordWebhook(e.target.value)}
            placeholder="https://discord.com/api/webhooks/..."
            className="flex-1 px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-xs text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
          />
          <button
            onClick={() => handleSave('discord', { webhookUrl: discordWebhook })}
            disabled={saving}
            className="px-4 py-2 bg-emerald-400 hover:bg-emerald-300 text-slate-950 font-semibold text-xs rounded-xl transition cursor-pointer"
          >
            Save
          </button>
        </div>
      </div>

      {/* Telegram */}
      <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-sky-500 flex items-center justify-center text-white font-bold text-xs">TG</div>
            <div>
              <h2 className="text-sm font-bold text-white">Telegram Bot</h2>
              <p className="text-xs text-slate-400">Receive alerts directly in your Telegram chat.</p>
            </div>
          </div>
          <button
            onClick={() => handleSendTest('telegram')}
            disabled={testingChannel === 'telegram'}
            className="px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl border border-slate-700 transition cursor-pointer"
          >
            {testingChannel === 'telegram' ? 'Sending...' : 'Send Test Alert'}
          </button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <input
            type="text"
            value={telegramToken}
            onChange={e => setTelegramToken(e.target.value)}
            placeholder="Bot Token (e.g. 123456:ABC...)"
            className="px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-xs text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
          />
          <div className="flex gap-2">
            <input
              type="text"
              value={telegramChatId}
              onChange={e => setTelegramChatId(e.target.value)}
              placeholder="Chat ID (e.g. 98765432)"
              className="flex-1 px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-xs text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
            />
            <button
              onClick={() => handleSave('telegram', { botToken: telegramToken, chatId: telegramChatId })}
              disabled={saving}
              className="px-4 py-2 bg-emerald-400 hover:bg-emerald-300 text-slate-950 font-semibold text-xs rounded-xl transition cursor-pointer"
            >
              Save
            </button>
          </div>
        </div>
      </div>

      {/* Email */}
      <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-emerald-600 flex items-center justify-center text-white font-bold text-xs">EM</div>
            <div>
              <h2 className="text-sm font-bold text-white">Email (Nodemailer SMTP)</h2>
              <p className="text-xs text-slate-400">Deliver HTML email notifications. Requires SMTP env variables configured on server.</p>
            </div>
          </div>
          <button
            onClick={() => handleSendTest('email')}
            disabled={testingChannel === 'email'}
            className="px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl border border-slate-700 transition cursor-pointer"
          >
            {testingChannel === 'email' ? 'Sending...' : 'Send Test Alert'}
          </button>
        </div>
        <div className="flex gap-2">
          <input
            type="email"
            value={emailAddress}
            onChange={e => setEmailAddress(e.target.value)}
            placeholder="alerts@example.com"
            className="flex-1 px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-xs text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
          />
          <button
            onClick={() => handleSave('email', { toEmail: emailAddress })}
            disabled={saving}
            className="px-4 py-2 bg-emerald-400 hover:bg-emerald-300 text-slate-950 font-semibold text-xs rounded-xl transition cursor-pointer"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
};
