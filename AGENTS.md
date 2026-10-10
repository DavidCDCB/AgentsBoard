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
- **Harnesses (`harnesses/`)**: un módulo por CLI. `claude.js` y `codex.js` describen el layout de sus transcripciones y `available()`. `index.js` es el registro (`HARNESSES`, `availableHarnesses()`, `harnessForFolder()`). El contrato con el CLI de Claude Code está concentrado en `claude.js`; otros módulos lo usan puntualmente (sección 11.2).

### Datos

- Base de datos SQLite con better-sqlite3 en modo WAL: `%USERPROFILE%\.switchboard\switchboard.db`. Si existe `SWITCHBOARD_DATA_DIR`, se usa esa carpeta (`db.js` líneas 8-10).
- `main.js` líneas 15-16: si `SWITCHBOARD_DATA_DIR` está definida, `userData` pasa a `<SWITCHBOARD_DATA_DIR>\electron`. Así una instancia de desarrollo tiene su propio bloqueo de instancia única.
- Las sesiones no se guardan en la BD como fuente de verdad. Se indexan desde las transcripciones de cada CLI (Claude: carpeta de proyectos de Claude, codificada con `encode-project-path.js` y sin soporte para `CLAUDE_CONFIG_DIR` (sección 11.6); Codex: `~/.codex/sessions/YYYY/MM/DD`, o `CODEX_HOME` si está definida). La BD guarda índice, metadatos del usuario, ajustes y búsqueda.

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
| `terminal-manager.js` | Terminales embebidas. `createTerminalEntry` (~393), sincronización `cli-busy` y `cli-session` (397-398), `persistedTerminalRecord` (291) y repintado al hacer clic (500). |
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
- Las sesiones de Claude y Codex añaden `.terminal-container.cli-session` (`session.type !== 'terminal'`). Esa clase oculta la barra del viewport de xterm (`style.css` ~1333-1342) con `scrollbar-width: none`. La rueda sigue desplazando el historial porque `overflow-y` sigue en `scroll`. En la vista de cuadrícula, `#terminals.grid-layout` oculta su propia barra (`scrollbar-width: none`) solo si todas las tarjetas son `cli-session` (`:not(:has(.terminal-container:not(.cli-session)))`, `style.css` ~1515-1520). Si hay una terminal simple, la barra vuelve. Las terminales simples conservan la barra. Queda un hueco de 15px a la derecha porque `@xterm/addon-fit` siempre reserva ese ancho.
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
- Las pruebas del contrato con Claude Code (`harness-claude.test.js`, `read-session-file.test.js`, `session-launch.test.js`, `session-config.test.js`, `terminal-activity.test.js`) usan fixtures sintéticos. Ver sección 11.

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
- Hallazgos sobre el CLI de Claude Code (variables de entorno, transcripciones `.orphaned-*`, colisiones de carpeta, título desactivado, retención, fork con worktree): ver sección 11.6.

## 10. Convenciones

- La UI está en español. Los comentarios del código están en inglés.
- Comentar solo lo que necesita aclaración.
- No guardar secretos en el código. `.gitignore` excluye `.env`, `*.pem`, `*.db`, `*.db-wal`, `*.db-shm`, `dist/` y `node_modules/`.
- Cambios en la UI: edita `public/` y revisa la carga de scripts en `index.html`. Los globales se comparten entre archivos, así que el orden importa.
- Cambios en IPC: agrega el canal en `main.js`, expónlo en `preload.js` y documenta el cambio en la sección 5.
- Cambios en el esquema: sigue las migraciones de `db.js` y cubre la migración con pruebas en `test/db-schema-reconcile.test.js`.
- Cambios que dependan del CLI de Claude Code: confirma primero en la documentación oficial y en el binario instalado (sección 11). No cambies un formato sin una transcripción real que lo respalde.

## 11. Dependencia del CLI de Claude Code

AgentsBoard lee lo que escribe el CLI de Claude Code (transcripciones, título de terminal, notificaciones, credenciales) y lo lanza con argumentos. Nada de eso es un contrato estable: la documentación oficial advierte que el formato de las entradas de transcripción es interno y puede cambiar en cualquier versión. Esta sección sirve para diagnosticar fallos después de actualizar el CLI.

