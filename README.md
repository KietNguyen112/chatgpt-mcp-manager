# MCP Manager GPT — OpenAI Secure MCP Tunnel

Windows desktop manager for turning a local project into a **ChatGPT Web coding MCP** through the official OpenAI Secure MCP Tunnel.

## Architecture

```text
ChatGPT Web / Developer Mode
        │
        │ Connection: Tunnel
        ▼
OpenAI Secure MCP Tunnel
        │ outbound-only control plane
        ▼
tunnel-client.exe
        │
        │ http://127.0.0.1:<port>/mcp
        ▼
MCP Gateway (only for Read-Only filtering)
        │
        ▼
Supergateway + MCP filesystem bridge
        │
        ├── filesystem tools
        ├── grep / tree / diagnostics
        ├── persistent terminals
        ├── background processes
        ├── apply_patch
        └── Git / worktrees / checkpoints
```

OpenAI's `tunnel-client` is the customer-run client for Secure MCP Tunnel. It keeps the MCP server private and forwards MCP work through an OpenAI-hosted tunnel control plane. ChatGPT connects using **Connection: Tunnel** and a `tunnel_id`; there is no public MCP URL and no inbound firewall rule. The supported long-lived flow is `tunnel-client runtimes connect`, followed by `runtimes status <alias>` to verify `process_running`, `healthy`, and `ready`. citehttps://github.com/openai/tunnel-client/blob/master/docs/end-user-guide.md

## Why this build is different from the old Cloudflare version

- Cloudflare/ngrok are no longer part of the active tunnel path.
- The app uses the official `tunnel-client runtimes connect` lifecycle.
- Runtime credentials are passed as `env:M1_OPENAI_RUNTIME_KEY`; the literal API key is never placed in the command line.
- The runtime is supervised by native `tunnel-client` state rather than `nohup`/ad-hoc detached processes.
- ChatGPT sees the MCP server as a native Tunnel connection instead of a public URL.
- The local MCP endpoint remains bound to `127.0.0.1`.
- Persistent terminals/processes remain in the M1 runtime daemon, so a bridge recreation does not destroy shell state.

OpenAI's current guidance recommends `tunnel-client runtimes connect` for long-lived managed runtimes and `runtimes status <alias>` to verify `process_running`, `healthy`, and `ready`. Runtime keys should be passed as secret references such as `env:CONTROL_PLANE_API_KEY`, never as literal values in persistent configuration. citehttps://github.com/openai/tunnel-client/blob/master/docs/end-user-guide.md citehttps://github.com/openai/tunnel-client/blob/master/docs/permissions.md

## Requirements

- Windows 10/11
- Python 3.10+
- Node.js + npm/npx
- Git (recommended)
- Official OpenAI `tunnel-client.exe`
- A provisioned OpenAI `tunnel_id`
- A Runtime API key with Tunnels Read + Use permission

OpenAI provides the supported tunnel-client download through Platform Tunnels management and publishes releases for Windows amd64/arm64. citehttps://github.com/openai/tunnel-client/releases

### Put tunnel-client in the project

Place the official binary here:

```text
mcp-manager-gpt/
└── bin/
    └── tunnel-client.exe
```

The app also accepts `tunnel-client.exe` from `PATH`.

## ChatGPT setup

1. Open ChatGPT Web → **Settings → Apps / Connectors**.
2. Enable Developer Mode if your workspace exposes it.
3. Create/use the MCP connector and select **Connection: Tunnel**.
4. Select or paste your OpenAI `tunnel_id`.
5. Keep the local runtime healthy while ChatGPT uses the connector.

OpenAI documents that ChatGPT connects to remote MCP servers and that a private/local MCP server should use Secure MCP Tunnel. Full MCP write/modify support is currently rolling out for Business and Enterprise/Edu; Pro support is more limited. citehttps://help.openai.com/en/articles/12584461

## First run

Start the manager:

```powershell
python -m pip install -r requirements.txt
python main.py
```

In the UI:

1. Add one or more project folders.
2. Choose **Full Access** for coding, or **Read-Only** for inspection.
3. Enter the OpenAI `tunnel_id`.
4. Enter the Runtime API key. It is encrypted with Windows DPAPI in the local runtime config.
5. Keep alias `mcp-manager-gpt` unless you need multiple runtimes.
6. Start the tunnel.
7. Wait for **ONLINE**.
8. In ChatGPT, select the same Tunnel connector.

