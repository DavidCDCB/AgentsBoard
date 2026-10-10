const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');
const log = require('electron-log');
// getFolderIndexMtimeMs moved to session-cache.js
const { fetchAndTransformUsage } = require('./claude-auth');
const codexAuth = require('./codex-auth');

// SWITCHBOARD_DATA_DIR isolates a dev/test instance from the installed app:
// db.js puts switchboard.db under it, and pointing userData there gives the
// instance its own single-instance lock (requestSingleInstanceLock keys on
// userData), so both can run side by side.
if (process.env.SWITCHBOARD_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.SWITCHBOARD_DATA_DIR, 'electron'));
}

log.transports.file.level = app.isPackaged ? 'info' : 'debug';
log.transports.console.level = app.isPackaged ? 'info' : 'debug';

try { require('electron-reloader')(module, { watchRenderer: true }); } catch {};

// Clean env for child processes — strips Electron internals that cause nested
// Electron apps (or node-pty inside them) to malfunction, and pins a UTF-8
// LC_CTYPE when the launch environment has no locale. See pty-env.js.
const { buildPtyEnv } = require('./pty-env');
const cleanPtyEnv = buildPtyEnv(process.env);
const { shouldStartFresh, shouldBlockArchivedSession } = require('./session-launch');
const { createTerminalActivity } = require('./terminal-activity');

// Shell profiles → shell-profiles.js
const { getShellProfiles, resolveShell, isWslShell, windowsToWslPath, shellArgs, quoteArgvForShell } = require('./shell-profiles');
const { encodeProjectPath } = require('./encode-project-path');
const { resolveEffectiveSettings } = require('./resolve-effective-settings');
const { resolveTerminalFiles } = require('./terminal-file-links');
const { lastAssistantMessage } = require('./session-preview');


const {
  getMeta, getAllMeta, toggleStar, setName, setArchived,
  isCachePopulated, getAllCached, getCachedByFolder, getCachedSession, upsertCachedSessions,
  updateCachedAiTitle,
  deleteCachedSession, deleteCachedFolder,
  getAllFolderMeta, setFolderMeta,
  upsertSearchEntries, updateSearchTitle, deleteSearchSession, deleteSearchFolder,
  searchByType, isSearchIndexPopulated, searchFtsRecreated,
  getSetting, setSetting, deleteSetting,
  closeDb,
} = require('./db');
const dbModule = require('./db');

const { getHarness, DEFAULT_HARNESS, transcriptPath, availableHarnesses, allHarnesses, progressBusyState,
        harnessForFolder: getHarnessForFolder } = require('./harnesses');
const claudeHarness = getHarness(DEFAULT_HARNESS);
const PROJECTS_DIR = claudeHarness.sessionsRoot();
const MAX_BUFFER_SIZE = 256 * 1024;

// Active PTY sessions
const activeSessions = new Map();
let mainWindow = null;
let appIsQuitting = false;

function createWindow() {
  // Restore saved window bounds
  const savedBounds = getSetting('global')?.windowBounds;
  let bounds = { width: 1400, height: 900 };

  let restorePosition = null;
  if (savedBounds && savedBounds.width && savedBounds.height) {
    bounds.width = savedBounds.width;
    bounds.height = savedBounds.height;

    // Only restore position if it's on a visible display
    if (savedBounds.x != null && savedBounds.y != null) {
      const displays = screen.getAllDisplays();
      const onScreen = displays.some(d => {
        const b = d.bounds;
        return savedBounds.x >= b.x - 100 && savedBounds.x < b.x + b.width &&
               savedBounds.y >= b.y - 100 && savedBounds.y < b.y + b.height;
      });
      if (onScreen) {
        restorePosition = { x: savedBounds.x, y: savedBounds.y };
      }
    }
  }

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 800,
    minHeight: 500,
    title: 'AgentsBoard',
    icon: path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
    },
  });

  // Set position after creation to prevent macOS from clamping size
  if (restorePosition) {
    mainWindow.setBounds({ ...restorePosition, width: bounds.width, height: bounds.height });
  }

  mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));

  // Open external links in the system browser instead of a child BrowserWindow
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    }
  });
  // Override window.open so xterm WebLinksAddon's default handler (which does
  // window.open() then sets location.href) routes through our IPC instead of
  // creating a child BrowserWindow.
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.executeJavaScript(`
      window.open = function(url) {
        if (url && /^https?:\\/\\//i.test(url)) { window.api.openExternal(url); return null; }
        const proxy = {};
        Object.defineProperty(proxy, 'location', { get() {
          const loc = {};
          Object.defineProperty(loc, 'href', {
            set(u) { if (/^https?:\\/\\//i.test(u)) window.api.openExternal(u); }
          });
          return loc;
        }});
        return proxy;
      };
      void 0;
    `);
  });

  // Prevent Cmd+R / Ctrl+Shift+R from reloading the page (Chromium built-in).
  // Ctrl+R alone on macOS is NOT a reload shortcut and must pass through to xterm
  // for reverse-i-search.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    if (key === 'r' && input.meta) event.preventDefault();
    if (key === 'r' && input.control && input.shift) event.preventDefault();
  });

  // Save window bounds on move/resize (debounced)
  let boundsTimer = null;
  const saveBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
      const b = mainWindow.getBounds();
      const global = getSetting('global') || {};
      global.windowBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
      setSetting('global', global);
    }, 500);
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  // Also save immediately before close (debounce may not have flushed)
  mainWindow.on('close', () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    if (!mainWindow.isMinimized()) {
      const b = mainWindow.getBounds();
      const global = getSetting('global') || {};
      global.windowBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
      setSetting('global', global);
    }
  });

  mainWindow.on('closed', () => {
    // On macOS the app stays alive in the dock after the last window closes.
    // Kill all running PTY processes so orphaned `claude` processes don't
    // accumulate in the background with no way for the user to interact.
    for (const [id, session] of activeSessions) {
      if (!session.exited) {
        try { session.pty.kill(); } catch {}
      }
      activeSessions.delete(id);
    }
    mainWindow = null;
  });
}


// --- Session cache helpers ---