Fuentes (consultadas el 2026-10-10):

- Comandos y flags: https://code.claude.com/docs/en/cli-reference
- Sesiones y transcripciones: https://code.claude.com/docs/en/sessions
- Directorio de configuración: https://code.claude.com/docs/en/claude-directory
- Variables de entorno: https://code.claude.com/docs/en/env-vars
- Índice de toda la documentación: https://code.claude.com/docs/llms.txt
- Changelog: https://raw.githubusercontent.com/anthropics/claude-code/refs/heads/main/CHANGELOG.md (unos 986 KB, del más reciente al más antiguo; búscalo por versión y por palabra clave).

### 11.1 Versión de referencia

- Versión verificada: **CLI 2.1.296** (`claude --version`, 2026-10-10).
- Los comentarios de `encode-project-path.js` y `public/utils.js` citan 2.1.126, la versión con la que se hizo la ingeniería inversa. `claude-auth.js` envía `claude-code/2.1.74`. Son valores históricos.
- Si `claude --version` no devuelve 2.1.296, sigue la sección 11.4 antes de tocar código.

### 11.2 Superficie que usa AgentsBoard

| Área | Qué usa del CLI | Dónde | Estado en 2.1.296 |
|---|---|---|---|
| Lanzamiento | `--session-id <uuid>` (sesión nueva), `--resume <id>`, `--resume <id> --fork-session`, `--add-dir`, `--allowedTools`, `--permission-mode`, `--dangerously-skip-permissions`, `--model`, `--effort`, `--worktree [nombre]`, `--chrome`, `--append-system-prompt` y el prompt posicional | `buildLaunchArgs` (`harnesses/claude.js`) | Todos figuran en `claude --help`. La app envía `acceptEdits`, `auto`, `plan`, `dontAsk` y `bypassPermissions` (o ningún valor). `ultracode` figura en la documentación, no en la ayuda local, y la app no lo expone. |
| Carpeta de transcripciones | `$CONFIG/projects/<carpeta>/<sesión>.jsonl`, donde `$CONFIG` es `~/.claude` | `sessionsRoot()` (`harnesses/claude.js`), `main.js` línea 56 | Ignora `CLAUDE_CONFIG_DIR` y `CLAUDE_CODE_PROJECT_DIR_NAME` (11.6, 1 y 2). |
| Nombre de carpeta | Caracteres no alfanuméricos → `-`; si pasa de 200, se trunca y se añade `-` y un hash en base 36 | `encode-project-path.js` y copia en `public/utils.js` | Coincide con el binario: misma función de hash. |
| Transcripción | Líneas JSON con `type` (`user`, `assistant`, `ai-title`, `custom-title`, `file-history-snapshot`, `last-prompt`), `message.content`, `timestamp`, `cwd`, `slug`, `forkedFrom.sessionId`, `planContent` | `applyLine`, `readSessionFile`, `readLaunchSignals` | Tipos y campos presentes en el binario. La estructura exacta solo se conoce por fixtures sintéticos. |
| Subagentes | `<sesión>/subagents/agent-*.jsonl` | `deriveProjectPath` | Presente en el binario. Solo se indexan transcripciones de primer nivel. |
| Transcripciones apartadas | `<sesión>.orphaned-<ts>-<sufijo>.jsonl` y `<sesión>.jsonl.superseded-<ts>` | `listTranscripts` | La documentación dice que no aparecen en el selector. Ver 11.6, 3. |
| Título de terminal | OSC 0 con glifo de spinner: U+25D0 a U+25D3 = ocupado; U+2733 (✳) = libre | `parseTitleState` | Los cuatro marcos están en el binario. Que ✳ sea el estado inactivo no se confirmó sin sesión real. |
| Progreso | OSC 9;4: `4;1` a `4;3` = ocupado, `4;0` = libre | `progressBusyState` (`harnesses/index.js`) | Activo por defecto (`terminalProgressBarEnabled`). |
| Notificaciones | OSC 9 con "needs your attention", "needs your approval", "needs your permission" o "wants to enter plan mode" = atención; "waiting for your input" = libre | `classifyNotification` | Textos presentes. El CLI también envía `notificationType` (p. ej. `idle_prompt`), que AgentsBoard no usa. |
| Fork y plan | `--fork-session` crea un id nuevo; su transcripción registra `forkedFrom`; aceptar un plan registra `planContent` y `slug` | `matchesLaunch`, `readLaunchSignals`, `detectSessionTransitions` (`session-transitions.js`) | Campos presentes. Hay dos mecanismos: el de lanzamiento y el de vigilancia de la carpeta. |
| Cuota | `GET https://api.anthropic.com/api/oauth/usage` con `Authorization: Bearer`, `anthropic-beta: oauth-2025-04-20` y `User-Agent: claude-code/2.1.74` | `fetchUsage`, `transformUsageResponse`, `mapLimits` (`claude-auth.js`) | Endpoint y beta presentes. El User-Agent está fijo y es antiguo. El esquema `limits` no está documentado. |
| Credenciales | `$CONFIG/.credentials.json` (`claudeAiOauth.accessToken`). En macOS, el llavero va antes que el archivo | `getOAuthToken` (`claude-auth.js`) | Archivo documentado. El servicio de llavero `Claude Code-credentials` no está en el binario (11.5). |
| Worktrees | `<repo>/.claude/worktrees/<nombre>` | Agrupación en `public/sidebar.js` | Ruta documentada y presente en el binario. |

