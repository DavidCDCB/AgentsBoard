// --- Dialogs & session launch helpers ---
// Depends on globals: launchNewSession, cachedProjects, cachedAllProjects, sessionMap,
// pendingSessions, openSessions, activePtyIds, refreshSidebar, pollActiveSessions (app.js)
// Depends on: ICONS (icons.js)//
// Dialog rule: a click on the backdrop does nothing. These hold typed work, and
// a stray click used to throw it away. Escape and Cancel are the ways out.

// --- New session dialog ---
async function resolveDefaultSessionOptions(project) {
  const effective = await window.api.getEffectiveSettings(project.projectPath);
  // All quick-launch callers share the same option registry as the forms.
  // A harness reads only its own fields; explicit false/null/empty defaults
  // remain intact instead of being mistaken for missing settings.
  const keys = new Set(Object.keys(SessionConfig.FIELDS).flatMap(runtime =>
    SessionConfig.fieldsFor(runtime).map(field => field.key)));
  return Object.fromEntries([...keys].filter(key => SessionConfig.own(effective, key))
    .map(key => [key, effective[key]]));
}

async function forkSession(session, project) {
  const options = await resolveDefaultSessionOptions(project);
  options.forkFrom = session.sessionId;
  // A fork runs on the CLI that wrote the session being forked, not whatever
  // the default is — `codex fork` cannot continue a Claude transcript.
  if (session.runtime) options.runtime = session.runtime;
  launchNewSession(project, options);
}

function showNewSessionPopover(project, anchorEl) {
  // Remove any existing popover
  document.querySelectorAll('.new-session-popover').forEach(el => el.remove());

  const popover = document.createElement('div');
  popover.className = 'new-session-popover';

  function addOption(html, className, onClick) {
    const btn = document.createElement('button');
    btn.className = 'popover-option' + (className ? ' ' + className : '');
    btn.innerHTML = html;
    btn.onclick = onClick;
    popover.appendChild(btn);
    return btn;
  }

  // One pair of rows per CLI, built from what main reports rather than
  // hardcoded, so a CLI added later appears without a change here. Switching
  // one off in settings is what takes it out of the list.
  function render(harnesses) {
    popover.replaceChildren();
    for (const h of harnesses) {
      const icon = h.id === 'codex'
        ? ICONS.codex(16, 'popover-option-icon codex-icon')
        : ICONS.claude(16, 'popover-option-icon claude-icon');
      addOption(`${icon} ${escapeHtml(h.label)}`, 'popover-option-' + h.id, async () => {
        popover.remove();
        const options = await resolveDefaultSessionOptions(project);
        options.runtime = h.id;
        launchNewSession(project, options);
      });
      addOption(`${icon} ${escapeHtml(h.label)} (Configure...)`, 'popover-option-' + h.id, () => {
        popover.remove();
        showNewSessionDialog(project, h.id);
      });
    }
    addOption(
      ICONS.terminal(16, 'popover-option-icon terminal-icon') + ' Terminal',
      'popover-option-terminal',
      () => { popover.remove(); launchTerminalSession(project); }
    );
    position();
  }

  function position() {
    const rect = anchorEl.getBoundingClientRect();
    const popoverHeight = popover.offsetHeight;
    if (rect.bottom + 4 + popoverHeight > window.innerHeight) {
      popover.style.top = (rect.top - popoverHeight - 4) + 'px';
    } else {
      popover.style.top = (rect.bottom + 4) + 'px';
    }
    popover.style.left = rect.left + 'px';
  }

  document.body.appendChild(popover);
  // Claude alone until main answers, so the popover never renders empty.
  render([{ id: 'claude', label: 'Claude' }]);
  window.api.getHarnesses()
    .then(list => {
      // Every switched-on CLI is offered. Whether its binary is actually
      // installed is not something the main process can tell — sessions run
      // through a login shell with a different PATH — so launching is what
      // finds out, and the shell's own error lands in the terminal.
      const usable = (list || []).filter(h => h.enabled);
      if (popover.isConnected && usable.length) render(usable);
    })
    .catch(() => {});

  // Close on click outside
  function onClickOutside(e) {
    if (!popover.contains(e.target) && e.target !== anchorEl) {
      popover.remove();
      document.removeEventListener('mousedown', onClickOutside);
    }
  }
  setTimeout(() => document.addEventListener('mousedown', onClickOutside), 0);
}

