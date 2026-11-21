# `oma-reopen` Tern Host Plugin

A lightweight Tern Host plugin that restores Oh My Agy (`oma`) sessions automatically when Tern rebuilds saved panes after a daemon restart or pane fork.

## How It Works

1. When `oma` starts or switches to a session (with `[ui].reopen_anchor = true` in `config.toml`), it writes a local session anchor file:
   - **Windows**: `%LOCALAPPDATA%\oma\sessions\<sessionId>.json`
   - **Linux / macOS**: `~/.local/share/oma/sessions/<sessionId>.json` (or `$XDG_DATA_HOME/oma/sessions/<sessionId>.json`)
2. `oma` notifies Tern via `OSC 1337 SetUserVar`:
   - `omp_restore=1` (base64 `MQ==`)
   - `omp_session_file=<base64(anchor JSON absolute path)>`
3. When Tern rebuilds a saved pane, it fires a `reopen` event (`ReopenEvent { pane, cwd, shell, agent, session, how, command, line }`). `host.luau` checks that `ev.agent == "omp"` and identifies `oma` via either the pane's command line (`oma` / `oma.exe`) or the session anchor path (`.../oma/sessions/...`), returning `"oma"`.
4. Tern then launches `oma --resume <session>`, `oma --restore <session>`, or `oma --fork <session>` depending on `ev.how`, and `oma` parses the anchor JSON to reload the conversation.
5. On a normal user-initiated exit (`/quit`, `/exit`, `Ctrl+D`, double `Ctrl+C`), `oma` clears both user variables so ended sessions are not automatically reopened.

## Installation

Use the official `tern plugin` CLI (recommended) from the repository root:

```bash
# Install a copy into Tern's plugins directory
tern plugin install ./plugins/oma-reopen

# Or link directly for local development
tern plugin link ./plugins/oma-reopen
```

On Windows PowerShell:

```powershell
tern plugin install .\plugins\oma-reopen
# or
tern plugin link .\plugins\oma-reopen
```

To inspect your active Tern plugins directory, run `tern plugin dir`. If installing manually, copy `plugins/oma-reopen/` into that directory and restart or reload Tern Host:

- **Windows**: `%APPDATA%\Tern\plugins\oma-reopen\`
- **Linux / macOS**: `~/.config/tern/plugins/oma-reopen/` (or `$XDG_CONFIG_HOME/tern/plugins/oma-reopen/`)

Make sure `oma` (or `oma.exe`) is available on your `PATH` so Tern can spawn it during pane restoration.

## Disabling

To opt out of automatic session restoration without uninstalling the plugin, set the following in your `oma` `config.toml`:

```toml
[ui]
reopen_anchor = false
```