// Session cache → session-cache.js
const sessionCache = require('./session-cache');
sessionCache.init({
  PROJECTS_DIR,
  activeSessions,
  getMainWindow: () => mainWindow,
  log,
  db: {
    deleteCachedFolder, getCachedByFolder, getCachedSession, upsertCachedSessions, deleteCachedSession,
    deleteSearchFolder, deleteSearchSession, upsertSearchEntries,
    setFolderMeta, getAllFolderMeta, getAllMeta, getAllCached, getSetting, setSetting, getMeta, setName,
    updateCachedAiTitle, updateSearchTitle,
  },
});
const { refreshFolder, reconcileCacheFromFilesystem, buildProjectsFromCache,
        notifyRendererProjectsChanged, populateCacheViaWorker,
        refreshHarnessTitles, addProjectDirectory, removeProjectDirectory } = sessionCache;

ipcMain.handle('open-external', (_event, url) => {
  log.info('[open-external IPC]', url);
  if (/^https?:\/\//i.test(url)) return shell.openExternal(url);
});

// Reveal a folder in the OS file manager. Only existing directories, so a
// renderer value can never launch a file.
ipcMain.handle('open-path', async (_event, target) => {
  try {
    const resolved = path.resolve(String(target || ''));
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return { error: 'No es una carpeta' };
    const err = await shell.openPath(resolved);
    return err ? { error: err } : { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// --- IPC: clipboard write ---
// The renderer's navigator.clipboard.writeText is gated on focus/user-activation and
// is flaky-to-dead on Linux/Wayland (Ozone). The main-process clipboard has no such
// strings attached, so all terminal copies go through here.
ipcMain.handle('clipboard-write-text', (_event, text) => {
  if (typeof text === 'string') clipboard.writeText(text);
});

ipcMain.handle('resolve-terminal-files', (_event, references, context) => resolveTerminalFiles(references, context));

ipcMain.handle('get-projects', (_event, showArchived) => {
  try {
    const needsPopulate = !isCachePopulated() || !isSearchIndexPopulated();

    if (needsPopulate) {
      populateCacheViaWorker();
      return [];
    }

    // Pick up folders changed while the app was closed, or never indexed by an
    // older build, so sessions/worktrees don't silently go missing. Stat-gated,
    // so it's cheap when nothing has changed.
    reconcileCacheFromFilesystem();
    // Backstop for a dropped fs.watch event: a session waiting for its
    // transcript would otherwise stay stuck under its temporary id. Only runs
    // while something is actually waiting.
    if (hasPendingLaunches()) sweepPendingLaunches();
    return buildProjectsFromCache(showArchived);
  } catch (err) {
    console.error('Error listing projects:', err);
    return [];
  }
});

// --- IPC: add-project --- the user picks a folder to work in when it has no sessions yet
ipcMain.handle('browse-folder', async () => {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const result = await dialog.showOpenDialog(win, {
    title: 'Agregar directorio',
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0] || null;
});

ipcMain.handle('add-project', (_event, dirPath) => {
  if (typeof dirPath !== 'string' || !path.isAbsolute(dirPath)) {
    return { ok: false, error: 'Ruta no válida.' };
  }
  const projectPath = path.resolve(dirPath);
  try {
    if (!fs.statSync(projectPath).isDirectory()) return { ok: false, error: 'La ruta no es un directorio.' };
  } catch {
    return { ok: false, error: 'La carpeta no existe.' };
  }
  addProjectDirectory(projectPath);
  return { ok: true, projectPath };
});

ipcMain.handle('remove-project', (_event, dirPath) => {
  if (typeof dirPath !== 'string' || !path.isAbsolute(dirPath)) {
    return { ok: false, error: 'Ruta no válida.' };
  }
  removeProjectDirectory(dirPath);
  return { ok: true };
});

// --- IPC: get-usage (lightweight, API-only, no PTY) ---
ipcMain.handle('get-usage', async () => {
  if (!harnessEnabled(DEFAULT_HARNESS)) return {};
  try {
    return await fetchAndTransformUsage() || {};
  } catch (err) {
    log.error('Error fetching usage:', err);
    return {};
  }
});

// --- IPC: get-codex-usage --- (same idea for the codex account)
ipcMain.handle('get-codex-usage', async () => {
  // Nothing is fetched for a CLI the user switched off, or one that was never
  // signed in — no request, no error surfaced.
  if (!harnessEnabled('codex')) return {};
  try {
    return await codexAuth.fetchAndTransformUsage() || {};
  } catch (err) {
    log.error('Error fetching codex usage:', err);
    return {};
  }
});

// --- IPC: search ---
ipcMain.handle('search-session-ids', (_event, query, sessionIds) => {
  if (typeof query !== 'string' || !Array.isArray(sessionIds) || sessionIds.some(id => typeof id !== 'string')) return [];
  return dbModule.searchSessionIds(query, sessionIds);
});

ipcMain.handle('search', (_event, type, query, titleOnly) => {
  return searchByType(type, query, 50, !!titleOnly);
});

// --- IPC: settings ---
ipcMain.handle('get-setting', (_event, key) => {
  return getSetting(key);
});

ipcMain.handle('set-setting', (_event, key, value) => {
  const beforeSet = key === 'global' ? disabledHarnessIds() : null;
  const before = beforeSet ? [...beforeSet].sort().join(',') : null;

  if (key === 'global' && Array.isArray(value?.disabledHarnesses)) {
    // At least one CLI has to stay on, or the app has nothing to show and no
    // way to start anything. The settings panel already prevents this; this is
    // the guard for any other writer. The id that was just switched off is the
    // one refused, which is what the UI does too.
    const launchable = allHarnesses().filter(h => h.buildLaunchArgs).map(h => h.id);
    const disabled = new Set(value.disabledHarnesses);
    if (launchable.length && launchable.every(id => disabled.has(id))) {
      const justAdded = launchable.filter(id => disabled.has(id) && !beforeSet.has(id));
      const keep = justAdded[0] || launchable[0];
      log.warn(`[harness-toggle] refusing to disable every CLI; keeping ${keep} on`);
      value = { ...value, disabledHarnesses: value.disabledHarnesses.filter(id => id !== keep) };
    }
  }

  setSetting(key, value);

  if (key === 'global') {
    const after = [...disabledHarnessIds()].sort().join(',');
    if (before !== after) {
      // Something was switched on or off. Watchers follow the new set, and a
      // reconcile picks up whatever a newly-enabled harness did while it was
      // being ignored — incremental, because its cached rows were kept and the
      // folder mtime gate re-reads only what actually changed.
      stopHarnessWatchers();
      startHarnessWatchers();
      try { projectsWatcher?.close(); } catch {}
      projectsWatcher = null;
      startProjectsWatcher();
      try { reconcileCacheFromFilesystem(); } catch (err) { log.error('[harness-toggle]', err.message); }
      notifyRendererProjectsChanged();
      // The status bar quota gauge only re-reads on a 5-minute timer, so
      // without this a switched-off CLI keeps its bars until the next tick.
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('harnesses-changed');
      }
    }
  }
  return { ok: true };
});

ipcMain.handle('delete-setting', (_event, key) => {
  deleteSetting(key);
  return { ok: true };
});

// --- Session defaults (global settings only) ---

const SETTING_DEFAULTS = {
  permissionMode: null,
  dangerouslySkipPermissions: false,
  chrome: false,
  preLaunchCmd: '',
  // Claude's model and effort. Empty leaves the choice to claude.
  model: '',
  effort: '',
  visibleSessionCount: 5,
  sidebarWidth: 340,
  terminalTheme: 'switchboard',
  shellProfile: 'auto',
  // Codex equivalents of the permission settings above. Kept separate because
  // the vocabularies do not map: codex has no permission modes, and Claude has
  // no sandbox policy. An empty value means "leave it to codex's own config".
  // The app starts on workspace-write: a project's attached folders only reach
  // codex under that sandbox, and read-only sessions cannot do the work.
  codexSandbox: 'workspace-write',
  codexApproval: '',
  codexModel: '',
  codexEffort: '',
};

// --- Harness enablement ---
//
// A disabled harness is not scanned, not watched, not listed as something to
// start, and its sessions are hidden. Its cached rows are deliberately KEPT:
// re-enabling then costs an incremental reconcile rather than a full re-index,
// and nothing is lost if the toggle was a mistake.
function disabledHarnessIds() {
  const global = getSetting('global') || {};
  return new Set(global.disabledHarnesses || []);
}

function harnessEnabled(id) {
  return !disabledHarnessIds().has(id || DEFAULT_HARNESS);
}

// --- IPC: harnesses --- (which CLIs this machine has, and which are switched on)
ipcMain.handle('get-harnesses', () => {
  const disabled = disabledHarnessIds();
  return allHarnesses()
    .filter(h => h.buildLaunchArgs)
    .map(h => ({ id: h.id, label: h.label, enabled: !disabled.has(h.id) }));
});

// Codex's model catalog, for model suggestions and the per-model reasoning
// efforts in session and schedule settings.
ipcMain.handle('get-codex-models', () => getHarness('codex')?.readModelCatalog?.() || []);

ipcMain.handle('get-shell-profiles', () => {
  _shellProfiles = null; // refresh on each request
  return getShellProfiles();
});

function effectiveSettings() {
  const global = getSetting('global') || {};
  return resolveEffectiveSettings(SETTING_DEFAULTS, global, {});
}

ipcMain.handle('get-effective-settings', () => effectiveSettings());

// --- IPC: get-active-sessions ---
ipcMain.handle('get-active-sessions', () => {
  const active = [];
  for (const [sessionId, session] of activeSessions) {
    if (!session.exited) active.push(sessionId);
  }
  return active;
});

// --- IPC: get-active-terminals --- (plain terminal sessions for renderer restore)
ipcMain.handle('get-active-terminals', () => {
  const terminals = [];
  for (const [sessionId, session] of activeSessions) {
    if (!session.exited && session.isPlainTerminal) {
      terminals.push({ sessionId, projectPath: session.projectPath });
    }
  }
  return terminals;
});

// --- IPC: stop-session ---
ipcMain.handle('stop-session', (_event, sessionId) => {
  const session = activeSessions.get(sessionId);
  if (!session || session.exited) return { ok: false, error: 'not running' };
  session.stopRequested = true;
  session.pty.kill();
  return { ok: true };
});

// --- IPC: toggle-star ---
ipcMain.handle('toggle-star', (_event, sessionId) => {
  const starred = toggleStar(sessionId);
  return { starred };
});

// --- IPC: rename-session ---
ipcMain.handle('rename-session', (_event, sessionId, name) => {
  setName(sessionId, name || null);
  // Update search index title to include the new name
  const cached = getCachedSession(sessionId);
  const summary = cached?.summary || '';
  updateSearchTitle(sessionId, 'session', (name ? name + ' ' : '') + summary);
  return { name: name || null };
});

function readSessionViewerEntries(row) {
  // The harness owns its transcript naming and its on-disk format. Normalize
  // here so neither transcript consumer needs runtime-specific branches.
  const jsonlPath = transcriptPath(row);
  const harness = getHarness(row.runtime);
  const content = fs.readFileSync(jsonlPath, 'utf-8');
  const entries = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch {}
  }
  return harness.toViewerEntries(entries);
}

ipcMain.handle('read-session-jsonl', (_event, sessionId) => {
  const row = getCachedSession(sessionId);
  if (!row) return { error: 'Sesión no encontrada en caché' };
  try {
    return { entries: readSessionViewerEntries(row) };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('get-session-last-message', (_event, sessionId) => {
  const row = getCachedSession(sessionId);
  if (!row) return { error: 'Sesión no encontrada en caché' };
  try {
    const { text, truncated } = lastAssistantMessage(readSessionViewerEntries(row));
    return { text, truncated };
  } catch (err) {
    return { error: err.message };
  }
});

// --- IPC: archive-session ---

ipcMain.handle('archive-session', (_event, sessionId, archived) => {
  const val = archived ? 1 : 0;
  setArchived(sessionId, val);
  return { archived: val };
});

// --- IPC: open-terminal ---
ipcMain.handle('open-terminal', async (_event, sessionId, projectPath, isNew, sessionOptions) => {
  if (!mainWindow) return { ok: false, error: 'no window' };

  const isPlainTerminal = sessionOptions?.type === 'terminal';
  if (shouldBlockArchivedSession({
    isNew,
    isPlainTerminal,
    archived: getMeta(sessionId)?.archived,
  })) {
    return { ok: false, error: 'La sesión está archivada. Desarchívala antes de reanudarla.' };
  }

  // Reattach to existing session
  if (activeSessions.has(sessionId)) {
    const session = activeSessions.get(sessionId);
    session.rendererAttached = true;
    session.firstResize = !session.isPlainTerminal;

    // If TUI is in alternate screen mode, send escape to switch into it
    if (session.altScreen && !session.isPlainTerminal) {
      mainWindow.webContents.send('terminal-data', sessionId, '\x1b[?1049h');
    }

    // Send buffered output for reattach
    for (const chunk of session.outputBuffer) {
      mainWindow.webContents.send('terminal-data', sessionId, chunk);
    }

    if (!session.isPlainTerminal) {
      // Hide cursor after buffer replay — the live PTY stream or resize nudge
      // will re-show it at the correct position, avoiding a stale cursor artifact
      mainWindow.webContents.send('terminal-data', sessionId, '\x1b[?25l');
    }

    return { ok: true, reattached: true };
  }

  // Spawn new PTY
  if (!fs.existsSync(projectPath)) {
    return { ok: false, error: `directory no longer exists: ${projectPath}` };
  }

  // A session that never wrote a transcript cannot be resumed — the CLI has no
  // record of the id, and asking it to resume one produces an error the user
  // can do nothing about ("No saved session found with ID ..."). Start it
  // fresh instead, which is what re-opening a session that never got going
  // means in practice.
  const cachedSession = getCachedSession(sessionId);
  const startFresh = shouldStartFresh({
    isNew,
    isPlainTerminal,
    hasCachedSession: !!cachedSession,
    resumeExisting: !!sessionOptions?.resumeExisting,
  });
  if (startFresh && !isNew && !isPlainTerminal) {
    log.info(`[open-terminal] ${sessionId} has no transcript; starting a new session instead of resuming`);
  }

  // Which CLI drives this session. The cached row is authoritative for anything
  // that already exists on disk; the caller only gets to say for a brand-new
  // session, which has no row yet.
  const runtimeId = isPlainTerminal
    ? null
    : (cachedSession?.runtime || sessionOptions?.runtime || DEFAULT_HARNESS);
  const harness = runtimeId ? getHarness(runtimeId) : null;
  const isClaudeSession = runtimeId === DEFAULT_HARNESS;

  if (harness && !harness.buildLaunchArgs) {
    return { ok: false, error: `${harness.label} sessions cannot be launched yet` };
  }

  // Resolve shell profile from effective settings
  const effectiveProfileId = effectiveSettings().shellProfile;
  // WSL profiles only work for plain terminals — Claude CLI sessions need the
  // Windows shell because session data lives on the Windows filesystem.
  const requestedProfile = resolveShell(effectiveProfileId);
  const useWslProfile = isWslShell(requestedProfile.path) && isPlainTerminal;
  const shellProfile = (isWslShell(requestedProfile.path) && !isPlainTerminal)
    ? resolveShell('auto')
    : requestedProfile;
  const shell = shellProfile.path;
  const shellExtraArgs = [...(shellProfile.args || [])];
  const isWsl = isWslShell(shell);
  // For WSL, convert Windows path to /mnt/ path and pass via --cd;
  // the spawn cwd must remain a valid Windows path for wsl.exe itself.
  if (isWsl) {
    const wslCwd = windowsToWslPath(projectPath);
    shellExtraArgs.unshift('--cd', wslCwd);
  }
  log.info(`[shell] profile=${shellProfile.id} shell=${shell} args=${JSON.stringify(shellExtraArgs)}`);

  let knownJsonlFiles = new Set();
  let projectFolder = null;

  if (isClaudeSession) {
    // Snapshot existing .jsonl files before spawning (for new session + fork detection)
    projectFolder = encodeProjectPath(projectPath);
    const claudeProjectDir = path.join(PROJECTS_DIR, projectFolder);
    if (fs.existsSync(claudeProjectDir)) {
      try {
        knownJsonlFiles = new Set(
          fs.readdirSync(claudeProjectDir).filter(f => f.endsWith('.jsonl'))
        );
      } catch {}
    }
  }

  let ptyProcess;
  try {
    if (isPlainTerminal) {
      // Plain terminal: interactive login shell, no claude command
      // Do not inherit Claude Code's nested-session marker if Switchboard was
      // itself launched from Claude; this is the user's shell and `claude`
      // should resolve normally from their profile/PATH.
      const terminalEnv = {
        ...cleanPtyEnv,
        TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.6', FORCE_COLOR: '3', ITERM_SESSION_ID: '1',
      };
      delete terminalEnv.CLAUDECODE;
      ptyProcess = pty.spawn(shell, shellArgs(shell, undefined, shellExtraArgs), {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: isWsl ? os.homedir() : projectPath,
        env: terminalEnv,
      });
    } else {
      // Argv is built by the harness and quoted here, so a value can never be
      // spliced into the command line as shell syntax.
      const cliArgs = harness.buildLaunchArgs({
        sessionId, isNew: startFresh, options: sessionOptions,
      });

      let claudeCmd = harness.binary;
      if (cliArgs.length) claudeCmd += ' ' + quoteArgvForShell(shell, cliArgs);

      // preLaunchCmd is raw shell by design (e.g. "aws-vault exec profile --") — block newlines only
      if (sessionOptions?.preLaunchCmd) {
        const pre = String(sessionOptions.preLaunchCmd);
        if (/[\r\n]/.test(pre)) {
          return { ok: false, error: 'preLaunchCmd must not contain newlines' };
        }
        claudeCmd = pre + ' ' + claudeCmd;
      }

      const ptyEnv = {
        ...cleanPtyEnv,
        TERM: 'xterm-256color', COLORTERM: 'truecolor',
        TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.6', FORCE_COLOR: '3', ITERM_SESSION_ID: '1',
      };
      // A harness that cannot be told its session id up front gets to stamp the
      // environment instead, so its transcript can be recognised afterwards.
      if (startFresh && harness.launchEnv) Object.assign(ptyEnv, harness.launchEnv(sessionId));

      ptyProcess = pty.spawn(shell, shellArgs(shell, claudeCmd, shellExtraArgs), {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: isWsl ? os.homedir() : projectPath,
        // TERM_PROGRAM=iTerm.app: Claude Code checks this to decide whether to emit
        // OSC 9 notifications (e.g. "needs your attention"). Without it, the packaged
        // app's minimal Electron environment won't trigger those sequences.
        env: ptyEnv,
      });

    }
  } catch (err) {
    return { ok: false, error: `Error spawning PTY: ${err.message}` };
  }

  const session = {
    pty: ptyProcess, rendererAttached: true, exited: false,
    outputBuffer: [], outputBufferSize: 0, altScreen: false,
    projectPath, firstResize: true,
    projectFolder, knownJsonlFiles,
    isPlainTerminal, runtime: runtimeId, forkFrom: sessionOptions?.forkFrom || null,
    // A plain terminal has no CLI to report a busy state, so one is derived
    // from the shell's own OSC 133 prompt marks, or from the PTY's foreground
    // process when the shell sends none. A harness session already has the
    // OSC 0 / OSC 9;4 handlers below.
    activity: isPlainTerminal ? createTerminalActivity({
      shellName: path.basename(shell),
      // On Windows `pty.process` is the console title, not a process name.
      canPollProcess: process.platform !== 'win32',
    }) : null,
    // Set for a harness whose real session id only appears once its transcript
    // does; cleared by resolvePendingLaunches when the transcript is matched.
    pendingLaunch: (harness?.needsIdDetection?.({ isNew: startFresh, options: sessionOptions })) ? {
      tag: harness.originatorTag ? harness.originatorTag(sessionId) : null,
      // A fork is identified by its parent, not by our env tag — codex copies
      // the originator from the thread being forked.
      forkFrom: sessionOptions?.forkFrom || null,
      projectPath,
      spawnedAt: Date.now(),
    } : null,
    _openedAt: Date.now(),
  };
  activeSessions.set(sessionId, session);
  if (session.activity) startTerminalActivitySweep();

  ptyProcess.onData(data => {
    const currentId = session.realSessionId || sessionId;

    // Prompt marks for a plain terminal. Cheap on every chunk: the parse
    // returns immediately unless the chunk actually contains an OSC 133.
    if (session.activity) {
      const busy = session.activity.feedData(data);
      if (busy !== null) sendTerminalBusy(session, currentId, busy);
    }

    // Parse OSC sequences (title changes, progress, notifications, etc.)
    if (data.includes('\x1b]')) {
      const oscMatches = data.matchAll(/\x1b\](\d+);([^\x07\x1b]*)(?:\x07|\x1b\\)/g);
      for (const m of oscMatches) {
        const code = m[1];
        const payload = m[2].slice(0, 120);
        // Detect Claude CLI busy state from OSC 0 title (spinner chars = busy, ✳ = idle)
        if (code === '0' && harness) {
          // What a title means is the harness's business: Claude marks idle with
          // ✳, codex drops the spinner prefix and says "Action Required" when
          // it is blocked on the user.
          const titleState = harness.parseTitleState(payload);
          // Remembered for the OSC 9;4 handler below, which trusts the title
          // over a progress report from any process in the PTY.
          if (titleState) session._titleBusy = titleState === 'busy';
          const isBusy = titleState === 'busy';
          const isIdle = titleState === 'idle' || titleState === 'attention';
          log.debug(`[OSC 0] session=${currentId} state=${titleState || 'none'} wasBusy=${!!session._cliBusy}`);

          // A blocked session is announced by OSC 9 too, but only when the CLI's
          // notifications are on — which a session started before Switchboard
          // began forcing them is not. The title is the signal that is always
          // there, so it raises attention on its own. Latched, because the title
          // is rewritten on every repaint.
          if (titleState === 'attention') {
            if (!session._titleAttention) {
              session._titleAttention = true;
              log.info(`[OSC 0] session=${currentId} → ATTENTION "${payload}"`);
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('terminal-notification', currentId, payload, 'attention');
              }
            }
          } else if (titleState) {
            session._titleAttention = false;
          }

          if (isBusy && !session._cliBusy) {
            session._cliBusy = true;
            session._oscIdle = false;
            log.debug(`[OSC 0] session=${currentId} → BUSY`);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('cli-busy-state', currentId, true);
            }
          } else if (isIdle && session._cliBusy) {
            session._cliBusy = false;
            session._oscIdle = true;
            if (titleState === 'idle') notifyAgentFinished(session, currentId);
            log.debug(`[OSC 0] session=${currentId} → IDLE`);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('cli-busy-state', currentId, false);
            }
          }
        }
      }
      // Parse iTerm2 OSC 9 sequences (terminated by BEL \x07 or ST \x1b\\)
      const osc9Matches = data.matchAll(/\x1b\]9;([^\x07\x1b]*)(?:\x07|\x1b\\)/g);
      for (const osc9 of osc9Matches) {
        const payload = osc9[1];
        // OSC 9;4 progress: 4;0; = clear/done, 4;1;N = running at N%, 4;2;N = error, 4;3; = indeterminate
        if (payload.startsWith('4;')) {
          const level = payload.split(';')[1];
          const progressState = progressBusyState({ level, titleBusy: !!session._titleBusy });
          log.debug(`[OSC 9;4] session=${currentId} level=${level} payload="${payload}" state=${progressState || 'none'} titleBusy=${!!session._titleBusy} wasBusy=${!!session._cliBusy}`);
          if (progressState === 'busy' && !session._cliBusy) {
            session._cliBusy = true;
            session._oscIdle = false;
            log.debug(`[OSC 9;4] session=${currentId} → BUSY`);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('cli-busy-state', currentId, true);
            }
          } else if (progressState === 'idle' && session._cliBusy) {
            // The end of the progress run. Without acting on this, a busy state
            // raised by 9;4 could only be cleared by a spinner-to-idle title
            // change, which does not come for a slash command — the session sat
            // spinning until Claude's "waiting for your input" notice a full
            // minute later.
            session._cliBusy = false;
            session._oscIdle = true;
            notifyAgentFinished(session, currentId);
            log.debug(`[OSC 9;4] session=${currentId} → IDLE`);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('cli-busy-state', currentId, false);
            }
          }
        } else {
          // Regular notification (attention, permission, etc.). The harness
          // decides what its own wording means — codex says "Approval
          // requested: …" where Claude says "needs your permission…" — so the
          // renderer is handed a kind rather than re-deriving one from text.
          const kind = harness ? harness.classifyNotification(payload) : null;
          log.info(`[OSC 9] session=${currentId} kind=${kind || 'none'} message="${payload}"`);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('terminal-notification', currentId, payload, kind);
          }
        }
      }
    }

    // Standalone BEL (not part of an OSC sequence)
    if (data.includes('\x07') && !data.includes('\x1b]')) {
      log.info(`[BEL] session=${currentId}`);
    }

    // Track alternate screen mode (only if data contains the marker)
    if (data.includes('\x1b[?')) {
      if (data.includes('\x1b[?1049h') || data.includes('\x1b[?47h')) {
        session.altScreen = true;
        log.info(`[altscreen] session=${currentId} ON`);
      }
      if (data.includes('\x1b[?1049l') || data.includes('\x1b[?47l')) {
        session.altScreen = false;
        log.info(`[altscreen] session=${currentId} OFF`);
      }
    }

    // Buffer output (skip resize-triggered redraws for plain terminals)
    if (!session._suppressBuffer) {
      session.outputBuffer.push(data);
      session.outputBufferSize += data.length;
      while (session.outputBufferSize > MAX_BUFFER_SIZE && session.outputBuffer.length > 1) {
        session.outputBufferSize -= session.outputBuffer.shift().length;
      }
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal-data', currentId, data);
    }
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    session.exited = true;

    const realId = session.realSessionId || sessionId;
    // The renderer needs to tell "the user ended this" from "this died" to
    // decide whether to tear the terminal down or leave it up with a banner.
    // A signal kill reports exitCode 0, so pass the signal and the
    // stop-session flag along rather than making it guess from the code.
    const stopRequested = !!session.stopRequested;
    if (!appIsQuitting && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('process-exited', realId, exitCode, signal, stopRequested);
      // If a fork/plan-accept transition re-keyed this session under realId
      // but the PTY exited before transition detection ran, also notify the
      // renderer for the original sessionId so it doesn't stay stuck as "Running".
      if (realId !== sessionId && activeSessions.has(sessionId)) {
        mainWindow.webContents.send('process-exited', sessionId, exitCode, signal, stopRequested);
      }
    }
    activeSessions.delete(realId);
    // Clean up the original key too in case transition detection hasn't run yet
    activeSessions.delete(sessionId);
  });

  if (sessionOptions?.forkFrom) {
    log.info(`[fork-spawn] tempId=${sessionId} forkFrom=${sessionOptions.forkFrom} folder=${projectFolder} knownFiles=${knownJsonlFiles.size}`);
  }

  return { ok: true, reattached: false };
});

