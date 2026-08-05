# Windows MCPProxy startup

This workstation runs the local MCPProxy gateway separately from Paseo:

- MCPProxy: `127.0.0.1:8933`
- Packaged Paseo daemon: `127.0.0.1:6767`

They do not share a port. MCPProxy process storms can still starve the workstation and make
Paseo appear unavailable.

## Root cause

MCPProxy `v0.48.1` prefers the `SHELL` environment variable on Windows. It treats every
non-bash shell as `cmd.exe`, including argument quoting and the `/c` switch. This workstation
sets `SHELL` to PowerShell 7, so the old launcher produced `pwsh.exe /c` with cmd-style
quoting. All 11 enabled stdio upstreams failed and retried continuously.

The old Startup-folder VBS also restarted MCPProxy every three seconds without a single-
instance guard. Do not restore that launcher or change the user's global `SHELL` value.

## Installed startup

The scheduled task is named `MCPProxy Gateway`. It:

- starts 60 seconds after this user logs on;
- ignores a new start while the task is already running;
- retries a failed run up to three times at one-minute intervals;
- invokes `C:\Users\Administrator\mcpproxy-trial\mcpproxy-gateway.vbs`;
- sets `SHELL=%COMSPEC%` only in the gateway process tree;
- starts MCPProxy once and leaves bounded restart policy to Task Scheduler.

The machine-local operating notes live at
`C:\Users\Administrator\mcpproxy-trial\STARTUP-OPERATIONS.txt`.

## Verification

`/healthz` proves only that the proxy is alive. Upstream readiness must use
`/api/v1/servers` with the configured API key and confirm all of the following:

- `success=true`;
- `stats.total_servers=11`;
- `stats.connected_servers=11`;
- all 11 server rows have `connected=true`.

The scheduled task itself must be `Ready` while the separately launched gateway is running. A
`Disabled` task leaves the current process usable but prevents recovery after the next login.

Client-visible readiness needs one more check: call `retrieve_tools` with a natural-language
query and confirm it returns an expected upstream tool. Do not apply annotation filters while
diagnosing older local Python MCP servers; missing annotations cause `read_only_only` and
`exclude_destructive` to filter those tools out even when their transports are healthy.

For startup regressions, sample readiness at startup, 30 seconds, and 60 seconds. Compare the
recursive descendant PID set at the beginning and end of the observation window, scan the new
log segment for reconnect errors, and monitor for new visible console windows.

## Operations

Check status:

```powershell
Get-ScheduledTask -TaskName "MCPProxy Gateway" | Format-List TaskName,State
Invoke-RestMethod http://127.0.0.1:8933/healthz
```

Start the task:

```powershell
Start-ScheduledTask -TaskName "MCPProxy Gateway"
```

Stop the task and the exact process tree that owns port `8933`:

```powershell
pwsh -NoProfile -File "C:\Users\Administrator\mcpproxy-trial\mcpproxy-stop.ps1"
```

Do not use `Stop-ScheduledTask` alone. Windows can terminate `wscript.exe` while leaving its
MCPProxy child tree running. The stop helper verifies both port `8933` and the expected
MCPProxy executable path before stopping the scoped tree.

## Rollback

```powershell
pwsh -NoProfile -File "C:\Users\Administrator\mcpproxy-trial\mcpproxy-stop.ps1"
Disable-ScheduledTask -TaskName "MCPProxy Gateway"
Unregister-ScheduledTask -TaskName "MCPProxy Gateway" -Confirm:$false
```

The pre-fix launcher is backed up as
`C:\Users\Administrator\mcpproxy-trial\mcpproxy-gateway.vbs.pre-fix-20260718` for
inspection only. Do not put it back in the Startup folder.

MCPProxy `v0.48.1` does not set `CREATE_NO_WINDOW` for Windows upstream processes. The repaired
launcher passed the visible-window observation on this workstation, but this remains a binary-
level residual risk until MCPProxy handles Windows process creation itself.
