# AGENTS.md — AgentsBoard

Guía de referencia para agentes y desarrolladores que trabajan en este repositorio: qué hace el proyecto, cómo está organizado, cómo se prueba y cómo se generan el portable y el instalador de Windows.

## 1. Qué es

AgentsBoard es una app de escritorio (Electron) para explorar, buscar y gestionar sesiones de CLIs de programación con IA (Claude Code y Codex). Muestra una barra lateral con las sesiones agrupadas por directorio, terminales embebidas (node-pty + xterm.js), búsqueda en conversaciones, notificaciones y ajustes globales.

Es una simplificación de Switchboard (MIT, © 2025 Doctly). Nombres actuales:

- `package.json`: `name` = `agentsboard`, `productName` = `AgentsBoard`, `appId` = `ai.doctly.agentsboard`, `version` = `0.0.36`.
- Identificadores internos que se conservan a propósito para no perder datos del usuario: variable `SWITCHBOARD_DATA_DIR`, archivo `switchboard.db`, carpeta `~\.switchboard`.

### Eliminado (no buscarlo)

- En la simplificación: menú superior, integración con Slack y auto-updater.
- Commit de limpieza `83dc537`: plantillas (`templates/`), `docs/customizing-colors.md`, `scripts/apply-theme.ps1`, `public/pptx-preview.css`, `public/icon.png` y las capturas de `build/` (`project-view-*`, `screenshot*.png`).
- IPC `get-app-version` y `delete-setting`. En `preload.js`, `getAppVersion` y `deleteSetting`. En `db.js`, `deleteSetting`.
- En `app.js`: `openNewSession` y `sessionFilters`.
- Dependencias `dotenv`, `ws` y `marked`.

## 2. Comandos

| Acción | Comando |
|---|---|
| Instalar dependencias | `npm install` |
| Ejecutar la app | `npm start` (equivale a `electron .`) |
| Pruebas | `npm test` (`node --test`) |
| Portable e instalador (Windows) | Ver sección 7 |

Notas:

- `npm install` ejecuta `scripts/postinstall.js`, que intenta `npx electron-builder install-app-deps` (reconstruye node-pty y better-sqlite3 para Electron). En Windows la reconstrucción de node-pty falla, pero el script captura el error y termina con código 0. Las advertencias aparecen en la salida. Si necesitas el build de Electron, usa `--config.npmRebuild=false` como se explica en la sección 7.
- `engines` pide Node `>=22.12`. El entorno de desarrollo original usó Node 22.11.0 (aparece `EBADENGINE`). CI (`.github/workflows/build.yml`) usa Node 20.
- `npm audit` reporta 25 vulnerabilidades sin resolver (1 crítica, 20 altas, 4 moderadas).

## 3. Arquitectura

Tres capas de Electron más un worker y los harnesses:

- **Proceso principal (`main.js`)**: ventanas, IPC, PTY (node-pty), notificaciones, bloqueo de instancia única (`requestSingleInstanceLock`), lectura de transcripciones y uso de cuota.
- **Preload (`preload.js`)**: expone `window.api` con `contextBridge`. El objeto queda congelado, así que las pruebas no pueden parcharlo.
- **Renderer (`public/`)**: scripts clásicos cargados con `<script>` en `public/index.html`, que comparten globales. `public/app.js` orquesta el resto de módulos.
- **Worker (`workers/scan-projects.js`)**: worker thread que escanea carpetas de transcripciones y construye la lista de proyectos para `session-cache.js`.
- **Harnesses (`harnesses/`)**: un módulo por CLI. `claude.js` y `codex.js` describen el layout de sus transcripciones y `available()`. `index.js` es el registro (`HARNESSES`, `availableHarnesses()`, `harnessForFolder()`).

### Datos

- Base de datos SQLite con better-sqlite3 en modo WAL: `%USERPROFILE%\.switchboard\switchboard.db`. Si existe `SWITCHBOARD_DATA_DIR`, se usa esa carpeta (`db.js` líneas 8-10).
- `main.js` líneas 15-16: si `SWITCHBOARD_DATA_DIR` está definida, `userData` pasa a `<SWITCHBOARD_DATA_DIR>\electron`. Así una instancia de desarrollo tiene su propio bloqueo de instancia única.
- Las sesiones no se guardan en la BD como fuente de verdad. Se indexan desde las transcripciones de cada CLI (Claude: carpeta de proyectos de Claude, codificada con `encode-project-path.js`; Codex: `~/.codex/sessions/YYYY/MM/DD`, o `CODEX_HOME` si está definida). La BD guarda índice, metadatos del usuario, ajustes y búsqueda.

## 4. Mapa de archivos

### Raíz (proceso principal)