// --- IPC: terminal-input (fire-and-forget) ---
ipcMain.on('terminal-input', (_event, sessionId, data) => {
  const session = activeSessions.get(sessionId);
  if (session && !session.exited) {
    session.pty.write(data);
  }
});

// --- IPC: terminal-resize (fire-and-forget) ---
ipcMain.on('terminal-resize', (_event, sessionId, cols, rows) => {
  const session = activeSessions.get(sessionId);
  if (session && !session.exited) {
    // For plain terminals, suppress buffering during resize to avoid
    // accumulating prompt redraws that pollute reattach replay
    if (session.isPlainTerminal) session._suppressBuffer = true;

    session.pty.resize(cols, rows);

    if (session.isPlainTerminal) {
      setTimeout(() => { session._suppressBuffer = false; }, 200);
    }

    // First resize: nudge to force TUI redraw on reattach (skip for plain terminals — causes duplicate prompts)
    if (session.firstResize && !session.isPlainTerminal) {
      session.firstResize = false;
      setTimeout(() => {
        try {
          session.pty.resize(cols + 1, rows);
          setTimeout(() => {
            try { session.pty.resize(cols, rows); } catch {}
          }, 50);
        } catch {}
      }, 50);
    }
  }
});

// --- IPC: close-terminal ---
ipcMain.on('close-terminal', (_event, sessionId) => {
  const session = activeSessions.get(sessionId);
  if (session) {
    session.rendererAttached = false;
    if (session.exited) {
      activeSessions.delete(sessionId);
    }
  }
});