The displayed `tunnel://...` value is an identifier for the OpenAI tunnel, **not a public HTTP endpoint**. The actual MCP endpoint remains loopback-only.

## Codex-grade tool surface

The MCP bridge exposes a coding-oriented tool set:

### Workspace / discovery

- `get_workspace`
- `set_workspace`
- `grep_search`
- `get_directory_tree`
- `read_file_range`
- `get_file_info`
- `search_files`
- `list_directory`
- `list_directory_with_sizes`
- `directory_tree`

### Files

- `read_file`
- `read_text_file`
- `read_media_file`
- `read_multiple_files`
- `write_file`
- `edit_file`
- `create_directory`
- `move_file`
- `delete_file`
- `delete_directory`
- `apply_patch`

### Terminal / processes

- `create_terminal`
- `exec_terminal`
- `read_terminal`
- `send_terminal_input`
- `close_terminal`
- `list_terminals`
- `start_process`
- `read_process_output`
- `write_process_input`
- `wait_process`
- `stop_process`
- `list_processes`
- `run_command`

Terminal and background process state is kept in `mcp_runtime_daemon.mjs`, independent from MCP bridge recreation.

### Verification

- `run_tests`
- `get_diagnostics`

### Git

- `git_status`
- `git_diff`
- `git_log`
- `git_add`
- `git_commit`
- `git_branch`
- `git_checkout`
- `git_stash`
- `git_worktree_list`
- `git_worktree_create`
- `git_worktree_remove`
- `create_checkpoint`
- `rollback_checkpoint`

## Important security model

Full Access shell tools execute with the permissions of the Windows account running this manager. This is **not an OS sandbox**. Use a dedicated low-privilege Windows account or Read-Only mode for untrusted projects.

The OpenAI tunnel itself does not make the local MCP server public. The local server remains on loopback and `tunnel-client` establishes the outbound connection to OpenAI. citehttps://github.com/openai/tunnel-client/blob/master/docs/architecture.md

## Tests

The suite covers the MCP bridge, 50 prefixed tools, atomic patching, persistent runtime state, path/symlink security, gateway SSE forwarding, Read-Only enforcement, and runtime ownership.

```powershell
python -m unittest discover -s tests -v
python -m py_compile main.py mcp_service.py mcp_proxy.py secure_store.py
node --check mcp_filesystem_bridge.mjs
node --check mcp_runtime_client.mjs
node --check mcp_runtime_daemon.mjs
node --check mcp_runtime_admin.mjs
node tests/test_bridge_tools.mjs
node tests/test_new_tools.mjs
node tests/test_prefix_forwarding.mjs
node tests/test_runtime_persistence.mjs
node tests/test_path_security.mjs
```

Read-Only is enforced at two boundaries: the public gateway filters and rejects mutating calls, and the bridge independently rejects mutating `tools/call` requests before forwarding them to the underlying filesystem MCP server. This prevents a client from bypassing Read-Only merely by naming a hidden write tool directly.

## Native tunnel-client diagnostics

If the manager cannot connect, first run the official binary directly:

```powershell
.\bin\tunnel-client.exe help quickstart
.\bin\tunnel-client.exe help doctor
.\bin\tunnel-client.exe runtimes list
.\bin\tunnel-client.exe runtimes status mcp-manager-gpt --json
```

OpenAI recommends checking `/readyz`/runtime readiness and using the native runtime status rather than treating a launched process as proof that the tunnel is usable. citehttps://github.com/openai/tunnel-client/blob/master/docs/end-user-guide.md

## Project layout

```text
mcp-manager-gpt/
├── main.py
├── mcp_service.py
├── mcp_proxy.py
├── mcp_filesystem_bridge.mjs
├── mcp_runtime_client.mjs
├── mcp_runtime_common.mjs
├── mcp_runtime_daemon.mjs
├── mcp_runtime_admin.mjs
├── secure_store.py
├── bin/
│   └── tunnel-client.exe   # official OpenAI binary
├── config.example.json
├── runtime/                 # generated local state; ignored by Git
├── tests/
└── run.bat
```