| Archivo | Responsabilidad |
|---|---|
| `main.js` | Proceso principal, IPC, PTY, notificaciones (~líneas 953-977), instancia única (~1281). |
| `preload.js` | Puente `window.api`. |
| `db.js` | Esquema SQLite, tablas, migraciones y ajustes. |
| `session-cache.js` | Indexado de sesiones, `buildProjectsFromCache` (~268), agregar y quitar directorios (421, 430). |
| `folder-index-state.js` | Estado de indexado por carpeta. |
| `jsonl-scan.js` | Escaneo de transcripciones JSONL. |
| `session-preview.js` | Vista previa de sesiones. |
| `session-transitions.js` | Detección de forks y de aceptación de plan en sesiones PTY activas. |
| `session-launch.js` | Reglas de arranque (`shouldStartFresh`, `shouldBlockArchivedSession`). |
| `terminal-activity.js` | Detección de actividad de terminal: marcas OSC 133 o sondeo del proceso en primer plano. |
| `terminal-file-links.js` | Enlaces a archivos dentro de la terminal. |
| `pty-env.js` | Entorno limpio para procesos hijos (`buildPtyEnv`), con locale UTF-8 cuando falta. |
| `shell-profiles.js` | Perfiles de shell disponibles (PowerShell, Git Bash, etc.). |
| `resolve-effective-settings.js` | Combina ajustes globales y por sesión. |
| `encode-project-path.js` | Codificación de rutas de proyecto al estilo de Claude. |
| `claude-auth.js`, `codex-auth.js` | Consulta de uso y cuota de cada CLI. |

### `public/` (renderer)

| Archivo | Responsabilidad |
|---|---|
| `index.html` | Marcado, orden de scripts y barra de estado (`#status-bar-right`, enlace `#status-bar-repo`). |
| `style.css` | Estilos, incluido el anillo de sesión ocupada (`.terminal-container.cli-busy::after`). |
| `app.js` | Orquestación. `setActivity` (187-220), `renderDefaultStatus` (1152), enlace de GitHub `status-bar-repo` (1175), `confirmAndStopSession` (623). |
| `sidebar.js` | Barra lateral: proyectos, sesiones, botones de agregar y quitar directorio, y detener sesión. |
| `terminal-manager.js` | Terminales embebidas. `createTerminalEntry` (~393), sincronización `cli-busy` (397), `persistedTerminalRecord` (291) y repintado al hacer clic (500). |
| `grid-view.js` | Vista en cuadrícula de sesiones. |
| `settings-panel.js`, `dialogs.js`, `context-menu.js` | Ajustes, diálogos y menús contextuales. |
| `session-config.js`, `session-config-form.js` | Configuración de nueva sesión. |
| `jsonl-viewer.js`, `message-search.js` | Visor de transcripciones y búsqueda en mensajes. |
| `terminal-links.js`, `terminal-themes.js` | Enlaces y temas de la terminal. |
| `icons.js`, `utils.js` | Utilidades e iconos. |

### Otras carpetas

- `harnesses/`: `index.js`, `claude.js`, `codex.js`.
- `workers/`: `scan-projects.js`.
- `test/`: 22 archivos `*.test.js` ejecutados con `node --test`.
- `scripts/`: `postinstall.js`, `generate-icons.js`, `generate-dmg-background.js`, `build-installer.ps1` (instalador en un paso, sección 7).
- `build/`: `icon.ico` (icono de la app y del exe), `icon.png`, `icon.icns` (mac), `dmg-background.png`, `dmg-background@2x.png`, `entitlements.mac.plist`.
- `.github/workflows/build.yml`: CI en tags `v*` y en PRs a `main`.
- `.claude/commands/release.md`: flujo de release (bump, tag, CI, release en borrador y confirmación).
- `.claude/commands/schedule-hn-top-articles.md`: comando programado (cron, `enabled: false`) que revisa los artículos top de Hacker News con WebFetch.

## 5. Canales IPC

Canales de `ipcMain.handle`/`ipcMain.on` en `main.js`:

- Sistema: `open-external`, `open-path`, `clipboard-write-text`, `browse-folder`.
- Proyectos: `get-projects`, `add-project`, `remove-project`.
- Uso y cuota: `get-usage`, `get-codex-usage`.
- Búsqueda: `search`, `search-session-ids`.
- Ajustes: `get-setting`, `set-setting`, `get-effective-settings`.
- Harnesses y perfiles: `get-harnesses`, `get-codex-models`, `get-shell-profiles`.
- Sesiones: `get-active-sessions`, `stop-session`, `toggle-star`, `rename-session`, `archive-session`, `read-session-jsonl`, `get-session-last-message`.
- Terminales: `get-active-terminals`, `open-terminal`, `terminal-input`, `terminal-resize`, `close-terminal`, `set-active-terminal`, `resolve-terminal-files`.