`$CONFIG` es `~/.claude` por defecto, o el valor de `CLAUDE_CONFIG_DIR` si está definida.

### 11.3 Historial de cambios del CLI con impacto

Resumen del changelog, filtrado por palabras clave. No es exhaustivo.

| Versión | Cambio | Impacto en AgentsBoard |
|---|---|---|
| 2.1.7 | El título usa braille de ancho fijo | El glifo de ocupado fue braille hasta 2.1.227 |
| 2.1.79 | `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` impide que se escriba el título | Sin título no hay señal de ocupado |
| 2.1.128 | El progreso OSC 9;4 se mantiene durante todo el turno; hubo un `4;0` espurio al salir | `progressBusyState` no debe liberar si el título sigue ocupado (ya lo hace) |
| 2.1.136 | `--resume` no encontraba sesiones con `_` en la ruta | Codificación: `_` pasa a `-` |
| 2.1.181 | Otro proceso del CLI ejecutaba el barrido de 30 días y borraba historia de sesiones inactivas | Sesiones que desaparecen |
| 2.1.200 | El modo `default` se llama "Manual"; `--permission-mode manual` es válido | La app envía `null` (sin flag): sin cambio |
| 2.1.203 | Nuevo nivel de esfuerzo `ultracode` | No expuesto (11.6, 11) |
| 2.1.212 | Las transcripciones registran el esfuerzo en cada mensaje del asistente | Campo nuevo: el parser lo ignora |
| 2.1.221 | `/fork` crea un worktree propio | El fork puede caer en otra carpeta (11.6, 7) |
| 2.1.224 | Rutas de más de 200 caracteres compartían carpeta con otro proyecto | Corregido; la codificación con hash coincide con el binario |
| 2.1.228 | Los glifos del spinner del título pasan a medias lunas | `parseTitleState` (U+25D0 a U+25D3) |
| 2.1.234 | Aparece `CLAUDE_CODE_PROJECT_DIR_NAME` | Carpeta distinta (11.6, 2) |
| 2.1.239 | `--resume` tomaba sesiones de rutas que solo difieren en `_`, `-` o `.` | Colisión de carpetas (11.6, 4) |
| 2.1.247 | En runners autoalojados, "waiting for your input" llegaba antes de tiempo | `classifyNotification` puede marcar libre antes de tiempo |
| 2.1.248 | La retención de 30 días también alcanza a sesiones de Desktop | Las sesiones antiguas desaparecen |
| 2.1.269 | `CLAUDE_CONFIG_DIR` puede definirse en un archivo de ajustes | La app solo lee el entorno del proceso (11.6, 1) |
| 2.1.285 | `--resume` abre una sesión en background en vez de rechazarla, si no pasas flags de configuración | Con flags de configuración sigue saliendo con código 1 (11.6, 8) |
| 2.1.288 | Un resume podía cargar una transcripción cortada si se reescribía durante la carga | `readSessionFile` revisa tamaño y mtime |
| 2.1.295 | Protocolo OSC 7501 para mostrar si Claude trabaja, espera o terminó | Candidato a señal oficial (11.6, 14) |
| 2.1.296 | `CLAUDE_CODE_TRANSCRIPT_LOCAL_GC` ya no reescribe un archivo si libera menos del 10 % | Solo afecta si la variable está definida |

