// --- Sidebar rendering ---
// Depends on globals: sidebarContent, openSessions, activeSessionId, activePtyIds,
// pendingSessions, sessionMap, sortedOrder, searchMatchIds,
// searchMatchProjectPaths, showStarredOnly, showRunningOnly, showTodayOnly,
// visibleSessionCount, sessionMaxAgeDays, attentionSessions, responseReadySessions,
// sessionBusyState, cachedProjects, cachedAllProjects, gridCards, gridViewActive (app.js)
// Depends on: cleanDisplayName, formatDate, escapeHtml (utils.js), ICONS (icons.js),
// showSession (terminal-manager.js), confirmAndStopSession, pollActiveSessions,
// showNewSessionPopover, openSettingsViewer, showResumeSessionDialog,
// showJsonlViewer, forkSession, openSession, loadProjects, markUnread,
// clearUnread, refreshSidebar (app.js/dialogs.js)

// A session counts as running while its PTY is alive, or while it's pending —
// a just-launched session has no PTY in activePtyIds until the next poll. A
// pending session whose process died is marked exited and no longer counts.
function isSessionRunning(sessionId) {
  if (activePtyIds.has(sessionId)) return true;
  const pending = pendingSessions.get(sessionId);
  return !!pending && !pending.exited;
}

function slugId(slug) {
  return 'slug-' + slug.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function folderId(projectPath) {
  return 'project-' + projectPath.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function buildSlugGroup(slug, sessions) {
  const group = document.createElement('div');
  const id = slugId(slug);
  const expanded = getExpandedSlugs().has(id);
  group.className = expanded ? 'slug-group' : 'slug-group collapsed';
  group.id = id;

  const mostRecent = sessions.reduce((a, b) =>
    new Date(b.modified) > new Date(a.modified) ? b : a);
  const displayName = cleanDisplayName(mostRecent.name || mostRecent.aiTitle || mostRecent.summary || slug);
  const mostRecentTime = new Date(mostRecent.modified);
  const timeStr = formatDate(mostRecentTime);

  const header = document.createElement('div');
  header.className = 'slug-group-header';

  const row = document.createElement('div');
  row.className = 'slug-group-row';

  const expand = document.createElement('span');
  expand.className = 'slug-group-expand';
  expand.innerHTML = '<span class="arrow">&#9654;</span>';

  const info = document.createElement('div');
  info.className = 'slug-group-info';

  const nameEl = document.createElement('div');
  nameEl.className = 'slug-group-name';
  nameEl.textContent = displayName;

  const hasRunning = sessions.some(s => activePtyIds.has(s.sessionId));

  const meta = document.createElement('div');
  meta.className = 'slug-group-meta';
  meta.innerHTML = `<span class="slug-group-dot${hasRunning ? ' running' : ''}"></span><span class="slug-group-count">${sessions.length} ${sessions.length === 1 ? 'sesión' : 'sesiones'}</span> ${escapeHtml(timeStr)}`;

  const archiveSlugBtn = document.createElement('button');
  archiveSlugBtn.className = 'slug-group-archive-btn';
  archiveSlugBtn.title = 'Archivar todas las sesiones del grupo';
  archiveSlugBtn.innerHTML = ICONS.archive(14);

  info.appendChild(nameEl);
  info.appendChild(meta);
  row.appendChild(expand);
  row.appendChild(info);
  row.appendChild(archiveSlugBtn);
  header.appendChild(row);

  const sessionsContainer = document.createElement('div');
  sessionsContainer.className = 'slug-group-sessions';

  const promoted = [];
  const rest = [];
  for (const session of sessions) {
    if (activePtyIds.has(session.sessionId)) {
      promoted.push(session);
    } else {
      rest.push(session);
    }
  }

  if (promoted.length > 0) {
    group.classList.add('has-promoted');
    for (const session of promoted) {
      sessionsContainer.appendChild(buildSessionItem(session));
    }
    if (rest.length > 0) {
      const moreBtn = document.createElement('div');
      moreBtn.className = 'slug-group-more';
      moreBtn.id = 'sgm-' + id;
      moreBtn.textContent = `+ ${rest.length} more`;

      const olderDiv = document.createElement('div');
      olderDiv.className = 'slug-group-older';
      olderDiv.id = 'sgo-' + id;
      for (const session of rest) {
        olderDiv.appendChild(buildSessionItem(session));
      }

      sessionsContainer.appendChild(moreBtn);
      sessionsContainer.appendChild(olderDiv);
    }
  } else {
    for (const session of sessions) {
      sessionsContainer.appendChild(buildSessionItem(session));
    }
  }

  group.appendChild(header);
  group.appendChild(sessionsContainer);
  return group;
}

// Process a list of sessions: filter, sort, slug-group, order, and truncate.
// Returns { filtered, visible, older, sortOrderEntry } or null if the group
// should be skipped.
function processProjectSessions(project, resort, previousOrder = sortedOrder) {
  let filtered = project.sessions;
  if (showStarredOnly) filtered = filtered.filter(s => s.starred);
  if (showRunningOnly) filtered = filtered.filter(s => activePtyIds.has(s.sessionId));
  if (showTodayOnly) {
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    filtered = filtered.filter(s => {
      if (!s.modified) return false;
      const d = new Date(s.modified);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` === todayStr;
    });
  }
  const anyFilterActive = showStarredOnly || showRunningOnly || showTodayOnly || searchMatchIds !== null;
  if (filtered.length === 0 && !project._projectMatchedOnly && (project.sessions.length > 0 || anyFilterActive)) return null;

  // Sort
  filtered = [...filtered].sort((a, b) => {
    const aRunning = isSessionRunning(a.sessionId);
    const bRunning = isSessionRunning(b.sessionId);
    const aPri = (a.starred && aRunning ? 3 : aRunning ? 2 : a.starred ? 1 : 0);
    const bPri = (b.starred && bRunning ? 3 : bRunning ? 2 : b.starred ? 1 : 0);
    if (aPri !== bPri) return bPri - aPri;
    return sessionEventTime(b) - sessionEventTime(a);
  });

  // Slug grouping
  const slugMap = new Map();
  const ungrouped = [];
  for (const session of filtered) {
    if (session.slug) {
      if (!slugMap.has(session.slug)) slugMap.set(session.slug, []);
      slugMap.get(session.slug).push(session);
    } else {
      ungrouped.push(session);
    }
  }
  const allItems = [];
  for (const session of ungrouped) {
    const isRunning = isSessionRunning(session.sessionId);
    allItems.push({ sortTime: sessionEventTime(session), pinned: !!session.starred, running: isRunning, element: buildSessionItem(session) });
  }
  for (const [slug, sessions] of slugMap) {
    const mostRecentTime = Math.max(...sessions.map(sessionEventTime));
    const hasRunning = sessions.some(s => isSessionRunning(s.sessionId));
    const hasPinned = sessions.some(s => s.starred);
    const element = sessions.length === 1 ? buildSessionItem(sessions[0]) : buildSlugGroup(slug, sessions);
    allItems.push({ sortTime: mostRecentTime, pinned: hasPinned, running: hasRunning, element });
  }

  // Sort render items
  const prevEntry = previousOrder.find(e => e.projectPath === project.projectPath);
  if (resort || !prevEntry) {
    allItems.sort((a, b) => {
      const aPri = (a.pinned && a.running ? 3 : a.running ? 2 : a.pinned ? 1 : 0);
      const bPri = (b.pinned && b.running ? 3 : b.running ? 2 : b.pinned ? 1 : 0);
      if (aPri !== bPri) return bPri - aPri;
      return b.sortTime - a.sortTime;
    });
  } else {
    const orderIndex = new Map(prevEntry.itemIds.map((id, i) => [id, i]));
    allItems.sort((a, b) => {
      const aPos = orderIndex.get(a.element.id);
      const bPos = orderIndex.get(b.element.id);
      if (aPos !== undefined && bPos !== undefined) return aPos - bPos;
      if (aPos === undefined && bPos !== undefined) return -1;
      if (aPos !== undefined && bPos === undefined) return 1;
      return b.sortTime - a.sortTime;
    });
  }

  // Truncate
  let visible = [];
  let older = [];
  if (searchMatchIds !== null || showStarredOnly || showRunningOnly || showTodayOnly) {
    visible = allItems;
  } else {
    let count = 0;
    const ageCutoff = Date.now() - sessionMaxAgeDays * 86400000;
    for (const item of allItems) {
      if (item.running || item.pinned || (count < visibleSessionCount && item.sortTime >= ageCutoff)) {
        visible.push(item);
        count++;
      } else {
        older.push(item);
      }
    }
    if (visible.length === 0 && older.length > 0) { visible = older; older = []; }
  }

  return {
    filtered, visible, older,
    sortOrderEntry: { projectPath: project.projectPath, itemIds: allItems.map(item => item.element.id) },
  };
}

// Build the sessions list DOM (shared between folders, worktrees and projects)
function buildSessionsList(fId, visible, older) {
  const sessionsList = document.createElement('div');
  sessionsList.className = 'project-sessions';
  sessionsList.id = 'sessions-' + fId;
  for (const item of visible) sessionsList.appendChild(item.element);
  if (older.length > 0) {
    const moreBtn = document.createElement('div');
    moreBtn.className = 'sessions-more-toggle';
    moreBtn.id = 'older-' + fId;

    const moreLabel = document.createElement('span');
    moreLabel.className = 'sessions-more-label';

    const archiveOlderBtn = document.createElement('button');
    archiveOlderBtn.className = 'sessions-older-archive-btn';
    archiveOlderBtn.title = 'Archivar todas las sesiones anteriores';
    archiveOlderBtn.setAttribute('aria-label', 'Archivar todas las sesiones anteriores');
    archiveOlderBtn.innerHTML = ICONS.archive(14);

    moreBtn.appendChild(moreLabel);
    moreBtn.appendChild(archiveOlderBtn);
    const olderList = document.createElement('div');
    olderList.className = 'sessions-older';
    olderList.id = 'older-list-' + fId;
    olderList.style.display = 'none';
    for (const item of older) olderList.appendChild(item.element);
    // An older render item can be a slug group containing several sessions.
    // Count the actual unarchived session rows so this label matches the
    // archive confirmation and the work the archive button will perform.
    const olderSessionCount = olderList.querySelectorAll('.session-item:not(.archived-item)').length;
    moreLabel.textContent = `+ ${olderSessionCount} older`;
    sessionsList.appendChild(moreBtn);
    sessionsList.appendChild(olderList);
  }
  return sessionsList;
}

// morphdom callback: carry DOM-only state (collapse, expansion, an open rename)
// from the element on screen to its replacement.
function preserveSidebarDomState(fromEl, toEl) {
  // Skip updating session items that have an active rename input
  if (fromEl.classList.contains('session-item') && fromEl.querySelector('.session-rename-input')) {
    return false;
  }
  if (fromEl.classList.contains('project-header')) {
    if (fromEl.classList.contains('collapsed')) {
      toEl.classList.add('collapsed');
    } else {
      toEl.classList.remove('collapsed');
    }
  }
  if (fromEl.classList.contains('slug-group') || fromEl.classList.contains('worktree-header')) {
    if (fromEl.classList.contains('collapsed')) {
      toEl.classList.add('collapsed');
    } else {
      toEl.classList.remove('collapsed');
    }
  }
  if (fromEl.classList.contains('sessions-older') && fromEl.style.display !== 'none') {
    toEl.style.display = '';
  }
  if (fromEl.classList.contains('sessions-more-toggle') && fromEl.classList.contains('expanded')) {
    toEl.classList.add('expanded');
    const label = toEl.querySelector('.sessions-more-label');
    if (label) label.textContent = '- hide older';
  }
  if (fromEl.classList.contains('slug-group-older') && fromEl.style.display !== 'none') {
    toEl.style.display = '';
  }
  if (fromEl.classList.contains('slug-group-more') && fromEl.classList.contains('expanded')) {
    toEl.classList.add('expanded');
  }
  return true;
}

function renderProjects(projects, resort) {
  const newSidebar = document.createElement('div');

  // Sort project groups using sortedOrder as source of truth
  if (!resort && sortedOrder.length > 0) {
    const orderIndex = new Map(sortedOrder.map((e, i) => [e.projectPath, i]));
    projects = [...projects].sort((a, b) => {
      const aPos = orderIndex.get(a.projectPath);
      const bPos = orderIndex.get(b.projectPath);
      if (aPos !== undefined && bPos !== undefined) return aPos - bPos;
      if (aPos === undefined && bPos !== undefined) return -1;
      if (aPos !== undefined && bPos === undefined) return 1;
      return 0;
    });
  }
  // projects are now in the correct order (data order for resort, preserved order otherwise)

  // Detect worktree projects and group them under their parent
  const worktreePattern = /^(.+?)\/\.claude\/worktrees\/([^/]+)\/?$/;
  const worktreeMap = new Map(); // parentPath → [worktreeProject, ...]
  const worktreeSet = new Set();
  for (const project of projects) {
    const match = project.projectPath.match(worktreePattern);
    if (match) {
      const parentPath = match[1];
      if (!worktreeMap.has(parentPath)) worktreeMap.set(parentPath, []);
      worktreeMap.get(parentPath).push(project);
      worktreeSet.add(project.projectPath);
    }
  }

  const newSortedOrder = [];

  for (const project of projects) {
    // Skip worktree projects — they'll be rendered nested under their parent
    if (worktreeSet.has(project.projectPath)) continue;

    const result = processProjectSessions(project, resort);
    if (!result) continue;
    const { filtered, visible, older, sortOrderEntry } = result;
    newSortedOrder.push(sortOrderEntry);
    const fId = folderId(project.projectPath);

    // Build DOM
    const group = document.createElement('div');
    group.className = 'project-group';
    group.id = fId;

    const header = document.createElement('div');
    header.className = 'project-header';
    header.id = 'ph-' + fId;
    const shortName = shortProjectPath(project.projectPath);
    header.title = project.projectPath;
    header.innerHTML = `<span class="arrow">&#9660;</span> <span class="project-name">${escapeHtml(shortName)}</span>`;

    const archiveGroupBtn = document.createElement('button');
    archiveGroupBtn.className = 'project-archive-btn';
    archiveGroupBtn.title = 'Archivar todas las sesiones';
    archiveGroupBtn.innerHTML = ICONS.archive(14);
    header.appendChild(archiveGroupBtn);

    const newBtn = document.createElement('button');
    newBtn.className = 'project-new-btn';
    newBtn.innerHTML = ICONS.plus(12);
    newBtn.title = 'Nueva sesión';
    header.appendChild(newBtn);

    if (project.userAdded) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'project-remove-btn';
      removeBtn.innerHTML = ICONS.x(12);
      removeBtn.title = 'Quitar directorio de la lista';
      header.appendChild(removeBtn);
    }

    const sessionsList = buildSessionsList(fId, visible, older);

    // Auto-collapse if most recent session is older than threshold, or project matched with no sessions
    if (project._projectMatchedOnly) {
      header.classList.add('collapsed');
    } else if (searchMatchIds === null && !showStarredOnly && !showRunningOnly) {
      const mostRecent = filtered[0]?.modified;
      if (mostRecent && (Date.now() - new Date(mostRecent)) > sessionMaxAgeDays * 86400000) {
        header.classList.add('collapsed');
      }
    }

    group.appendChild(header);
    group.appendChild(sessionsList);

    // Render nested worktree sub-groups
    const childWorktrees = worktreeMap.get(project.projectPath) || [];
    for (const wt of childWorktrees) {
      const wtResult = processProjectSessions(wt, resort);
      if (!wtResult) continue;
      newSortedOrder.push(wtResult.sortOrderEntry);

      const wtName = wt.projectPath.match(worktreePattern)?.[2] || wt.projectPath.split('/').pop();
      const wtFId = folderId(wt.projectPath);

      const wtGroup = document.createElement('div');
      wtGroup.className = 'worktree-group';
      wtGroup.id = wtFId;

      const wtHeader = document.createElement('div');
      wtHeader.className = 'worktree-header';
      wtHeader.id = 'ph-' + wtFId;
      wtHeader.innerHTML = `<span class="worktree-branch-icon">${ICONS.branch(14)}</span> <span class="worktree-name">${escapeHtml(wtName)}</span>`;

      const wtNewBtn = document.createElement('button');
      wtNewBtn.className = 'project-new-btn worktree-new-btn';
      wtNewBtn.innerHTML = ICONS.plus(10);
      wtNewBtn.title = 'Nueva sesión en worktree';
      wtHeader.appendChild(wtNewBtn);

      const wtSessionsList = buildSessionsList(wtFId, wtResult.visible, wtResult.older);
      wtSessionsList.className = 'worktree-sessions';

      // Auto-collapse worktree if stale
      if (searchMatchIds === null && !showStarredOnly && !showRunningOnly) {
        const mostRecent = wtResult.filtered[0]?.modified;
        if (mostRecent && (Date.now() - new Date(mostRecent)) > sessionMaxAgeDays * 86400000) {
          wtHeader.classList.add('collapsed');
        }
      }

      wtGroup.appendChild(wtHeader);
      wtGroup.appendChild(wtSessionsList);
      sessionsList.appendChild(wtGroup);
    }

    newSidebar.appendChild(group);
  }

  // Re-apply active state
  if (activeSessionId) {
    const activeItem = newSidebar.querySelector(`[data-session-id="${activeSessionId}"]`);
    if (activeItem) activeItem.classList.add('active');
  }

  morphdom(sidebarContent, newSidebar, {
    childrenOnly: true,
    onBeforeElUpdated: preserveSidebarDomState,
    getNodeKey(node) {
      return node.id || undefined;
    }
  });

  // Save the full sorted order (project order + item order) as source of truth
  sortedOrder = newSortedOrder;

  rebindSidebarEvents(projects);

  // Restore terminal focus after morphdom DOM updates, but not if the user is
  // interacting with an input/textarea (search box, rename input, dialogs, etc.)
  const ae = document.activeElement;
  const isUserTyping = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable || ae.closest('.modal-overlay'));
  if (activeSessionId && openSessions.has(activeSessionId) && !isUserTyping) {
    openSessions.get(activeSessionId).terminal.focus();
  }
}

function rebindSidebarEvents(projects) {
  for (const project of projects) {
    const fId = folderId(project.projectPath);
    const header = document.getElementById('ph-' + fId);
    if (!header) continue;
    const newBtn = header.querySelector('.project-new-btn');
    if (newBtn) {
      newBtn.onclick = (e) => { e.stopPropagation(); showNewSessionPopover(project, newBtn); };
    }
    const archiveGroupBtn = header.querySelector('.project-archive-btn');
    if (archiveGroupBtn) {
      archiveGroupBtn.onclick = async (e) => {
        e.stopPropagation();
        const sessions = project.sessions.filter(s => !s.archived);
        if (sessions.length === 0) return;
        const shortName = shortProjectPath(project.projectPath);
        if (!confirm(`¿Archivar ${sessions.length} ${sessions.length > 1 ? 'sesiones' : 'sesión'} de ${shortName}?`)) return;
        for (const s of sessions) {
          if (activePtyIds.has(s.sessionId)) {
            await window.api.stopSession(s.sessionId);
          }
          await window.api.archiveSession(s.sessionId, 1);
          forgetTerminalHistory(s.sessionId);
          s.archived = 1;
        }
        pollActiveSessions();
        loadProjects();
      };
    }
    const removeBtn = header.querySelector('.project-remove-btn');
    if (removeBtn) {
      removeBtn.onclick = async (e) => {
        e.stopPropagation();
        const shortName = shortProjectPath(project.projectPath);
        if (project.hasHistory || project.sessions.length > 0) {
          alert(`No se puede quitar ${shortName} porque tiene sesiones o terminales. Solo se quitan carpetas vacías.`);
          return;
        }
        if (!confirm(`¿Quitar ${shortName} de la lista? La carpeta no se borra.`)) return;
        const result = await window.api.removeProject(project.projectPath);
        if (!result.ok) alert(result.error);
      };
    }
    header.onclick = (e) => {
      if (e.target.closest('.project-new-btn, .project-archive-btn, .project-remove-btn')) return;
      header.classList.toggle('collapsed');
    };
  }

  // Bind worktree header events
  sidebarContent.querySelectorAll('.worktree-header').forEach(wtHeader => {
    const wtFId = wtHeader.id.replace('ph-', '');
    const wtProject = projects.find(p => folderId(p.projectPath) === wtFId);
    if (!wtProject) return;

    const wtNewBtn = wtHeader.querySelector('.worktree-new-btn');
    if (wtNewBtn) {
      wtNewBtn.onclick = (e) => { e.stopPropagation(); showNewSessionPopover(wtProject, wtNewBtn); };
    }
    wtHeader.onclick = (e) => {
      if (e.target.closest('.worktree-new-btn')) return;
      wtHeader.classList.toggle('collapsed');
    };
  });

  bindSessionListEvents(sidebarContent);
}

// Per-row handlers for every session list: slug groups, "+N older" toggles and
// the session items themselves.
function bindSessionListEvents(container) {
  container.querySelectorAll('.slug-group-header').forEach(header => {
    const archiveBtn = header.querySelector('.slug-group-archive-btn');
    if (archiveBtn) {
      archiveBtn.onclick = async (e) => {
        e.stopPropagation();
        const group = header.parentElement;
        const sessionItems = group.querySelectorAll('.session-item');
        for (const item of sessionItems) {
          const sid = item.dataset.sessionId;
          const session = sessionMap.get(sid);
          if (!session || session.archived) continue;
          if (activePtyIds.has(sid)) await window.api.stopSession(sid);
          await window.api.archiveSession(sid, 1);
          forgetTerminalHistory(sid);
          session.archived = 1;
        }
        pollActiveSessions();
        loadProjects();
      };
    }
    header.onclick = (e) => {
      if (e.target.closest('.slug-group-archive-btn')) return;
      header.parentElement.classList.toggle('collapsed');
      saveExpandedSlugs();
    };
  });

  container.querySelectorAll('.slug-group-more').forEach(moreBtn => {
    moreBtn.onclick = () => {
      const group = moreBtn.closest('.slug-group');
      if (group) {
        group.classList.remove('collapsed');
        saveExpandedSlugs();
      }
    };
  });

  container.querySelectorAll('.sessions-more-toggle').forEach(moreBtn => {
    const olderList = moreBtn.nextElementSibling;
    if (!olderList || !olderList.classList.contains('sessions-older')) return;
    const count = olderList.querySelectorAll('.session-item:not(.archived-item)').length;
    const moreLabel = moreBtn.querySelector('.sessions-more-label');
    moreBtn.onclick = (e) => {
      if (e.target.closest('.sessions-older-archive-btn')) return;
      const showing = olderList.style.display !== 'none';
      olderList.style.display = showing ? 'none' : '';
      moreBtn.classList.toggle('expanded', !showing);
      if (moreLabel) moreLabel.textContent = showing ? `+ ${count} older` : '- hide older';
    };

    const archiveOlderBtn = moreBtn.querySelector('.sessions-older-archive-btn');
    if (archiveOlderBtn) {
      archiveOlderBtn.onclick = async (e) => {
        e.stopPropagation();
        const sessions = [...olderList.querySelectorAll('.session-item')]
          .map(item => sessionMap.get(item.dataset.sessionId))
          .filter(session => session && !session.archived);
        if (sessions.length === 0) return;
        if (!confirm(`¿Archivar ${sessions.length} ${sessions.length > 1 ? 'sesiones antiguas' : 'sesión antigua'}?`)) return;
        for (const session of sessions) {
          if (activePtyIds.has(session.sessionId)) {
            await window.api.stopSession(session.sessionId);
          }
          await window.api.archiveSession(session.sessionId, 1);
          forgetTerminalHistory(session.sessionId);
          session.archived = 1;
        }
        pollActiveSessions();
        loadProjects();
      };
    }
  });

  container.querySelectorAll('.session-item').forEach(item => {
    const sessionId = item.dataset.sessionId;
    const session = sessionMap.get(sessionId);
    if (!session) return;

    item.onclick = () => openSession(session);

    const pin = item.querySelector('.session-pin');
    if (pin) {
      pin.onclick = async (e) => {
        e.stopPropagation();
        const { starred } = await window.api.toggleStar(session.sessionId);
        session.starred = starred;
        refreshSidebar({ resort: true });
      };
    }

    const summaryEl = item.querySelector('.session-summary');
    if (summaryEl) {
      summaryEl.ondblclick = (e) => { e.stopPropagation(); startRename(summaryEl, session); };
    }

    const stopBtn = item.querySelector('.session-stop-btn');
    if (stopBtn) {
      stopBtn.onclick = (e) => {
        e.stopPropagation();
        // Nothing to stop on a session that never started: the same control
        // clears the row instead, which is otherwise unremovable.
        if (isDismissibleSession(session.sessionId)) dismissSession(session.sessionId);
        else confirmAndStopSession(session.sessionId);
      };
    }

    const unreadBtn = item.querySelector('.session-unread-btn');
    if (unreadBtn) {
      unreadBtn.onclick = (e) => {
        e.stopPropagation();
        if (responseReadySessions.has(session.sessionId)) {
          clearUnread(session.sessionId);
        } else {
          markUnread(session.sessionId);
        }
        refreshSidebar();
      };
    }

    const forkBtn = item.querySelector('.session-fork-btn');
    if (forkBtn) {
      forkBtn.onclick = async (e) => {
        e.stopPropagation();
        // Find the project for this session
        const project = [...cachedAllProjects, ...cachedProjects].find(p =>
          p.sessions.some(s => s.sessionId === session.sessionId)
        );
        if (project) {
          forkSession(session, project);
        }
      };
    }

    const moreBtn = item.querySelector('.session-more-btn');
    if (moreBtn) {
      moreBtn.onclick = (e) => {
        e.stopPropagation();
        const menuItems = [
          { label: 'Renombrar sesión', onClick: () => startRename(item.querySelector('.session-summary'), session) },
          { label: 'Copiar ID de sesión', onClick: () => window.api.writeClipboard(session.sessionId) },
        ];
        if (session.type !== 'terminal') {
          menuItems.push(
            { label: 'Ver mensajes', onClick: () => showJsonlViewer(session) },
          );
          if (!isSessionRunning(session.sessionId)) {
            menuItems.unshift({ label: 'Reanudar con configuración…', onClick: () => showResumeSessionDialog(session) });
          }
        }
        if (isDismissibleSession(session.sessionId)) {
          menuItems.push({ label: 'Descartar sesión', onClick: () => dismissSession(session.sessionId) });
        }
        showContextMenu(menuItems, { anchor: moreBtn });
      };
    }

    const archiveBtn = item.querySelector('.session-archive-btn');
    if (archiveBtn) {
      archiveBtn.onclick = async (e) => {
        e.stopPropagation();
        const newVal = session.archived ? 0 : 1;
        if (newVal && activePtyIds.has(session.sessionId)) {
          await window.api.stopSession(session.sessionId);
          pollActiveSessions();
        }
        await window.api.archiveSession(session.sessionId, newVal);
        if (newVal) forgetTerminalHistory(session.sessionId);
        session.archived = newVal;
        loadProjects();
      };
    }
  });

  // Auto-expand slug group if it contains the active session
  if (activeSessionId) {
    const activeItem = container.querySelector(`[data-session-id="${activeSessionId}"]`);
    const collapsedGroup = activeItem?.closest('.slug-group.collapsed');
    if (collapsedGroup) {
      collapsedGroup.classList.remove('collapsed');
      saveExpandedSlugs();
    }
  }
}

function buildSessionItem(session) {
  const item = document.createElement('div');
  item.className = 'session-item';
  item.id = 'si-' + session.sessionId;
  if (session.type === 'terminal') item.classList.add('is-terminal');
  if (session.runtime && session.runtime !== 'claude') item.classList.add('is-' + session.runtime);
  if (session.archived) item.classList.add('archived-item');
  if (activePtyIds.has(session.sessionId)) item.classList.add('has-running-pty');
  if (attentionSessions.has(session.sessionId)) item.classList.add('needs-attention');
  if (responseReadySessions.has(session.sessionId)) item.classList.add('response-ready');
  if (sessionBusyState.get(session.sessionId)) item.classList.add('cli-busy');
  item.dataset.sessionId = session.sessionId;

  const modified = new Date(session.modified);
  const timeStr = formatDate(modified);
  const displayName = cleanDisplayName(session.name || session.aiTitle || session.summary);

  const row = document.createElement('div');
  row.className = 'session-row';

  // Title and star share the top line; status and actions sit below.
  const pin = document.createElement('button');
  pin.className = 'session-pin' + (session.starred ? ' pinned' : '');
  pin.type = 'button';
  pin.title = session.starred ? 'Quitar de fijadas' : 'Fijar sesión';
  pin.setAttribute('aria-label', pin.title);
  pin.setAttribute('aria-pressed', String(!!session.starred));
  pin.innerHTML = ICONS.star(14, '', session.starred);

  // Keep the status dot separate so running, busy and unread updates still apply.
  const mark = document.createElement('span');
  mark.className = 'session-mark';

  const markIcon = document.createElement('span');
  markIcon.className = 'session-mark-icon';
  if (session.type === 'terminal') {
    markIcon.innerHTML = ICONS.terminal(14);
    mark.title = 'Sesión de terminal';
  } else if (session.runtime === 'codex') {
    markIcon.innerHTML = ICONS.codex(14);
    mark.title = 'Sesión de Codex';
  } else {
    markIcon.innerHTML = ICONS.claude(14);
    mark.title = 'Sesión de Claude';
  }

  const dot = document.createElement('span');
  dot.className = 'session-status-dot' + (activePtyIds.has(session.sessionId) ? ' running' : '');
  mark.append(markIcon, dot);

  const header = document.createElement('div');
  header.className = 'session-header';
  const summaryEl = document.createElement('div');
  summaryEl.className = 'session-summary';
  summaryEl.textContent = displayName;
  header.append(summaryEl, pin);

  const footer = document.createElement('div');
  footer.className = 'session-footer';
  const metaEl = document.createElement('div');
  metaEl.className = 'session-meta';
  // The 30-second ticker updates this span, including the message count.
  const timeEl = document.createElement('span');
  timeEl.className = 'session-time';
  timeEl.title = session.sessionId;
  timeEl.textContent = timeStr + (session.messageCount ? ' \u00b7 ' + session.messageCount + ' mensajes' : '');
  metaEl.append(mark, timeEl);

  // Action buttons container
  const actions = document.createElement('div');
  actions.className = 'session-actions';

  const stopBtn = document.createElement('button');
  const dismissible = typeof isDismissibleSession === 'function' && isDismissibleSession(session.sessionId);
  stopBtn.className = 'session-stop-btn' + (dismissible ? ' session-dismiss-btn' : '');
  stopBtn.title = dismissible ? 'Descartar sesión' : 'Detener sesión';
  stopBtn.innerHTML = dismissible ? ICONS.x(12) : ICONS.stop(12);

  const archiveBtn = document.createElement('button');
  archiveBtn.className = 'session-archive-btn';
  archiveBtn.title = session.archived ? 'Desarchivar' : 'Archivar';
  archiveBtn.innerHTML = ICONS.archive(14);

  const forkBtn = document.createElement('button');
  forkBtn.className = 'session-fork-btn';
  forkBtn.title = 'Bifurcar sesión';
  forkBtn.innerHTML = ICONS.fork(14);

  const isUnread = responseReadySessions.has(session.sessionId);
  const unreadBtn = document.createElement('button');
  unreadBtn.className = 'session-unread-btn';
  unreadBtn.title = isUnread ? 'Marcar como leída' : 'Marcar como no leída';
  unreadBtn.innerHTML = isUnread ? ICONS.markRead(14) : ICONS.markUnread(14);

  const moreBtn = document.createElement('button');
  moreBtn.className = 'session-more-btn';
  moreBtn.title = 'Más acciones de sesión';
  moreBtn.setAttribute('aria-haspopup', 'menu');
  moreBtn.innerHTML = ICONS.more(14);

  if (session.type !== 'terminal') {
    actions.append(archiveBtn, forkBtn);
  }
  actions.append(unreadBtn, stopBtn, moreBtn);
  for (const button of actions.children) {
    button.type = 'button';
    button.setAttribute('aria-label', button.title);
  }

  footer.append(metaEl, actions);
  row.append(header, footer);
  item.appendChild(row);

  return item;
}

function startRename(summaryEl, session) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'session-rename-input';
  input.value = session.name || session.aiTitle || session.summary;

  summaryEl.replaceWith(input);
  input.focus();
  input.select();

  const save = async () => {
    const newName = input.value.trim();
    const fallback = session.aiTitle || session.summary;
    const nameToSave = (newName && newName !== fallback) ? newName : null;
    await window.api.renameSession(session.sessionId, nameToSave);
    session.name = nameToSave;
    if (session.type === 'terminal') persistTerminalSession(session);

    const newSummary = document.createElement('div');
    newSummary.className = 'session-summary';
    newSummary.textContent = nameToSave || fallback;
    newSummary.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startRename(newSummary, session);
    });
    input.replaceWith(newSummary);
  };

  input.addEventListener('blur', save);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') {
      input.removeEventListener('blur', save);
      const restored = document.createElement('div');
      restored.className = 'session-summary';
      restored.textContent = session.name || session.aiTitle || session.summary;
      restored.addEventListener('dblclick', (ev) => {
        ev.stopPropagation();
        startRename(restored, session);
      });
      input.replaceWith(restored);
    }
  });
}