Eventos hacia el renderer (`preload.js`, métodos `on*`): `onTerminalData`, `onSessionDetected`, `onHarnessesChanged`, `onProcessExited`, `onTerminalNotification` (tipo `'idle'`), `onCliBusyState`, `onSessionForked`, `onProjectsChanged`, `onStatusUpdate`.

## 6. Lógica clave

### Sesión ocupada y notificaciones

- Una sesión está ocupada cuando la CLI muestra su spinner en el título OSC 0 (`onCliBusyState`). Los eventos `onTerminalNotification` de tipo `'idle'` la marcan como libre. Ambos llaman a `setActivity` en `app.js` (187-220). `terminal-activity.js` es un respaldo basado en marcas OSC 133 o en el proceso en primer plano.
- El anillo animado de la terminal (`.terminal-container.cli-busy::after`, `style.css` 1276-1310) gira el tono con `--terminal-ring-hue`, en un ciclo de 8 s entre 190 y 300.
- Al pasar de ocupada a libre, la sesión se reordena automáticamente en la barra lateral.
- Notificación del sistema (`main.js` ~953-977): se muestra en la transición ocupada→libre. Se suprime solo si la ventana tiene foco **y** la sesión que terminó es la activa.

### Renombrar sesiones

- `rename-session` (`main.js` ~480) guarda el nombre en `session_meta`.
- Al reabrir, `persistedTerminalRecord` (`terminal-manager.js` 291) recupera ese nombre. Antes se perdía y aparecía "Terminal".
- Un nombre puesto en la app tiene prioridad sobre el título automático de Codex, que llega por `session_index.jsonl` (`session-cache.js` ~66-68).

### Agregar y quitar directorios

- Los directorios agregados se guardan en el ajuste `addedProjects`. `addProjectDirectory` está en `session-cache.js` ~421 y `removeProjectDirectory` en ~430.
- La UI (`sidebar.js`: botón en 367, manejador en 489-501) solo permite quitar un directorio sin historial y sin sesiones (`hasHistory || sessions.length > 0`).
- **El backend no valida esta regla.** `ipcMain.handle('remove-project')` en `main.js` solo exige una ruta absoluta, y `removeProjectDirectory` (`session-cache.js` 430) no revisa sesiones. Es una brecha conocida.

### Terminal sin barra superior

- La barra superior de la terminal se eliminó en `139b2ce`. Detener una sesión queda en la barra lateral (`sidebar.js`, ~633) y en la cuadrícula (`grid-view.js`). Ambas llaman a `confirmAndStopSession` (`app.js` 623).

### Letras congeladas en la terminal

- Síntoma: en Claude Code algunas letras quedan sin pintar hasta que se seleccionan. **La causa no está confirmada.** Un repro aislado con xterm.js 6.0.0 y `@xterm/addon-webgl` 0.19.0 no lo reprodujo.
- Workaround: al hacer mousedown en el contenedor se llama `terminal.refresh(0, terminal.rows - 1)` (`terminal-manager.js` 500). No está verificado contra una sesión real de Claude Code.
- El addon WebGL se carga en `createTerminalEntry` (`terminal-manager.js` ~491). Si se pierde el contexto WebGL, el addon se desecha y xterm usa el renderer DOM: más CPU, casi el mismo aspecto.

### Margen superior de la terminal

- `.terminal-container` (`style.css` 1254) usa `inset: 0px 0px 0 0`. Un `inset` superior negativo recorta la primera línea. El commit `9a7f56d` dejó ese valor en 0 y revirtió el margen de 8px de `af7f584`.

### Icono del exe portable

- La causa del icono ausente en el exe (y en la barra de tareas) es que `signAndEditExecutable=false` omite rcedit. Activarlo falla sin Modo de desarrollador de Windows, porque winCodeSign necesita symlinks.
- La ventana usa `build/icon.ico` en Windows (`main.js` ~93). Usar `icon.png` ahí fue otra causa del problema.
- Icono de Electron en la barra de tareas: Windows asocia el AUMID (`main.js` ~1300) con un acceso directo del menú Inicio. Encontramos un `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Electron.lnk` con el AUMID `ai.doctly.agentsboard` que apuntaba a `node_modules\electron\dist\electron.exe`, y por eso el portable mostraba el icono de Electron. Si vuelve a pasar, borra ese `.lnk`. Las ejecuciones dev usan el AUMID `ai.doctly.agentsboard.dev`, y con él no se recreó el acceso directo.

## 7. Build de portable e instalador (Windows)