### 11.4 Procedimiento ante un cambio del CLI

1. **Versión.** Ejecuta `claude --version`. Si no es 2.1.296, busca en el changelog las entradas posteriores a 2.1.296 que mencionen transcripciones, título, notificaciones, flags o credenciales. La tabla 11.3 indica qué área toca cada versión.
2. **Flags.** Ejecuta `claude --help` y busca cada flag de la fila "Lanzamiento" de 11.2. Un flag renombrado o eliminado rompe el arranque de todas las sesiones.
3. **Literales del binario.** Sin ejecutar el CLI, cuenta los literales de 11.5. En PowerShell (Windows):
   ```powershell
   $bin = Join-Path (npm root -g) "@anthropic-ai\claude-code\bin\claude.exe"
   node -e "const t=require('fs').readFileSync(process.argv[1]).toString('utf8');for(const s of process.argv.slice(2))console.log(String(t.split(s).length-1).padStart(4), s)" $bin "terminalProgressBarEnabled" "CLAUDE_CONFIG_DIR" "PROGRAM_STATUS:7501"
   ```
   Si un literal que debería estar desaparece, el área correspondiente de 11.2 está en riesgo. En otros sistemas, localiza el binario del paquete `@anthropic-ai/claude-code` dentro de la carpeta que devuelve `npm root -g`.
4. **Pruebas.** Ejecuta `npm test`. Si fallan `harness-claude.test.js`, `read-session-file.test.js`, `session-launch.test.js`, `session-config.test.js` o `terminal-activity.test.js`, el contrato pudo cambiar. Antes de ajustar el código, confirma el formato real con una transcripción nueva: los fixtures son sintéticos.
5. **Sesión real (manual).** Abre una sesión desde AgentsBoard en una carpeta de prueba y verifica: aparece en la barra lateral; el anillo se activa al trabajar y se apaga al terminar; llega la notificación si la ventana no tiene foco; `/rename` se refleja; `/branch` crea una fila nueva; reanudar funciona; la barra de cuota muestra valores. No uses `claude -p` en pruebas automáticas: consume cuota.
6. **Diagnóstico del CLI.** `claude doctor` es de solo lectura. `claude --safe-mode` desactiva CLAUDE.md, hooks, plugins y servidores MCP, útil para saber si la configuración del usuario causa el fallo. `claude auth status --text` muestra el método de autenticación; con `--json` incluye `configDirectory` desde 2.1.268.
7. **Cambios.** Mantén el cambio dentro de `harnesses/claude.js`. `main.js` solo calcula la carpeta con `encodeProjectPath` y arma el lanzamiento con `buildLaunchArgs`.

### 11.5 Literales de referencia (CLI 2.1.296)

Cada fila se midió con el comando del paso 3 de 11.4.

| Literal | Ocurrencias | Protege |
|---|---|---|
| `terminalProgressBarEnabled` | 15 (valor por defecto `true`) | Progreso OSC 9;4 |
| Marcos U+25D0, U+25D1, U+25D2, U+25D3 en un arreglo | Presentes | `parseTitleState` |
| `CLAUDE_CONFIG_DIR` | 83 | Rutas de transcripciones y de `.claude.json` |
| `CLAUDE_CODE_PROJECT_DIR_NAME` | 5 | Nombre de la carpeta del proyecto |
| `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` | 13 | Desactiva el título y con él la señal de ocupado |
| `CLAUDE_CODE_TRANSCRIPT_LOCAL_GC` | 7 | Reescritura de transcripciones grandes |
| `replace(/[^a-zA-Z0-9]/g,` | 7 | `encodeProjectPath` |
| `PROGRAM_STATUS:7501` | 1 | Protocolo OSC 7501 (no implementado en AgentsBoard) |
| `Claude Code-credentials` | 0 | Llavero de macOS (no verificado) |
| `Claude Code-device-keys` | 2 | Llave de dispositivo (AgentsBoard no la usa) |
| `ultracode` | 169 | Esfuerzo no expuesto |
| `api/oauth/usage` | 14 | Cuota |
| `oauth-2025-04-20` | 3 | Cabecera beta de la cuota |
| `forkedFrom` | 6 | Fork |
| `planContent` | 29 | Plan aceptado |
| `ExitPlanMode` | 29 | Herramienta de plan |
| `is running in the background` | 11 | Error al reanudar una sesión en background |