/** Start or reattach a raw terminal without routing it through a CLI harness. */
async function openRawTerminalSession(session, { show = true } = {}) {
  const { sessionId, projectPath } = session;
  const entry = openSessions.get(sessionId) || createTerminalEntry(session);
  const result = await window.api.openTerminal(sessionId, projectPath, true, {
    type: 'terminal',
  });
  if (!result.ok) {
    entry.terminal.write(`\r\nError: ${result.error}\r\n`);
    entry.closed = true;
    return result;
  }
  entry.closed = false;
  persistTerminalSession(session);
  if (show) showSession(sessionId);
  return result;
}

async function launchTerminalSession(project) {
  const session = {
    sessionId: crypto.randomUUID(),
    summary: 'Terminal',
    firstPrompt: '',
    projectPath: project.projectPath,
    name: null,
    starred: 0,
    archived: 0,
    messageCount: 0,
    modified: new Date().toISOString(),
    created: new Date().toISOString(),
    type: 'terminal',
  };

  // Track as pending
  const { sessionId, projectPath } = session;
  const folder = encodeProjectPath(projectPath);
  pendingSessions.set(sessionId, { session, projectPath, folder });

  // Inject into cached project data
  sessionMap.set(sessionId, session);
  for (const projList of [cachedProjects, cachedAllProjects]) {
    let proj = projList.find(p => p.projectPath === projectPath);
    if (!proj) {
      proj = { folder, projectPath, sessions: [] };
      projList.unshift(proj);
    }
    proj.sessions.unshift(session);
  }
  refreshSidebar();

  await openRawTerminalSession(session);
  pollActiveSessions();
}

async function showNewSessionDialog(project, runtime = 'claude') {
  const effective = await window.api.getEffectiveSettings(project.projectPath);
  const overlay = document.createElement('div');
  overlay.className = 'new-session-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'new-session-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.innerHTML = `
    <h3>Nueva sesión de ${escapeHtml(runtime === 'codex' ? 'Codex' : runtime === 'claude' ? 'Claude' : runtime)} — ${escapeHtml(shortProjectPath(project.projectPath))}</h3>
    <div class="session-config-fields"></div>
    <div class="session-config-error" role="alert" hidden></div>
    <div class="new-session-actions">
      <button type="button" class="new-session-cancel-btn">Cancelar</button>
      <button type="button" class="new-session-start-btn">Iniciar</button>
    </div>`;
  const form = SessionConfigForm.mount(dialog.querySelector('.session-config-fields'), { runtime, defaults: effective });
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  function start() {
    let options;
    try { options = form.getOptions(); } catch (err) {
      const error = dialog.querySelector('.session-config-error');
      error.textContent = err.message; error.hidden = false;
      return;
    }
    close();
    launchNewSession(project, { ...options, runtime });
  }
  dialog.querySelector('.new-session-cancel-btn').onclick = close;
  dialog.querySelector('.new-session-start-btn').onclick = start;
  function onKey(e) {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) start();
  }
  document.addEventListener('keydown', onKey);
}