Pasos verificados. Los artefactos quedan en `dist\`, que está en `.gitignore`.

Atajo para el instalador: `powershell -ExecutionPolicy Bypass -File scripts\build-installer.ps1`. Ejecuta los pasos 1, 2 y 4 y muestra la ruta del instalador. El portable (paso 3) sigue siendo manual.

1. **Empaquetar sin reconstruir node-pty ni firmar:**
   ```powershell
   npx electron-builder --dir --win --config.npmRebuild=false --config.win.signAndEditExecutable=false
   ```
   Crea `dist\win-unpacked\`. Si falla con `ERR_ELECTRON_BUILDER_CANNOT_EXECUTE` o "app.asar being used by another process", cierra las instancias de AgentsBoard que usen esa carpeta, espera unos segundos y reintenta.

2. **Aplicar el icono al exe desempaquetado con rcedit:**
   ```powershell
   $rcedit = (Get-ChildItem "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign" -Recurse -Filter rcedit-x64.exe | Select-Object -First 1).FullName
   & $rcedit "dist\win-unpacked\AgentsBoard.exe" --set-icon build\icon.ico
   ```
   rcedit debe ejecutarse antes de los pasos 3 y 4. La carpeta de caché de winCodeSign tiene un hash que cambia por máquina.

3. **Portable:**
   ```powershell
   $pre = (Resolve-Path dist\win-unpacked).Path
   npx electron-builder --win portable --prepackaged "$pre" --config.win.signAndEditExecutable=false
   ```
   Genera `dist\AgentsBoard 0.0.36.exe`.

4. **Instalador NSIS:**
   ```powershell
   npx electron-builder --win nsis --prepackaged "$pre" --config.win.signAndEditExecutable=false
   ```
   Genera `dist\AgentsBoard Setup 0.0.36.exe` y su blockmap.

**Verificación del icono:** compara el icono del exe con `build\icon.ico` a 32×32 con System.Drawing. Debe coincidir en los 1024 píxeles. No compares tamaños distintos. Las pruebas previas con tamaños desiguales dieron resultados inválidos.

**Datos del portable:** también usa `%USERPROFILE%\.switchboard\switchboard.db`. Desinstalar o borrar el exe no borra los datos.

## 8. Pruebas y pruebas manuales

- `npm test` ejecuta 234 pruebas. **Línea base actual: 227 pasan y 4 fallan.** Los fallos son preexistentes y no tienen relación con los cambios recientes:
  - "incremental columns upgrade a version-4 database without losing metadata or search"
  - "...version-12 database..." (migración desde versión 12)
  - "transcriptPath prefers a stored sessionFile over reconstructing one"
  - "CODEX_HOME relocates the sessions root"
- Para probar la app sin tocar la instalación real, usa una carpeta de datos aislada:
  ```powershell
  $env:SWITCHBOARD_DATA_DIR = "$env:TEMP\ab-sandbox"
  npm start
  ```
  Así la BD y `userData` quedan separados y la instancia no comparte bloqueo con la instalada.
- Antes de cerrar una sesión de prueba, confirma qué procesos de Electron son de la sesión y cuáles son del usuario. No los cierres a ciegas.
- Las notificaciones y el anillo ocupado se verificaron con sesiones simuladas, no con una sesión real de Claude.

## 9. Problemas conocidos y pendientes

- node-pty no se reconstruye con `npm install` en Windows. Empaqueta con `--config.npmRebuild=false` (sección 7).
- Incompatibilidad de versión de Node: `engines` pide >=22.12 y el entorno original usó 22.11.0.
- 25 vulnerabilidades de `npm audit` sin resolver (1 crítica, 20 altas, 4 moderadas).
- `package.json` (`build.publish`) apunta a `doctly/switchboard`, y `author` es "Doctly". El workflow de CI publica un release en borrador con `gh release create` en tags `v*`. Revisar antes de publicar desde este repositorio.
- Comentario desactualizado en `session-cache.js:8` ("Only Claude sessions are indexed today"). Codex ya se indexa cuando `available()` lo permite (`harnesses/index.js`, `harnesses/codex.js:107`).
- La regla de quitar directorios no se valida en el backend (sección 6).
- Las notificaciones y el anillo ocupado no se han verificado con una sesión real de Claude.
- Letras congeladas en la terminal de Claude Code: causa no confirmada. Ver sección 6.
- Margen superior de la terminal: pendiente confirmar si se quiere el margen de 8px de `af7f584`, revertido por `9a7f56d`.

## 10. Convenciones

- La UI está en español. Los comentarios del código están en inglés.
- Comentar solo lo que necesita aclaración.
- No guardar secretos en el código. `.gitignore` excluye `.env`, `*.pem`, `*.db`, `*.db-wal`, `*.db-shm`, `dist/` y `node_modules/`.
- Cambios en la UI: edita `public/` y revisa la carga de scripts en `index.html`. Los globales se comparten entre archivos, así que el orden importa.
- Cambios en IPC: agrega el canal en `main.js`, expónlo en `preload.js` y documenta el cambio en la sección 5.
- Cambios en el esquema: sigue las migraciones de `db.js` y cubre la migración con pruebas en `test/db-schema-reconcile.test.js`.