Los tipos de transcripción `"type":"ai-title"` y `"type":"custom-title"` están presentes, aunque no se contaron con este comando.

### 11.6 Hallazgos abiertos

Ordenados por impacto. Entre corchetes, la fuente: [documentación], [binario], [changelog] o [código]. "No reproducido" significa que el riesgo sale del análisis y no de una sesión observada.

1. **`CLAUDE_CONFIG_DIR` se ignora en las transcripciones (alta).** `sessionsRoot()` fija `~/.claude/projects` [código]. Con la variable definida, el CLI escribe en `$CLAUDE_CONFIG_DIR/projects` [documentación]. La variable también puede venir del bloque `env` de un archivo de ajustes [changelog 2.1.269], y AgentsBoard solo lee el entorno del proceso. `claude-auth.js` sí la respeta, así que el código es inconsistente. Síntoma: no aparecen sesiones.
2. **`CLAUDE_CODE_PROJECT_DIR_NAME` no se contempla (alta para quien la use).** Solo tiene efecto si también está `CLAUDE_CONFIG_DIR` [documentación]. `main.js` líneas 629-630 calculan la carpeta con `encodeProjectPath`, así que el listado y la detección de forks no encuentran nada.
3. **Las transcripciones apartadas se indexan como sesiones (alta, no reproducido).** `listTranscripts` y los filtros de `workers/scan-projects.js` (línea 19), `folder-index-state.js` (línea 18), `main.js` (línea 634) y `session-transitions.js` (línea 83) aceptan cualquier nombre que termine en `.jsonl`. Un `<uuid>.orphaned-<ts>-<sufijo>.jsonl` aparecería como sesión aparte, cuando la documentación dice que no aparece en el selector.
4. **Carpetas compartidas por rutas parecidas (media, no reproducido).** El nombre de carpeta reemplaza `_`, `-` y `.` por `-`, así que dos proyectos pueden compartir carpeta [binario y documentación]. El CLI lo corrigió en `--resume` [changelog 2.1.239]. AgentsBoard asigna un solo proyecto por carpeta, tomado del primer `cwd` (`deriveProjectPath`) [código].
5. **`CLAUDE_CODE_DISABLE_TERMINAL_TITLE` apaga la señal de ocupado (media).** Con esa variable el CLI no escribe el título [changelog 2.1.72 y 2.1.79]. El anillo no responde y AgentsBoard no avisa. Revisa la variable antes de depurar el anillo.
6. **Retención de 30 días (media).** El CLI borra transcripciones con más de `cleanupPeriodDays` (30 por defecto) [documentación], y cualquier proceso del CLI puede ejecutar el barrido [changelog 2.1.181]. La caché debe descartar filas cuyo archivo ya no existe; no verificado.
7. **Fork con worktree desde 2.1.221 (media, no verificado).** Según el changelog, `/fork` crea un worktree propio. El transcript quedaría en otra carpeta, y `detectSessionTransitions` solo vigila la carpeta del proyecto [código].
8. **Reanudar una sesión que sigue en background (media).** Si la sesión sigue activa en background y la línea de comandos trae flags de configuración (`--permission-mode`, `--model`, `--settings`…), el CLI no la abre: sale con código 1 e indica `claude attach <id>` [documentación]. Se evita con `--fork-session` o con `claude stop <id>`. `buildLaunchArgs` aplica permisos, modelo y esfuerzo también al reanudar, cuando la configuración efectiva del usuario los define [código].
9. **User-Agent fijo (baja).** `claude-auth.js` envía `claude-code/2.1.74`. El CLI envía `claude-code/<versión>` [binario]. Si el endpoint empieza a rechazar versiones antiguas, la cuota deja de cargar. No verificado.
10. **Dos copias de `encodeProjectPath` (baja).** `encode-project-path.js` y `public/utils.js` deben cambiar juntas [código].
11. **`ultracode` no expuesto (baja, decisión pendiente).** `EFFORT_LEVELS` (`harnesses/claude.js`) y `CLAUDE_EFFORTS` (`public/session-config.js`) no lo incluyen. El CLI lo acepta desde 2.1.203 [changelog].
12. **Llavero de macOS sin verificar (baja en Windows).** `readFromKeychain` busca `Claude Code-credentials`. Ese literal no está en el binario 2.1.296, que sí contiene `Claude Code-device-keys` [binario]. Verifícalo en macOS antes de confiar en esa lectura.
13. **Título y progreso sin confirmar en sesión real (media).** No se confirmó que U+2733 sea el estado inactivo del título, ni cuándo emite el CLI cada `4;0`. El changelog 2.1.261 documenta un indicador de progreso que mostraba la sesión como terminada mientras corría un workflow en background.
14. **Oportunidad: protocolo OSC 7501 (informativo).** Desde 2.1.295 el CLI soporta un protocolo de estado (trabajando, esperando o terminado) para terminales que lo implementen [changelog]. El binario incluye la sonda OSC 7501 y el mensaje "probe: no reply to OSC 7501" [binario]. Si xterm.js respondiera a la sonda, AgentsBoard podría usar una señal oficial en lugar del glifo del título. No probado: el formato de la respuesta no se verificó.
15. **Pruebas con fixtures sintéticos (baja).** Las pruebas del contrato no usan transcripciones reales. Conviene guardar, anonimizadas, transcripciones de cada versión que cambie el formato.