async function showResumeSessionDialog(session) {
  const effective = await window.api.getEffectiveSettings(session.projectPath);

  const overlay = document.createElement('div');
  overlay.className = 'new-session-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'new-session-dialog';

  let selectedMode = effective.permissionMode || null;
  let dangerousSkip = effective.dangerouslySkipPermissions || false;

  const modes = PERMISSION_MODES;

  function renderModeGrid() {
    return modes.map(m => {
      const isSelected = !dangerousSkip && selectedMode === m.value;
      return `<button class="permission-option${isSelected ? ' selected' : ''}" data-mode="${m.value}"><span class="perm-name">${m.label}</span><span class="perm-desc">${m.desc}</span></button>`;
    }).join('') +
    `<button class="permission-option dangerous${dangerousSkip ? ' selected' : ''}" data-mode="dangerous-skip"><span class="perm-name">Omitir permisos</span><span class="perm-desc">Omite todas las confirmaciones de seguridad (usar con cuidado)</span></button>`;
  }

  const sessionName = session.name || session.aiTitle || session.summary || session.sessionId.slice(0, 8);

  dialog.innerHTML = `
    <h3>Reanudar sesión — ${escapeHtml(sessionName)}</h3>
    <div class="settings-field">
      <div class="settings-label">Modo de permisos</div>
      <div class="permission-grid" id="rsd-mode-grid">${renderModeGrid()}</div>
    </div>
    <div class="settings-field">
      <div class="settings-field-info">
        <span class="settings-label">Chrome</span>
        <div class="settings-description">Habilita la automatización del navegador Chrome</div>
      </div>
      <div class="settings-field-control">
        <label class="settings-toggle"><input type="checkbox" id="rsd-chrome" ${effective.chrome ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
      </div>
    </div>
    <div class="settings-field settings-field-wide">
      <div class="settings-field-info">
        <span class="settings-label">Comando previo al inicio</span>
        <div class="settings-description">Se antepone al comando claude</div>
      </div>
      <div class="settings-field-control">
        <input type="text" class="settings-input" id="rsd-pre-launch" placeholder="ej. aws-vault exec profile --" value="${escapeHtml(effective.preLaunchCmd || '')}">
      </div>
    </div>
    <div class="settings-field settings-field-wide">
      <div class="settings-field-info">
        <span class="settings-label">Directorios adicionales</span>
        <div class="settings-description">Directorios extra a incluir (separados por comas)</div>
      </div>
      <div class="settings-field-control">
        <input type="text" class="settings-input" id="rsd-add-dirs" placeholder="/path/to/dir1, /path/to/dir2" value="${escapeHtml(effective.addDirs || '')}">
      </div>
    </div>
    <div class="new-session-actions">
      <button class="new-session-cancel-btn">Cancelar</button>
      <button class="new-session-start-btn">Reanudar</button>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  // Bind mode grid clicks
  const modeGrid = dialog.querySelector('#rsd-mode-grid');
  modeGrid.addEventListener('click', (e) => {
    const btn = e.target.closest('.permission-option');
    if (!btn) return;
    const mode = btn.dataset.mode;
    if (mode === 'dangerous-skip') {
      dangerousSkip = !dangerousSkip;
      if (dangerousSkip) selectedMode = null;
    } else {
      dangerousSkip = false;
      selectedMode = mode === 'null' ? null : mode;
    }
    modeGrid.innerHTML = renderModeGrid();
  });

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }

  function resume() {
    const options = {};
    if (dangerousSkip) {
      options.dangerouslySkipPermissions = true;
    } else if (selectedMode) {
      options.permissionMode = selectedMode;
    }
    if (dialog.querySelector('#rsd-chrome').checked) {
      options.chrome = true;
    }
    const preLaunch = dialog.querySelector('#rsd-pre-launch').value.trim();
    if (preLaunch) options.preLaunchCmd = preLaunch;
    options.addDirs = dialog.querySelector('#rsd-add-dirs').value.trim();
    close();
    openSession(session, options);
  }

  dialog.querySelector('.new-session-cancel-btn').onclick = close;
  dialog.querySelector('.new-session-start-btn').onclick = resume;

  function onKey(e) {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && !e.target.matches('input')) resume();
  }
  document.addEventListener('keydown', onKey);
}

// Settings viewer is in settings-panel.js (openSettingsViewer / closeSettingsViewer)
// Global settings button binding is in app.js (needs DOM refs)
