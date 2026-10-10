// Settings panel component
// Manages the global settings viewer UI.

(function () {
  const settingsViewer = document.getElementById('settings-viewer');
  const settingsViewerTitle = document.getElementById('settings-viewer-title');
  const settingsViewerBody = document.getElementById('settings-viewer-body');

  function closeSettingsViewer() {
    settingsViewer.style.display = 'none';
    const terminalArea = document.getElementById('terminal-area');
    const placeholder = document.getElementById('placeholder');
    const gridViewActive = localStorage.getItem('gridViewActive') === '1';
    const activeSessionId = sessionStorage.getItem('activeSessionId') || null;
    // Check if there's an active session with an open terminal
    if (activeSessionId && window._openSessions && window._openSessions.has(activeSessionId)) {
      terminalArea.style.display = '';
    } else if (gridViewActive) {
      terminalArea.style.display = '';
    } else {
      placeholder.style.display = '';
    }
  }

  async function openSettingsViewer() {
    const current = (await window.api.getSetting('global')) || {};
    // What actually runs when nothing is stored: the app's defaults under the
    // saved global values. A fresh install shows these, not blanks.
    const appDefaults = (await window.api.getEffectiveSettings().catch(() => null)) || {};

    settingsViewerTitle.textContent = 'Configuración global';

    hideAllViewers();
    document.getElementById('placeholder').style.display = 'none';
    document.getElementById('terminal-area').style.display = 'none';
    settingsViewer.style.display = 'flex';

    function fieldValue(fieldName, fallback) {
      const set = (v) => v !== undefined && v !== null;
      if (set(current[fieldName])) return current[fieldName];
      return set(appDefaults[fieldName]) ? appDefaults[fieldName] : fallback;
    }

    // Fetched before the template so the toggles render as direct children of
    // their section: the card's rounded top and bottom come from
    // `.settings-section > .settings-field`, which a wrapper div would break.
    const harnesses = await window.api.getHarnesses().catch(() => []);
    const harnessFields = harnesses.map(h => `
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">${escapeHtml(h.label)}</span>
            <div class="settings-description">Busca sesiones de <code>${escapeHtml(h.id)}</code>, las muestra y ofrece usarla al iniciar una</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" class="sv-harness-toggle" data-harness="${escapeHtml(h.id)}" ${h.enabled ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>`).join('');

    const permModeValue = fieldValue('permissionMode', '');
    const codexSandboxValue = fieldValue('codexSandbox', '');
    const codexApprovalValue = fieldValue('codexApproval', '');
    const codexModelValue = fieldValue('codexModel', '');
    const worktreeValue = fieldValue('worktree', false);
    const worktreeNameValue = fieldValue('worktreeName', '');
    const chromeValue = fieldValue('chrome', false);
    const preLaunchValue = fieldValue('preLaunchCmd', '');
    const addDirsValue = fieldValue('addDirs', '');
    const visCountValue = fieldValue('visibleSessionCount', 10);
    const maxAgeValue = fieldValue('sessionMaxAgeDays', 3);
    const themeValue = fieldValue('terminalTheme', 'switchboard');
    const shellProfileValue = fieldValue('shellProfile', 'auto');

    // Discover available shell profiles
    let shellProfiles = [];
    try { shellProfiles = await window.api.getShellProfiles(); } catch {};

    settingsViewerBody.innerHTML = `
    <div class="settings-form">
      ${harnessFields ? `<div class="settings-section">
        <div class="settings-section-title">Agentes CLI</div>${harnessFields}
      </div>` : ''}

      <div class="settings-section">
        <div class="settings-section-title">Opciones de Claude CLI</div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Modo de permisos</span>
            </div>
            <div class="settings-description">Modo de permisos que se pasa al comando <code>claude</code></div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-perm-mode">
              ${PERMISSION_MODES.map(m => m.value === null
                ? '<option value="">Por defecto (ninguno)</option>'
                : `<option value="${m.value}" ${permModeValue === m.value ? 'selected' : ''}>${escapeHtml(m.label)}</option>`
              ).join('')}
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Worktree</span>
            </div>
            <div class="settings-description">Habilita worktree para las nuevas sesiones</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-worktree" ${worktreeValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Nombre del worktree</span>
            </div>
            <div class="settings-description">Nombre personalizado para las ramas del worktree</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="sv-worktree-name" placeholder="auto" value="${escapeHtml(worktreeNameValue)}" style="width:140px">
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Chrome</span>
            </div>
            <div class="settings-description">Habilita la automatización del navegador Chrome</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-chrome" ${chromeValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>

        <div class="settings-field settings-field-wide">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Directorios adicionales</span>
            </div>
            <div class="settings-description">Directorios extra que se incluyen en las sesiones de Claude</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="sv-add-dirs" placeholder="/path/to/dir1, /path/to/dir2" value="${escapeHtml(addDirsValue)}">
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Opciones de Codex CLI</div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Sandbox</span>
            </div>
            <div class="settings-description">Lo que <code>codex</code> puede tocar. Déjalo en Por defecto para usar la configuración de codex.</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-codex-sandbox">
              ${CODEX_SANDBOX_MODES.map(m => `<option value="${m.value}" ${codexSandboxValue === m.value ? 'selected' : ''}>${escapeHtml(m.label)}</option>`).join('')}
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Aprobación</span>
            </div>
            <div class="settings-description">Cuándo codex se detiene a pedir permiso antes de ejecutar un comando</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-codex-approval">
              ${CODEX_APPROVAL_POLICIES.map(m => `<option value="${m.value}" ${codexApprovalValue === m.value ? 'selected' : ''}>${escapeHtml(m.label)}</option>`).join('')}
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Modelo</span>
            </div>
            <div class="settings-description">Se pasa como <code>--model</code>; vacío usa el valor por defecto de codex</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="sv-codex-model" placeholder="default" value="${escapeHtml(codexModelValue)}" style="width:140px">
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Inicio de sesión</div>

        <div class="settings-field settings-field-wide">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Comando previo al inicio</span>
            </div>
            <div class="settings-description">Se antepone al comando claude (ej. "aws-vault exec profile --")</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="sv-pre-launch" placeholder="ej. aws-vault exec profile --" value="${escapeHtml(preLaunchValue)}">
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Aplicación</div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Tema de la terminal</span>
            <div class="settings-description">Tema de colores para las terminales</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-terminal-theme">
              ${Object.entries(TERMINAL_THEMES).map(([key, t]) =>
                `<option value="${key}" ${themeValue === key ? 'selected' : ''}>${escapeHtml(t.label)}</option>`
              ).join('')}
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Perfil de shell</span>
            <div class="settings-description">Shell usada en la terminal y las sesiones de Claude. Los cambios aplican solo a sesiones nuevas.</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-shell-profile">
              <option value="auto" ${shellProfileValue === 'auto' ? 'selected' : ''}>Auto (detectar)</option>
              ${shellProfiles.map(p =>
                `<option value="${escapeHtml(p.id)}" ${shellProfileValue === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
              ).join('')}
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Máximo de sesiones visibles</span>
              <div class="settings-description">Máximo de sesiones visibles por carpeta antes de colapsar el resto</div>
          </div>
          <div class="settings-field-control">
            <input type="number" class="settings-input settings-input-compact" id="sv-visible-count" min="1" max="100" value="${visCountValue}">
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Antigüedad máxima de sesión (días)</span>
            <div class="settings-description">Las sesiones más antiguas se ocultan tras "+N más antiguas" aunque estén dentro del límite</div>
          </div>
          <div class="settings-field-control">
            <input type="number" class="settings-input settings-input-compact" id="sv-max-age" min="1" max="365" value="${maxAgeValue}">
          </div>
        </div>

      </div>

      <div class="settings-btn-row">
        <button class="settings-cancel-btn" id="sv-cancel-btn">Cancelar</button>
        <button class="settings-save-btn" id="sv-save-btn">Guardar configuración</button>
      </div>
    </div>
  `;

    // At least one CLI has to stay on, or the sidebar has nothing to show and
    // the "+" menu nothing to offer. The last one still switched on is locked
    // rather than hidden, so the reason is visible. Main refuses an all-off
    // state too, for any writer that does not come through this panel.
    const harnessToggles = [...settingsViewerBody.querySelectorAll('.sv-harness-toggle')];
    function syncHarnessLock() {
      const on = harnessToggles.filter(t => t.checked);
      for (const t of harnessToggles) {
        const lock = on.length === 1 && t.checked;
        t.disabled = lock;
        const field = t.closest('.settings-field');
        const desc = field?.querySelector('.settings-description');
        if (desc && lock && !desc.dataset.originalText) {
          desc.dataset.originalText = desc.innerHTML;
          desc.textContent = 'Siempre activo: al menos una CLI debe quedar habilitada';
        } else if (desc && !lock && desc.dataset.originalText) {
          desc.innerHTML = desc.dataset.originalText;
          delete desc.dataset.originalText;
        }
      }
    }
    harnessToggles.forEach(t => t.addEventListener('change', syncHarnessLock));
    syncHarnessLock();

    // Save button
    settingsViewerBody.querySelector('#sv-save-btn').addEventListener('click', async () => {
      let settings = {};

      settings.permissionMode = settingsViewerBody.querySelector('#sv-perm-mode').value || null;
        settings.worktree = settingsViewerBody.querySelector('#sv-worktree').checked;
        settings.worktreeName = settingsViewerBody.querySelector('#sv-worktree-name').value.trim();
        settings.chrome = settingsViewerBody.querySelector('#sv-chrome').checked;
        settings.preLaunchCmd = settingsViewerBody.querySelector('#sv-pre-launch').value.trim();
        settings.addDirs = settingsViewerBody.querySelector('#sv-add-dirs').value.trim();
        settings.codexSandbox = settingsViewerBody.querySelector('#sv-codex-sandbox').value;
        settings.codexApproval = settingsViewerBody.querySelector('#sv-codex-approval').value;
        settings.codexModel = settingsViewerBody.querySelector('#sv-codex-model').value.trim();
        // Store the disabled set rather than the enabled one, so a CLI added in
        // a later version is on by default instead of silently missing.
        // Includes locked and unavailable toggles: `disabled` only stops the
        // user changing them, their checked state is still the setting.
        const toggles = [...settingsViewerBody.querySelectorAll('.sv-harness-toggle')];
        if (toggles.length) {
          settings.disabledHarnesses = toggles.filter(t => !t.checked).map(t => t.dataset.harness);
        }
        settings.visibleSessionCount = parseInt(settingsViewerBody.querySelector('#sv-visible-count').value) || 10;
        settings.sessionMaxAgeDays = parseInt(settingsViewerBody.querySelector('#sv-max-age').value) || 3;
        settings.terminalTheme = settingsViewerBody.querySelector('#sv-terminal-theme').value || 'switchboard';
        settings.shellProfile = settingsViewerBody.querySelector('#sv-shell-profile').value || 'auto';

      // Merge form values into existing settings to preserve keys not managed by the form
      const existing = (await window.api.getSetting('global')) || {};
      settings = { ...existing, ...settings };

      await window.api.setSetting('global', settings);

      if (settings.visibleSessionCount && typeof window._setVisibleSessionCount === 'function') {
        window._setVisibleSessionCount(settings.visibleSessionCount);
      }
      if (settings.sessionMaxAgeDays && typeof window._setSessionMaxAge === 'function') {
        window._setSessionMaxAge(settings.sessionMaxAgeDays);
      }
      if (settings.terminalTheme && typeof window._applyTerminalTheme === 'function') {
        window._applyTerminalTheme(settings.terminalTheme);
      }
      if (typeof refreshSidebar === 'function') refreshSidebar();

      const saveBtn = settingsViewerBody.querySelector('#sv-save-btn');
      saveBtn.textContent = '✓ Saved';
      saveBtn.style.background = '#2ea043';
      saveBtn.style.color = '#fff';
      setTimeout(() => closeSettingsViewer(), 600);
    });

    // Cancel button
    settingsViewerBody.querySelector('#sv-cancel-btn').addEventListener('click', () => {
      closeSettingsViewer();
    });

  }

  // Expose globally
  window.openSettingsViewer = openSettingsViewer;
  window.closeSettingsViewer = closeSettingsViewer;
})();
