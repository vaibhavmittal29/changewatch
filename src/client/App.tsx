import { useState, useEffect } from 'react';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { MonitorDetail } from './pages/MonitorDetail';
import { Compare } from './pages/Compare';
import { Settings } from './pages/Settings';
import { TestRig } from './pages/TestRig';
import { VisualPicker } from './pages/VisualPicker';
import { isStaticDemo } from './staticDemo';

interface User {
  id: string;
  email: string;
  displayName: string;
  digestEnabled: number;
}

type ViewMode = 'dashboard' | 'detail' | 'compare' | 'settings' | 'test-rig' | 'picker';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentView, setCurrentView] = useState<ViewMode>('dashboard');
  const [selectedMonitorId, setSelectedMonitorId] = useState<string | null>(null);
  const [compareVersions, setCompareVersions] = useState<{ from?: string; to?: string }>({});
  const [pickerTarget, setPickerTarget] = useState<{ url?: string; subscriptionId?: string }>({});

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('from') && params.get('to')) {
      setCompareVersions({ from: params.get('from')!, to: params.get('to')! });
      setCurrentView('compare');
    }
    if (window.location.pathname === '/picker' || params.get('view') === 'picker') {
      setPickerTarget({
        url: params.get('url') || undefined,
        subscriptionId: params.get('id') || undefined,
      });
      setCurrentView('picker');
    }

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
          <svg className="animate-spin h-5 w-5 text-emerald-400" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
          </svg>
          <span className="text-sm">Connecting to ChangeWatch...</span>
        </div>
      </div>
    );
  }

  if (!user || !csrfToken) {
    return <Login onAuthSuccess={(u, token) => { setUser(u); setCsrfToken(token); }} />;
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-emerald-500/20 selection:text-emerald-300">
      {isStaticDemo && (
        <div className="bg-amber-500/10 border-b border-amber-500/30 text-amber-300 text-xs py-2 px-4 text-center font-medium flex items-center justify-center gap-2">
          <span>⚠️</span>
          <span>Static preview: sample data only, no backend. For live monitoring run locally or deploy with Node.</span>
        </div>
      )}
      {/* Top Navigation */}
      <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <div
              onClick={() => setCurrentView('dashboard')}
              className="flex items-center gap-3 cursor-pointer"
            >
              <div className="w-8 h-8 rounded-lg bg-emerald-500 flex items-center justify-center text-slate-950 font-bold text-base shadow-md shadow-emerald-500/20">
                CW
              </div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-white text-base tracking-tight">ChangeWatch</span>
                <span className="hidden sm:inline-block text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium">
                  {isStaticDemo ? 'Static Showcase' : 'Live Engine'}
                </span>
              </div>
            </div>

            <nav className="flex items-center gap-1 sm:gap-2">
              <button
                onClick={() => setCurrentView('dashboard')}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition cursor-pointer ${
                  currentView === 'dashboard' || currentView === 'detail'
                    ? 'bg-slate-800 text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Dashboard
              </button>
              <button
                onClick={() => setCurrentView('compare')}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition cursor-pointer ${
                  currentView === 'compare' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                Compare
              </button>
              <button
                onClick={() => setCurrentView('settings')}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition cursor-pointer ${
                  currentView === 'settings' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                Settings
              </button>
              <button
                onClick={() => setCurrentView('test-rig')}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition cursor-pointer ${
                  currentView === 'test-rig' ? 'bg-slate-800 text-emerald-400' : 'text-slate-400 hover:text-white'
                }`}
              >
                Test Rig
              </button>
              <button
                onClick={() => setCurrentView('picker')}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition cursor-pointer ${
                  currentView === 'picker' ? 'bg-slate-800 text-emerald-400' : 'text-slate-400 hover:text-white'
                }`}
              >
                Visual Picker
              </button>
            </nav>
          </div>

          <div className="flex items-center gap-4">
            <div className="text-right hidden sm:block">
              <div className="text-sm font-medium text-slate-200">{user.displayName}</div>
              <div className="text-xs text-slate-400">{user.email}</div>
            </div>
            <button
              onClick={handleLogout}
              className="px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg border border-slate-700 transition cursor-pointer"
            >
              Sign Out
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {currentView === 'dashboard' && (
          <Dashboard
            csrfToken={csrfToken}
            onSelectMonitor={id => {
              setSelectedMonitorId(id);
              setCurrentView('detail');
            }}
            onOpenCompare={() => setCurrentView('compare')}
          />
        )}

        {currentView === 'detail' && selectedMonitorId && (
          <MonitorDetail
            subscriptionId={selectedMonitorId}
            csrfToken={csrfToken}
            onBack={() => setCurrentView('dashboard')}
            onCompare={(v1, v2) => {
              setCompareVersions({ from: v1, to: v2 });
              setCurrentView('compare');
            }}
          />
        )}

        {currentView === 'compare' && (
          <Compare
            fromVersionId={compareVersions.from}
            toVersionId={compareVersions.to}
            onBack={() => setCurrentView('dashboard')}
          />
        )}

        {currentView === 'settings' && <Settings csrfToken={csrfToken} />}

        {currentView === 'test-rig' && (
          <TestRig
            csrfToken={csrfToken}
            onMonitorCreated={() => setCurrentView('dashboard')}
          />
        )}

        {currentView === 'picker' && (
          <VisualPicker
            csrfToken={csrfToken}
            initialUrl={pickerTarget.url}
            subscriptionId={pickerTarget.subscriptionId}
            onBack={() => setCurrentView('dashboard')}
            onSaved={() => setCurrentView('dashboard')}
          />
        )}
      </main>
    </div>
  );
}