// --- Plain-terminal activity: working, or waiting at the prompt? ---

// Held so a toast is not garbage-collected before Windows displays it.
const finishedNotifications = new Set();
// The terminal the renderer has selected, reported by set-active-terminal.
let activeTerminalId = null;
ipcMain.on('set-active-terminal', (_event, sessionId) => {
  activeTerminalId = sessionId || null;
});

/**
 * A CLI session went from working to waiting. Plain terminals are skipped: every command would notify.
 * Silent when the window has focus and this is the session the user is looking at.
 */
function notifyAgentFinished(session, sessionId) {
  if (session.isPlainTerminal || !Notification.isSupported()) return;
  const windowFocused = !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused();
  if (windowFocused && sessionId === activeTerminalId) return;
  const notification = new Notification({
    title: 'AgentsBoard',
    body: `El agente terminó de trabajar: ${path.basename(session.projectPath || '')}`,
  });
  finishedNotifications.add(notification);
  notification.on('close', () => finishedNotifications.delete(notification));
  notification.show();
}

/** One place to tell the renderer a terminal started or stopped working. */
function sendTerminalBusy(session, sessionId, busy) {
  session._cliBusy = busy;
  log.debug(`[terminal-activity] session=${sessionId} → ${busy ? 'BUSY' : 'IDLE'} ${JSON.stringify(session.activity.state())}`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('cli-busy-state', sessionId, busy);
  }
}