### 11.7 Síntomas y dónde mirar

| Síntoma | Causa probable | Dónde mirar |
|---|---|---|
| No aparecen sesiones | `CLAUDE_CONFIG_DIR` o `CLAUDE_CODE_PROJECT_DIR_NAME` (11.6, 1 y 2); `CLAUDE_CODE_SKIP_PROMPT_HISTORY`, que no escribe transcripciones; retención de 30 días | `sessionsRoot`, `encodeProjectPath`, ajustes del usuario |
| Aparece una sesión extra con `.orphaned-` en el nombre | Transcripción apartada (11.6, 3) | `listTranscripts` |
| Sesión sin título o sin mensajes | Formato de línea distinto, o transcripción vacía | `applyLine` y `readSessionFile` (devuelve `null` sin resumen ni mensajes) |
| El anillo no aparece o nunca se apaga | Título desactivado con `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` (11.6, 5), o glifos distintos | `parseTitleState`, `setActivity` (`app.js`); `terminal-activity.js` como respaldo |
| No hay notificación al terminar | Textos de notificación distintos, o la ventana tenía foco | `classifyNotification`; `main.js` ~953-977 |
| Un fork no se enlaza y queda como sesión aparte | Fork en otra carpeta (11.6, 7), o campo `forkedFrom` distinto | `readLaunchSignals`, `matchesLaunch`, `detectSessionTransitions` |
| El lanzamiento falla con un error de flag | Flag renombrado o valor no válido | `buildLaunchArgs`; `claude --help` |
| Reanudar muestra "is running in the background" | Sesión activa en background (11.6, 8) | `claude agents`; `claude stop <id>` |
| Barra de cuota vacía o "Could not fetch usage" | Token vencido, endpoint o beta cambiados, o esquema `limits` distinto | `claude-auth.js`; mensajes en el log de la consola |
| `--worktree` no crea el worktree | Flag o ruta de worktree distintos | `buildLaunchArgs`; regex de agrupación en `public/sidebar.js` |

### 11.8 Qué no hacer

- No deduzcas formatos a partir de una sola transcripción ni de la intuición. Confírmalos en la documentación o en el binario, y guarda la evidencia en un fixture.
- No leas ni imprimas `.credentials.json` ni el contenido del llavero. Para saber el método de autenticación, usa `claude auth status --text`.
- No ejecutes `claude -p` en pruebas automáticas (consume cuota). No cierres procesos de Electron o de Claude sin confirmar cuáles son tuyos.
- No cambies la ruta de transcripciones sin cubrir `CLAUDE_CONFIG_DIR` con una prueba.
