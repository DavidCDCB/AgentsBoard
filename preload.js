const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Invoke (request-response)
  getUsage: () => ipcRenderer.invoke('get-usage'),
  getCodexUsage: () => ipcRenderer.invoke('get-codex-usage'),
  getProjects: (showArchived) => ipcRenderer.invoke('get-projects', showArchived),
  browseFolder: () => ipcRenderer.invoke('browse-folder'),
  addProject: (dirPath) => ipcRenderer.invoke('add-project', dirPath),
  removeProject: (dirPath) => ipcRenderer.invoke('remove-project', dirPath),
  getHarnesses: () => ipcRenderer.invoke('get-harnesses'),
  getCodexModels: () => ipcRenderer.invoke('get-codex-models'),
  getActiveSessions: () => ipcRenderer.invoke('get-active-sessions'),
  getActiveTerminals: () => ipcRenderer.invoke('get-active-terminals'),
  stopSession: (id) => ipcRenderer.invoke('stop-session', id),
  toggleStar: (id) => ipcRenderer.invoke('toggle-star', id),
  renameSession: (id, name) => ipcRenderer.invoke('rename-session', id, name),
  archiveSession: (id, archived) => ipcRenderer.invoke('archive-session', id, archived),
  openTerminal: (id, projectPath, isNew, sessionOptions) => ipcRenderer.invoke('open-terminal', id, projectPath, isNew, sessionOptions),
  search: (type, query, titleOnly) => ipcRenderer.invoke('search', type, query, titleOnly),
  searchSessionIds: (query, sessionIds) => ipcRenderer.invoke('search-session-ids', query, sessionIds),
  readSessionJsonl: (sessionId) => ipcRenderer.invoke('read-session-jsonl', sessionId),
  getSessionLastMessage: (sessionId) => ipcRenderer.invoke('get-session-last-message', sessionId),

  // Settings
  getSetting: (key) => ipcRenderer.invoke('get-setting', key),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
  getEffectiveSettings: () => ipcRenderer.invoke('get-effective-settings'),
  getShellProfiles: () => ipcRenderer.invoke('get-shell-profiles'),

  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openPath: (target) => ipcRenderer.invoke('open-path', target),
  writeClipboard: (text) => ipcRenderer.invoke('clipboard-write-text', text),

  // Send (fire-and-forget)
  sendInput: (id, data) => ipcRenderer.send('terminal-input', id, data),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send('terminal-resize', id, cols, rows),
  closeTerminal: (id) => ipcRenderer.send('close-terminal', id),
  setActiveTerminal: (id) => ipcRenderer.send('set-active-terminal', id),

  // Listeners (main → renderer)
  onTerminalData: (callback) => {
    ipcRenderer.on('terminal-data', (_event, sessionId, data) => callback(sessionId, data));
  },
  onSessionDetected: (callback) => {
    ipcRenderer.on('session-detected', (_event, tempId, realId) => callback(tempId, realId));
  },
  onHarnessesChanged: (callback) => {
    ipcRenderer.on('harnesses-changed', () => callback());
  },
  onProcessExited: (callback) => {
    ipcRenderer.on('process-exited', (_event, sessionId, exitCode, signal, userStopped) =>
      callback(sessionId, exitCode, signal, userStopped));
  },
  onTerminalNotification: (callback) => {
    ipcRenderer.on('terminal-notification', (_event, sessionId, message, kind) => callback(sessionId, message, kind));
  },
  onCliBusyState: (callback) => {
    ipcRenderer.on('cli-busy-state', (_event, sessionId, busy) => callback(sessionId, busy));
  },
  onSessionForked: (callback) => {
    ipcRenderer.on('session-forked', (_event, oldId, newId) => callback(oldId, newId));
  },
  onProjectsChanged: (callback) => {
    ipcRenderer.on('projects-changed', (_e, reason) => callback(reason || 'project'));
  },
  onStatusUpdate: (callback) => {
    ipcRenderer.on('status-update', (_event, text, type) => callback(text, type));
  },

  // File drag-and-drop
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // Platform
  platform: process.platform,

  resolveTerminalFiles: (references, context) => ipcRenderer.invoke('resolve-terminal-files', references, context),
});