// One sweep for every tracked terminal rather than a timer each. Reading
// `pty.process` costs ~18us, and only a shell that sends no prompt marks is
// read at all, so 50 terminals stay well under a millisecond per sweep.
const TERMINAL_ACTIVITY_INTERVAL_MS = 500;
let terminalActivityTimer = null;

function sweepTerminalActivity() {
  let tracked = 0;
  for (const [sessionId, session] of activeSessions) {
    if (!session.activity || session.exited) continue;
    tracked++;
    let busy = null;
    if (session.activity.needsPoll()) {
      // A PTY that has just exited throws here rather than returning a name.
      let name = null;
      try { name = session.pty.process; } catch {}
      busy = session.activity.feedProcess(name);
    }
    // Ticked either way: a silent command crosses the busy threshold with no
    // output to settle on.
    if (busy === null) busy = session.activity.tick();
    if (busy !== null) sendTerminalBusy(session, sessionId, busy);
  }
  if (tracked === 0) {
    clearInterval(terminalActivityTimer);
    terminalActivityTimer = null;
  }
}

/** Started when the first terminal appears, stopped when the last one goes. */
function startTerminalActivitySweep() {
  if (terminalActivityTimer) return;
  terminalActivityTimer = setInterval(sweepTerminalActivity, TERMINAL_ACTIVITY_INTERVAL_MS);
  terminalActivityTimer.unref?.();
}

