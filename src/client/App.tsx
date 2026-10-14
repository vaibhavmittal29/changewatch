import { useState, useEffect } from 'react';
import { Login } from './pages/Login';

interface User {
  id: string;
  email: string;
  displayName: string;
  digestEnabled: number;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Check active session on load
    fetch('/api/auth/me')
      .then(res => res.json())
      .then(data => {
        if (data.user) {
          setUser(data.user);
          setCsrfToken(data.csrfToken);
        }
      })
      .catch(err => {
        console.error('Failed to restore session:', err);
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: csrfToken ? { 'X-CSRF-Token': csrfToken } : {},
      });
    } catch (err) {
      console.error('Logout error:', err);
    }
    setUser(null);
    setCsrfToken(null);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-400">
        <div className="flex items-center gap-3">
          <svg className="animate-spin h-5 w-5 text-indigo-500" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
          </svg>
          <span className="text-sm">Connecting to ChangeWatch...</span>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Login onAuthSuccess={(u, token) => { setUser(u); setCsrfToken(token); }} />;
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Top Navigation */}
      <header className="border-b border-slate-800 bg-slate-900/50 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white font-bold text-base shadow-md shadow-indigo-600/30">
              CW
            </div>
            <div>
              <span className="font-bold text-white text-base tracking-tight">ChangeWatch</span>
              <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium">
                Phase 1 Active
              </span>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="text-right hidden sm:block">
              <div className="text-sm font-medium text-slate-200">{user.displayName}</div>
              <div className="text-xs text-slate-400">{user.email}</div>
            </div>
            <button
              onClick={handleLogout}
              className="px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg border border-slate-700 transition"
            >
              Sign Out
            </button>
          </div>
        </div>
      </header>

      {/* Main Content (Phase 1 Foundation state) */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 sm:p-8 shadow-xl">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-slate-800">
            <div>
              <h2 className="text-xl font-bold text-white">System Foundation Verified</h2>
              <p className="text-sm text-slate-400 mt-1">
                Database schema, sessions, CSRF protection, and monitor CRUD are online.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                <span className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse"></span>
                SQLite WAL &bull; Port 3000
              </span>
            </div>
          </div>

          {/* Quick Metrics Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-6">
            <div className="bg-slate-950/60 border border-slate-800/80 rounded-xl p-4">
              <div className="text-xs font-medium text-slate-400 uppercase tracking-wider">User Account</div>
              <div className="text-lg font-semibold text-white mt-1">{user.displayName}</div>
              <div className="text-xs text-slate-500 mt-0.5">{user.email}</div>
            </div>
            <div className="bg-slate-950/60 border border-slate-800/80 rounded-xl p-4">
              <div className="text-xs font-medium text-slate-400 uppercase tracking-wider">Security State</div>
              <div className="text-lg font-semibold text-emerald-400 mt-1">CSRF &bull; PBKDF2</div>
              <div className="text-xs text-slate-500 mt-0.5">HttpOnly Sessions Active</div>
            </div>
            <div className="bg-slate-950/60 border border-slate-800/80 rounded-xl p-4">
              <div className="text-xs font-medium text-slate-400 uppercase tracking-wider">Engine Mode</div>
              <div className="text-lg font-semibold text-indigo-400 mt-1">Playwright Headless</div>
              <div className="text-xs text-slate-500 mt-0.5">Fingerprinted SHA-256</div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
