# OpenJar Studios

**OpenJar Studios** is a **good-looking, Mac-first Minecraft launcher / “Creator Studio”** built with **Tauri (Rust)** + **React (Vite + TypeScript)**.  
It’s designed to feel clean and modern while still being powerful: manage instances, import modpacks, browse Modrinth/CurseForge, install & update mods with lockfiles, edit configs with a real UI, and launch safely — even running lots of copies at once via isolated runtime sessions.

---

## Highlights

- **Clean, modern UI** (macOS-friendly look & feel)
- **Instance management** + imports/exports
- **Multi-provider discovery**: Modrinth + CurseForge
- **Dependency-aware installs** + per-instance **lockfile** tracking
- **Per-mod enable/disable**
- **Updates** (Modrinth)
- **Config Editor** experience (file browser + editors + helpers)
- **Snapshots / rollback** tooling
- **Native launching** + Microsoft account login
- **Multi-launch support** using **isolated runtime sessions** (run many copies safely)

---

## Platform support & testing

OpenJar Studios is **built and tested primarily on macOS** and is optimized to run smoothly on Mac.

Because it’s built on **Tauri + Rust**, it **should also work on Windows** (and likely Linux), and the codebase includes cross-platform handling for common OS actions (macOS `open`, Windows `explorer`, Linux `xdg-open`).

- **macOS:** Actively tested / primary target
- **Windows:** Expected to work, but not as heavily tested yet
- **Linux:** Likely workable, but currently unverified

If you try **Windows/Linux** and run into any problems, please **open a GitHub Issue** and include:
- your OS + version (and whether it’s Intel/AMD or ARM)
- what you were doing + steps to reproduce + the issue
- any error messages
- relevant logs (and screenshots if helpful)

That helps me verify cross-platform behavior and fix compatibility issues faster.

---

## Features (Implemented)

### Instance Management
- Create, list, update, delete instances
- Open/reveal instance folders and common paths
- Instance icons (set an icon + load local images for display)

### Import / Export
- Create instance from a **modpack file** (“From File” flow)
- Import instances from **other launchers** (choose source + import)
- Import a local mod **.jar** into an instance (“Add from file”)
- Export installed mods as a **ZIP** (includes enabled `.jar` and `.disabled`)

### Discover + Install (Multi-provider)
- Discover/search supports:
  - **Modrinth**
  - **CurseForge**
- Install content directly from Discover into a chosen instance

**CurseForge**
- Fetch project details for detail views
- Install CurseForge projects into instances
- API status check (key/network/config troubleshooting)

**Modrinth**
- Install Modrinth projects into instances with progress events
- Install planning/preview (“will install X items”)
- Automatically installs **required dependencies** during install

### Installed Mods (Per instance)
- View installed mods list
- Enable/disable mods (rename toggle using `.disabled`)
- Per-instance lockfile tracking (`lock.json` stored inside the instance folder)
  - Stores provider metadata + what’s installed to keep things consistent

### Updates (Modrinth)
- Check for updates for installed Modrinth mods
- Update-all flow for Modrinth mods

### Snapshots + Rollback
- List snapshots for an instance
- Roll back an instance from a snapshot
- World rollback support (backup rollback path exists)

### Launching
- Two launch modes:
  - **Prism launch mode** (sync/launch via Prism workflow)
  - **Native launch mode** (no Prism required)
- Native launch loader support:
  - Vanilla
  - Fabric (auto loader resolution)
  - Forge (auto latest/recommended resolution)
- Shared cache under app data (assets/libraries/versions caching)

**Multi-launch handling**
- Tracks running instances
- Stop a running instance
- Cancel an in-progress launch
- Prevents unsafe duplicate native launch of the same instance
- Creates **isolated runtime sessions** when needed (lets you run many copies safely)

### Microsoft Account / Auth (Native Launch)
- Microsoft device-code login flow (begin + poll)
- List saved accounts
- Select active account
- Logout/disconnect
- Account diagnostics for debugging

### Logs
- Read instance logs (structured results)

### Config Editor (UI-first, powerful)
A full config editing experience inside the app:
- Instance picker dropdown
- World picker (list instance worlds)
- Config file browser (list config files)
- Reveal/open files in Finder
- Read and save config files
- Create new config files (New File modal)
- Specialized editors:
  - JSON editor (parsing + friendly errors)
  - Text editor
  - `servers.dat` editor (server list editing)
  - Advanced editor mode
- Inspector panel (context + suggestions)
- Helper/intelligence features (formatting + suggestions)

### Presets / Creator Tools
- Presets workflows:
  - Preview preset apply (see what will change)
  - Apply preset to an instance
  - Export presets to JSON
  - Import presets from JSON
- Provider modpack template import is wired

---

## How Multi-Launch Works (Isolated Runtime Sessions)

OpenJar Studios can launch multiple runs of the same instance safely by creating an **isolated runtime session directory** per launch.  
When the game closes, the runtime session is **deleted automatically**.

This avoids the classic problem of **two Minecraft clients writing to the same folder** (which can corrupt saves and configs).

---

## Tech Stack

- **Tauri v1** + **Rust** backend
- **React + TypeScript** frontend (**Vite**)
- Multi-provider content flows (**Modrinth + CurseForge**)
- Clean separation between UI, commands, and instance filesystem operations

---

## Dev Setup

### Requirements
- Node.js **18+** recommended
- Rust toolchain (**stable**)
- Tauri prerequisites for your OS

### Install
```bash
npm install
````

### Run (dev)
Frontend only (Vite):
```bash
npm run dev
```

Full desktop app (Tauri + Vite):
```bash
npm run tauri:dev
```

### Build
Frontend build:
```bash
npm run build
```

Tauri desktop build:
```bash
npm run tauri:build
```

### Preview (frontend build)
```bash
npm run preview
```