// Session transitions → session-transitions.js
const sessionTransitions = require('./session-transitions');
sessionTransitions.init({ PROJECTS_DIR, activeSessions, getMainWindow: () => mainWindow, log });
const { detectSessionTransitions } = sessionTransitions;

// --- fs.watch on projects directory ---
let projectsWatcher = null;

function startProjectsWatcher() {
  if (!fs.existsSync(PROJECTS_DIR)) return;
  if (!harnessEnabled(DEFAULT_HARNESS)) return;

  const pendingFolders = new Set();
  let debounceTimer = null;

  function flushChanges() {
    debounceTimer = null;
    const folders = new Set(pendingFolders);
    pendingFolders.clear();

    // Claim a fork's transcript before indexing it, so the renderer learns the
    // real id in the same beat the row appears. A Claude fork mints its own id
    // (--fork-session ignores --session-id), so it needs this exactly as codex
    // sessions do.
    if (hasPendingLaunches()) {
      const candidates = [];
      for (const folder of folders) {
        try { candidates.push(...claudeHarness.listTranscripts(path.join(PROJECTS_DIR, folder))); } catch {}
      }
      resolvePendingLaunches(candidates);
    }

    let changed = false;
    for (const folder of folders) {
      const folderPath = path.join(PROJECTS_DIR, folder);
      if (fs.existsSync(folderPath)) {
        detectSessionTransitions(folder);
        refreshFolder(folder);
      } else {
        deleteCachedFolder(folder);
      }
      changed = true;
    }

    if (changed) {
      // A transcript folder moved: sessions only, not the projects themselves.
      notifyRendererProjectsChanged('sessions');
    }
  }

  try {
    projectsWatcher = fs.watch(PROJECTS_DIR, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;

      // filename is relative, e.g. "folder-name/sessions-index.json" or "folder-name/abc.jsonl"
      const parts = filename.split(path.sep);
      const folder = parts[0];
      if (!folder || folder === '.git') return;

      // Only care about .jsonl changes or top-level folder add/remove
      const basename = parts[parts.length - 1];
      if (parts.length === 1) {
        pendingFolders.add(folder);
      } else if (basename.endsWith('.jsonl')) {
        pendingFolders.add(folder);
      } else {
        return;
      }

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(flushChanges, 500);
    });

    projectsWatcher.on('error', (err) => {
      console.error('Projects watcher error:', err);
    });
  } catch (err) {
    console.error('Failed to start projects watcher:', err);
  }
}

