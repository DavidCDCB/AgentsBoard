// --- Context menus ---

let openCtxMenu = null;

function closeContextMenu() {
  if (!openCtxMenu) return;
  openCtxMenu.remove();
  openCtxMenu = null;
  document.removeEventListener('pointerdown', onCtxPointerDown, true);
  document.removeEventListener('keydown', onCtxKey, true);
}

function onCtxPointerDown(e) {
  if (!openCtxMenu) return;
  // Submenus hang off document.body, not the root menu, so they count as inside too.
  const inside = openCtxMenu.contains(e.target) || openCtxMenu._subs.some(s => s.contains(e.target));
  if (!inside) closeContextMenu();
}

function onCtxKey(e) {
  if (e.key === 'Escape') { e.stopPropagation(); closeContextMenu(); }
}

function placeMenu(menu, { x, y, anchor }) {
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  let left = x;
  let top = y;
  if (anchor) {
    const rect = anchor.getBoundingClientRect();
    left = rect.left;
    top = rect.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(8, rect.top - h - 4);
  }
  if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
  if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function buildMenu(items, depth = 0) {
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  for (const item of items) {
    if (!item) continue;
    if (item.sep) { const sep = document.createElement('div'); sep.className = 'ctx-sep'; menu.appendChild(sep); continue; }
    if (item.head) { const head = document.createElement('div'); head.className = 'ctx-head'; head.textContent = item.head; menu.appendChild(head); continue; }
    const row = document.createElement('div');
    row.className = 'ctx-item' + (item.danger ? ' danger' : '') + (item.disabled ? ' disabled' : '') + (item.muted ? ' muted' : '');
    row.innerHTML = `<span class="ctx-icon">${item.icon || ''}</span><span class="ctx-label">${escapeHtml(item.label)}</span>` +
      (item.hint ? `<span class="ctx-hint">${escapeHtml(item.hint)}</span>` : '') +
      (item.submenu ? '<span class="ctx-arrow">&#9656;</span>' : '');
    if (item.submenu) {
      let sub = null;
      const openSub = () => {
        if (sub) return;
        menu.querySelectorAll('.ctx-item.open').forEach(o => { if (o !== row) { o.classList.remove('open'); o._closeSub?.(); } });
        sub = buildMenu(item.submenu, depth + 1);
        sub.classList.add('ctx-submenu');
        document.body.appendChild(sub);
        const rect = row.getBoundingClientRect();
        let left = rect.right + 2;
        if (left + sub.offsetWidth > window.innerWidth - 8) left = rect.left - sub.offsetWidth - 2;
        let top = rect.top - 5;
        if (top + sub.offsetHeight > window.innerHeight - 8) top = Math.max(8, window.innerHeight - sub.offsetHeight - 8);
        sub.style.left = `${left}px`;
        sub.style.top = `${top}px`;
        row.classList.add('open');
        openCtxMenu._subs.push(sub);
      };
      row._closeSub = () => { if (sub) { sub.remove(); openCtxMenu._subs = openCtxMenu._subs.filter(s => s !== sub); sub = null; row.classList.remove('open'); } };
      row.onmouseenter = openSub;
      row.onclick = (e) => { e.stopPropagation(); openSub(); };
    } else if (!item.disabled) {
      row.onmouseenter = () => menu.querySelectorAll('.ctx-item.open').forEach(o => { o.classList.remove('open'); o._closeSub?.(); });
      row.onclick = (e) => { e.stopPropagation(); closeContextMenu(); item.onClick?.(); };
    }
    menu.appendChild(row);
  }
  return menu;
}

/** One menu style for every right-click and every "…" button. */
function showContextMenu(items, position) {
  closeContextMenu();
  const menu = buildMenu(items);
  menu._subs = [];
  const remove = menu.remove.bind(menu);
  menu.remove = () => { for (const s of menu._subs) s.remove(); remove(); };
  document.body.appendChild(menu);
  openCtxMenu = menu;
  placeMenu(menu, position || { x: 20, y: 20 });
  setTimeout(() => {
    document.addEventListener('pointerdown', onCtxPointerDown, true);
    document.addEventListener('keydown', onCtxKey, true);
  }, 0);
  return menu;
}
