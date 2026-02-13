OpenJar Studios

Tauri desktop app for managing Minecraft instances with Modrinth install/update flows, lockfile tracking, and dual launch modes (Prism + native).

## Current feature status
- Step 1: Instance create/list/delete with persisted folders.
- Step 2: Modrinth discover/search/details UI.
- Step 3: Install Modrinth mods into instance `mods/` with progress.
- Step 4: Per-instance `lock.json` + Installed Mods list + enable/disable (`.disabled` rename).
- Step 5: Required dependency auto-install + install preview (`Will install: X mods`).
- Step 6: Check updates + Update all for Modrinth mods.
- Step 7: Snapshots + rollback (pre-install/update snapshot and restore).
- Step 8: Multi-provider discover (Modrinth + CurseForge) and CurseForge install.
- Add from file: import local `.jar` mod into selected instance.
- Modpacks/Presets: create from instance, apply to another instance, import/export shareable `mpm-presets/v1` JSON.
- Launch modes:
  - Prism mode (existing sync + launch behavior).
  - Native mode (Microsoft login + game launch without Prism).
- Export: zip an instance mod set (`.jar` + `.disabled`) for use in other launchers.

## Run
1. `npm install`
2. `npm run tauri:dev`

Production build:
- Frontend: `npm run build`
- Backend check: `cd src-tauri && cargo check`

## Modrinth access and restricted networks
By default, this app uses Modrinth public API endpoints (no API key required for the current feature set).

If Modrinth is blocked on your network, point both frontend and backend to your own proxy:
- `VITE_MODRINTH_API_BASE=https://your-proxy.example.com/v2`
- `MPM_MODRINTH_API_BASE=https://your-proxy.example.com/v2`

CurseForge access:
- Set `MPM_CURSEFORGE_API_KEY=<your-key>` (or `CURSEFORGE_API_KEY`) for CurseForge search/install.

## Launching instances

### Prism launch mode
The app can sync instance `mods/` and `config/` into a Prism instance then launch it.

Matching strategy:
1. Prism instance folder ID equals app instance ID, or
2. Prism `instance.cfg` `name=` equals app instance name.

Optional overrides:
- `MPM_PRISM_ROOT` for Prism data root
- `MPM_PRISM_BIN` for Prism executable

### Native launch mode
Native launch does not require Prism. It supports:
- Vanilla
- Fabric (auto loader resolution)
- Forge (auto recommended/latest resolution)

Requirements:
- A working Java install (`java` on `PATH`) or explicit Java path in Settings.
- A Microsoft account that owns Minecraft.
- OAuth public client ID resolution order:
  1. Settings override (`oauth_client_id`)
  2. App default env (`MPM_MS_CLIENT_ID_DEFAULT`)
  3. Bundled default public client ID
  4. Legacy env fallback (`MPM_MS_CLIENT_ID`)

Native launcher notes:
- Uses shared cache under app data (`launcher/cache`) for assets/libraries/versions.
- Supports launching multiple different instances in parallel.
- Prevents duplicate native launch of the same instance while already running.
- Uses Microsoft device-code sign in (`microsoft.com/link`) to avoid redirect URI issues.

## Settings added (Launcher)
- Default launch method: `native` or `prism`
- Java executable path
- Advanced OAuth client ID override (optional)
- Microsoft account connect/select/disconnect
- Account page shortcut with diagnostics

## Mods zip export
Instance page includes `Export mods zip`.

Contents:
- `mods/*.jar`
- `mods/*.disabled`

Default output filename:
- `<instance-name>-mods-YYYY-MM-DD.zip`

Instance page shortcuts:
- `Open instance folder`
- `Open mods folder`
- Snapshot picker + rollback to selected snapshot

## Storage
Under app data directory:
- `instances/<id>/mods`
- `instances/<id>/config`
- `instances/<id>/lock.json`
- `launcher/settings.json`
- `launcher/accounts.json`
- `launcher/cache/`

## Notes about upstream launcher code
This project references launcher behavior patterns but does not copy Prism source. Native launching uses `open_launcher` (vendored in `src-tauri/vendor/open_launcher`) plus project-specific auth/process/export logic.