/**
 * Adopt a just-written transcript as the real identity of a pending session.
 *
 * A harness that cannot be told its session id up front (codex) is launched
 * under a temporary uuid. When its transcript appears, the session is re-keyed
 * onto the real id — everything downstream (terminal data, exit, the renderer's
 * sidebar row) follows session.realSessionId, exactly as fork detection does.
 */
function resolvePendingLaunches(candidatePaths) {
  for (const [tempId, session] of [...activeSessions]) {
    if (session.exited || !session.pendingLaunch || session.realSessionId) continue;
    const harness = getHarness(session.runtime);
    if (!harness.matchesLaunch) continue;

    for (const filePath of candidatePaths) {
      const signals = harness.readLaunchSignals(filePath);
      if (!harness.matchesLaunch(signals, session.pendingLaunch)) continue;
      // Another live session already owns this transcript.
      if (activeSessions.has(signals.sessionId)) continue;

      const realId = signals.sessionId;
      log.info(`[launch-detect] ${tempId} → ${realId} (originator=${signals.originator || 'none'})`);
      session.realSessionId = realId;
      session.pendingLaunch = null;
      activeSessions.delete(tempId);
      activeSessions.set(realId, session);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('session-detected', tempId, realId);
      }
      break;
    }
  }
}

/**
 * Look through every folder a pending session could have landed in.
 *
 * Only the folders that changed since the launch are worth reading, which in
 * practice is today's date directory.
 */
function sweepPendingLaunches() {
  const roots = new Map(); // harness → earliest spawn time still waiting
  for (const session of activeSessions.values()) {
    if (session.exited || !session.pendingLaunch || session.realSessionId) continue;
    const h = getHarness(session.runtime);
    if (!h.matchesLaunch) continue;
    const at = session.pendingLaunch.spawnedAt;
    roots.set(h, Math.min(roots.get(h) ?? at, at));
  }

  for (const [h, since] of roots) {
    const candidates = [];
    // Claude's folders live under the injected PROJECTS_DIR, not its own root.
    const dirs = h.folderPrefix
      ? h.listFolders().map(f => h.folderPath(f.slice(h.folderPrefix.length)))
      : h.listFolders().map(f => path.join(PROJECTS_DIR, f));
    for (const dir of dirs) {
      for (const filePath of h.listTranscripts(dir)) {
        try {
          if (fs.statSync(filePath).mtimeMs >= since - 60000) candidates.push(filePath);
        } catch {}
      }
    }
    resolvePendingLaunches(candidates);
  }
}

