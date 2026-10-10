# AgentsBoard

AgentsBoard es una app de escritorio (Electron) para explorar, buscar y gestionar sesiones de CLIs de programación con IA, como Claude Code y Codex. Muestra una barra lateral con las sesiones agrupadas por directorio, terminales embebidas, búsqueda en conversaciones, notificaciones y ajustes globales.

Repositorio: https://github.com/DavidCDCB/AgentsBoard

Es una simplificación de Switchboard (MIT, © 2025 Doctly).

## Requisitos

- Windows (el build de distribución es solo para Windows).
- Node.js 22.12 o superior (`engines` en `package.json`).
- npm.

## Ejecutar en desarrollo

```powershell
npm install
npm start
```

`npm install` intenta reconstruir `node-pty` y `better-sqlite3` para Electron. En Windows la reconstrucción de `node-pty` suele fallar, pero el script de postinstall captura el error y npm termina con código 0. Las advertencias aparecen en la salida. Si necesitas empaquetar, sigue la sección de build más abajo.

Pruebas:

```powershell
npm test
```

## Generar portable e instalador (Windows)

El build estándar falla al reconstruir `node-pty`, así que se usan estos pasos. Los artefactos quedan en `dist\`.

Atajo para el instalador: `powershell -ExecutionPolicy Bypass -File scripts\build-installer.ps1` ejecuta los pasos 1, 2 y 4 de abajo. El portable (paso 3) se genera manualmente.

1. Empaquetar sin reconstruir nativos ni firmar:

   ```powershell
   npx electron-builder --dir --win --config.npmRebuild=false --config.win.signAndEditExecutable=false
   ```

   Si aparece `ERR_ELECTRON_BUILDER_CANNOT_EXECUTE` o "app.asar being used by another process", cierra las instancias de AgentsBoard que usen `dist\win-unpacked`, espera unos segundos y reintenta.

2. Aplicar el icono al exe con rcedit:

   ```powershell
   $rcedit = (Get-ChildItem "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign" -Recurse -Filter rcedit-x64.exe | Select-Object -First 1).FullName
   & $rcedit "dist\win-unpacked\AgentsBoard.exe" --set-icon build\icon.ico
   ```

   Este paso debe ir antes de generar el portable y el instalador, porque ambos reutilizan `win-unpacked`.

3. Portable:

   ```powershell
   $pre = (Resolve-Path dist\win-unpacked).Path
   npx electron-builder --win portable --prepackaged "$pre" --config.win.signAndEditExecutable=false
   ```

   Genera `dist\AgentsBoard 0.0.36.exe`.

4. Instalador NSIS:

   ```powershell
   npx electron-builder --win nsis --prepackaged "$pre" --config.win.signAndEditExecutable=false
   ```

   Genera `dist\AgentsBoard Setup 0.0.36.exe`.

## Datos

AgentsBoard guarda su base de datos en `%USERPROFILE%\.switchboard\switchboard.db`. Se conserva el nombre de carpeta y de archivo de Switchboard para no perder datos existentes. La variable `SWITCHBOARD_DATA_DIR` permite cambiar esa ubicación. El portable usa la misma base de datos, así que borrar el exe no borra los datos.

## Estructura

- `main.js`: proceso principal de Electron (IPC, notificaciones, terminales).
- `preload.js`: expone `window.api` al renderer.
- `public/`: interfaz (HTML, CSS y scripts del renderer).
- `harnesses/`: integración con cada CLI (Claude, Codex).
- `session-cache.js`, `db.js`: índice de sesiones y base SQLite.
- `AGENTS.md`: documentación técnica completa para desarrollo y corrección de bugs.

## Licencia

MIT. Ver `LICENSE`.