/** Is any session still waiting for its transcript to appear? */
function hasPendingLaunches() {
  for (const session of activeSessions.values()) {
    if (!session.exited && session.pendingLaunch && !session.realSessionId) return true;
  }
  return false;
}

// --- fs.watch on each non-Claude harness's sessions directory ---
//
// Separate from startProjectsWatcher because the path shape is different: a
// Claude event names <project-folder>/<file>, a codex event names
// <YYYY>/<MM>/<DD>/<file>. Both end up calling refreshFolder with a folder key.
const harnessWatchers = [];

function resolveHarnessFolderPath(folder) {
  const h = getHarnessForFolder(folder);
  return h.folderPath(h.folderPrefix ? folder.slice(h.folderPrefix.length) : folder);
}

function stopHarnessWatchers() {
  while (harnessWatchers.length) {
    try { harnessWatchers.pop().close(); } catch {}
  }
}

function startHarnessWatchers() {
  for (const h of availableHarnesses()) {
    if (!h.folderPrefix) continue; // Claude's root is startProjectsWatcher's job
    if (!harnessEnabled(h.id)) continue;
    const root = h.sessionsRoot();
    if (!fs.existsSync(root)) continue;

    const pendingFolders = new Set();
    let debounceTimer = null;

    function flush() {
      debounceTimer = null;
      const folders = new Set(pendingFolders);
      pendingFolders.clear();

      // Claim transcripts before indexing them, so the renderer learns the real
      // session id in the same beat the row appears.
      if (hasPendingLaunches()) {
        const candidates = [];
        for (const folder of folders) {
          try { candidates.push(...h.listTranscripts(resolveHarnessFolderPath(folder))); } catch {}
        }
        resolvePendingLaunches(candidates);
      }

      for (const folder of folders) {
        try { refreshFolder(folder); } catch (err) { log.error('[harness-watch]', folder, err.message); }
      }
      const titlesChanged = refreshHarnessTitles(h);
      if (folders.size || titlesChanged) notifyRendererProjectsChanged('sessions');
    }

    try {
      const watcher = fs.watch(root, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        const parts = filename.split(path.sep);
        // Transcripts sit at <YYYY>/<MM>/<DD>/<file>; anything shallower is a
        // directory being created, which the next file event will cover.
        if (parts.length < 4 || !parts[parts.length - 1].endsWith('.jsonl')) return;
        pendingFolders.add(h.folderPrefix + parts.slice(0, 3).join('/'));
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(flush, 500);
      });
      watcher.on('error', (err) => log.error(`[harness-watch] ${h.id}:`, err.message));
      harnessWatchers.push(watcher);
      log.info(`[harness-watch] watching ${h.id} at ${root}`);
    } catch (err) {
      log.error(`[harness-watch] failed to watch ${h.id}:`, err.message);
    }

    // Codex names live next to sessions/, not underneath it, so the recursive
    // transcript watcher above can never observe an auto-title or `/rename`.
    // Watch the containing directory so atomic replacement of the index is
    // handled as well as ordinary appends.
    if (h.titleIndexPath && h.readSessionTitles) {
      const indexPath = h.titleIndexPath();
      const indexDir = path.dirname(indexPath);
      const indexName = path.basename(indexPath);
      let titleTimer = null;
      try {
        const titleWatcher = fs.watch(indexDir, (_eventType, filename) => {
          if (filename && String(filename) !== indexName) return;
          if (titleTimer) clearTimeout(titleTimer);
          titleTimer = setTimeout(() => {
            titleTimer = null;
            if (refreshHarnessTitles(h)) notifyRendererProjectsChanged('sessions');
          }, 300);
        });
        titleWatcher.on('error', (err) => log.error(`[harness-title-watch] ${h.id}:`, err.message));
        harnessWatchers.push(titleWatcher);
        log.info(`[harness-title-watch] watching ${h.id} at ${indexPath}`);
      } catch (err) {
        log.error(`[harness-title-watch] failed to watch ${h.id}:`, err.message);
      }
    }
  }
}

// --- IPC: app version ---
ipcMain.handle('get-app-version', () => app.getVersion());

// --- App lifecycle ---
// Prevent a second Electron instance from killing active PTY sessions.
// This happens when the user replaces the AppImage while Switchboard is running:
// the OS spawns the new binary, which would otherwise initialise a second process
// and leave the first one's node-pty sessions orphaned or killed.
// requestSingleInstanceLock ensures only one instance runs at a time. The second
// launch quits immediately; the first brings its window to the front.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  // Focus the existing window when a second launch is attempted.
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });


  app.whenReady().then(() => {
    // Matches build.appId so Windows attributes notifications to AgentsBoard.
    if (process.platform === 'win32') app.setAppUserModelId('ai.doctly.agentsboard');
    Menu.setApplicationMenu(null);
    createWindow();
    startProjectsWatcher();
    startHarnessWatchers();

    // Re-index search if FTS table was recreated (e.g. tokenizer config change)
    if (searchFtsRecreated) populateCacheViaWorker();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }); // end app.whenReady
} // end gotSingleInstanceLock else-branch

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // The renderer persists raw-terminal descriptors and scrollback during its
  // unload. Do not report the shutdown kills as user-initiated terminal exits,
  // or that renderer cleanup would delete the descriptors before restart.
  appIsQuitting = true;

  // Close filesystem watcher
  if (projectsWatcher) {
    projectsWatcher.close();
    projectsWatcher = null;
  }

  // Kill all PTY processes on quit
  for (const [, session] of activeSessions) {
    if (!session.exited) {
      try { session.pty.kill(); } catch {}
    }
  }
});

// Close SQLite after all windows are closed to avoid "connection is not open" errors
app.on('will-quit', () => {
  closeDb();
});
