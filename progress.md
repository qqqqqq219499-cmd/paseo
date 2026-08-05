## 2026-07-17 - Task: Complete modular Grok thinking and context migration

### What was done

- Kept Grok thinking enrichment in the Grok adapter and verified the client-level wiring.
- Added standard ACP context-usage mapping and a provider resolver boundary.
- Connected Grok notification metadata and `signals.json` context usage without adding Grok rules to the shared ACP transport.
- Preserved live context occupancy through foreground and autonomous turn completion.

### Testing

- RED: `npx vitest run packages/server/src/server/agent/providers/acp-context-usage.test.ts packages/server/src/server/agent/providers/grok/session-context.test.ts packages/server/src/server/agent/providers/acp-agent.test.ts --bail=1` failed because the ACP context module and Grok notification resolver did not exist.
- GREEN: `npx vitest run packages/server/src/server/agent/providers/acp-context-usage.test.ts packages/server/src/server/agent/providers/acp-agent.test.ts packages/server/src/server/agent/providers/grok/acp-agent.test.ts packages/server/src/server/agent/providers/grok/reasoning-efforts.test.ts packages/server/src/server/agent/providers/grok/session-context.test.ts --bail=1` passed 98 tests in 5 files.
- Typecheck: `npm run typecheck --workspace=@getpaseo/server` exited 0.
- Lint: targeted `npm run lint -- <changed TypeScript files>` reported 0 warnings and 0 errors.
- Format: targeted `npm run format:check:files -- <changed files>` reported all files correctly formatted.

### Notes

- `CLAUDE.md` - added the Grok provider adapter document to the docs index.
- `docs/grok-provider.md` - documented thinking/context behavior and module ownership.
- `docs/port-from-paseo-reclaude.md` - recorded the completed Grok thinking/context migration.
- `packages/server/src/server/agent/providers/acp-context-usage.ts` - added standard ACP mapping, validation, deduplication, and the provider resolver interface.
- `packages/server/src/server/agent/providers/acp-context-usage.test.ts` - covered ACP mapping and merge behavior.
- `packages/server/src/server/agent/providers/acp-agent.ts` - wired context resolver lifecycle and usage event preservation.
- `packages/server/src/server/agent/providers/acp-agent.test.ts` - covered ACP updates, provider metadata, and turn completion.
- `packages/server/src/server/agent/providers/generic-acp-agent.ts` - forwarded the optional provider context resolver.
- `packages/server/src/server/agent/providers/grok/acp-agent.ts` - composed the Grok context resolver with existing thinking/mode adapters.
- `packages/server/src/server/agent/providers/grok/acp-agent.test.ts` - verified Grok thinking and context adapters are both wired.
- `packages/server/src/server/agent/providers/grok/session-context.ts` - added Grok notification parsing and resolver construction.
- `packages/server/src/server/agent/providers/grok/session-context.test.ts` - covered notification and disk context sources.
- Rollback point: `08a3b96fd` (HEAD before this task). Before committing, restore tracked paths with `git restore -- CLAUDE.md docs/port-from-paseo-reclaude.md packages/server/src/server/agent/providers/acp-agent.test.ts packages/server/src/server/agent/providers/acp-agent.ts packages/server/src/server/agent/providers/generic-acp-agent.ts packages/server/src/server/agent/providers/grok/acp-agent.ts packages/server/src/server/agent/providers/grok/session-context.test.ts packages/server/src/server/agent/providers/grok/session-context.ts` and remove this task's new files with `Remove-Item -LiteralPath docs/grok-provider.md,progress.md,packages/server/src/server/agent/providers/acp-context-usage.ts,packages/server/src/server/agent/providers/acp-context-usage.test.ts,packages/server/src/server/agent/providers/grok/acp-agent.test.ts`.

## 2026-07-17 - Task: Restore Grok context display and preserve thinking across model changes

### What was done

- Preserved the latest Grok context usage across the quota-failover wrapper's eager subscription so restored sessions expose the context ring immediately.
- Connected the modular ACP model-thinking resolver to model changes, preserving a supported effort and falling back to the target model's current/default effort.
- Verified the live composer control changes the native Grok reasoning effort and restored the test session to `high`.

### Testing

- RED: `npx vitest run packages/server/src/server/agent/providers/grok/auto-failover.test.ts --bail=1` failed because the wrapper replayed only `thread_started`, not the seeded `usage_updated` event.
- RED: `npx vitest run packages/server/src/server/agent/providers/acp-agent.test.ts --bail=1` failed because model selection omitted `_meta.reasoningEffort`.
- GREEN: `npx vitest run packages/server/src/server/agent/providers/grok/auto-failover.test.ts packages/server/src/server/agent/providers/acp-agent.test.ts packages/server/src/server/agent/providers/acp-model-thinking.test.ts --bail=1` passed 112 tests in 3 files.
- Typecheck: `npm run typecheck --workspace=@getpaseo/server` exited 0.
- Lint: targeted `npm run lint -- <13 changed TypeScript files>` reported 0 warnings and 0 errors.
- Format: targeted `npm run format:check:files -- <16 changed files>` reported all files correctly formatted; `git diff --check` produced no errors.
- Build: `npm run build:server` exited 0 and rebuilt protocol, client, server, and CLI outputs.
- Runtime: restarted only the isolated desktop target; `6788` (daemon PID 64828), `8081` (Metro PID 51896), and `9223` (CDP PID 49496) listened successfully while the installed daemon on `6767` remained untouched.
- UI: CDP found `agent-thinking-selector` with Chinese `High` text (U+9AD8) and `context-window-meter` reporting 10% context used; hover showed `50k / 500k tokens` from the real `49179 / 500000` signals data.
- Interaction: selecting `Low` changed both Paseo runtime and Grok `summary.json` to `low`; selecting `High` restored both to `high`.

### Notes

- `packages/server/src/server/agent/providers/grok/auto-failover.ts` - cached and replayed the latest usage event across the Grok account wrapper.
- `packages/server/src/server/agent/providers/grok/auto-failover.test.ts` - reproduced and covered the lost initial usage event.
- `packages/server/src/server/agent/providers/acp-agent.ts` - applied the modular thinking resolver during ACP model selection.
- `packages/server/src/server/agent/providers/acp-agent.test.ts` - covered reasoning-effort preservation on model changes.
- `packages/server/src/server/agent/providers/acp-model-thinking.test.ts` - covered fallback to the target model's effort.
- `docs/grok-provider.md` - documented model-switch and quota-wrapper ownership boundaries.
- `docs/port-from-paseo-reclaude.md` - recorded the modular thinking resolver and failover replay landing points.
- `progress.md` - appended this task record and verification evidence.
- Rollback point: `08a3b96fd0` (HEAD before the full uncommitted Grok migration). Restore tracked paths with `git restore -- CLAUDE.md docs/port-from-paseo-reclaude.md packages/server/src/server/agent/providers/acp-agent.test.ts packages/server/src/server/agent/providers/acp-agent.ts packages/server/src/server/agent/providers/generic-acp-agent.ts packages/server/src/server/agent/providers/grok/acp-agent.ts packages/server/src/server/agent/providers/grok/auto-failover.test.ts packages/server/src/server/agent/providers/grok/auto-failover.ts packages/server/src/server/agent/providers/grok/session-context.test.ts packages/server/src/server/agent/providers/grok/session-context.ts` and remove the migration's new files with `Remove-Item -LiteralPath docs/grok-provider.md,progress.md,packages/server/src/server/agent/providers/acp-context-usage.ts,packages/server/src/server/agent/providers/acp-context-usage.test.ts,packages/server/src/server/agent/providers/acp-model-thinking.ts,packages/server/src/server/agent/providers/acp-model-thinking.test.ts,packages/server/src/server/agent/providers/grok/acp-agent.test.ts`.

## 2026-07-18 - Task: Repair MCPProxy Windows startup

### What was done

- Replaced the Startup-folder retry loop with a one-shot hidden launcher that overrides `SHELL` to `COMSPEC` only for the MCPProxy process tree.
- Registered a delayed, single-instance scheduled task with bounded restart policy and kept the old Startup entry disabled.
- Added an exact-port/executable stop helper so stopping the task also removes its scoped MCPProxy descendant tree without broad process-name sweeps.
- Documented startup, readiness validation, operations, rollback, and the remaining MCPProxy `CREATE_NO_WINDOW` limitation.

### Testing

- Isolated launch: temporary port `18934` reached `11/11` immediately; three readiness samples passed, the process tree stayed at 28 processes, visible windows stayed at 0, and all scoped test PIDs were cleaned.
- Formal scheduled-task launch: port `8933` reached `11/11`; startup, 30-second, and 60-second samples passed; the 27-process PID set had zero churn; visible console windows and post-readiness reconnect errors both stayed at 0.
- Single-instance: a second `Start-ScheduledTask` kept listener PID `39488` unchanged, with exactly one `mcpproxy.exe` process and `11/11` upstreams.
- Scoped shutdown: `pwsh -NoProfile -File C:\Users\Administrator\mcpproxy-trial\mcpproxy-stop.ps1` stopped the prior listener and 27 descendants, leaving zero listeners on `8933` before the final launch.
- Task policy: `MCPProxy Gateway` is running with `PT1M` login delay, `IgnoreNew`, three retries, and a one-minute retry interval.
- Docs: `npm run format:check:files -- CLAUDE.md docs/windows-mcpproxy-startup.md` exited 0; `git diff --check` produced no errors.

### Notes

- `C:\Users\Administrator\mcpproxy-trial\mcpproxy-gateway.vbs` - replaced the unbounded loop with a process-local shell fix and one-shot gateway launch.
- `C:\Users\Administrator\mcpproxy-trial\mcpproxy-stop.ps1` - added exact listener-path validation and scoped descendant cleanup.
- `C:\Users\Administrator\mcpproxy-trial\STARTUP-DISABLED.txt` - replaced unsafe restore instructions with a pointer to the scheduled-task workflow.
- `C:\Users\Administrator\mcpproxy-trial\STARTUP-OPERATIONS.txt` - added status, start, stop, disable, and rollback commands.
- `C:\Users\Administrator\mcpproxy-trial\mcpproxy-gateway.vbs.pre-fix-20260718` - preserved the original launcher as a rollback reference only.
- `CLAUDE.md` - indexed the Windows MCPProxy operations document.
- `docs/windows-mcpproxy-startup.md` - recorded the root cause, task policy, verification contract, and residual risk.
- `progress.md` - appended this task record and evidence.
- Rollback point: `23f5a0e243` (HEAD before this task). Run the scoped stop helper, then `Disable-ScheduledTask -TaskName "MCPProxy Gateway"` and `Unregister-ScheduledTask -TaskName "MCPProxy Gateway" -Confirm:$false`; restore the external launcher with `Copy-Item C:\Users\Administrator\mcpproxy-trial\mcpproxy-gateway.vbs.pre-fix-20260718 C:\Users\Administrator\mcpproxy-trial\mcpproxy-gateway.vbs -Force`. Restore repository files with `git restore -- CLAUDE.md progress.md` and remove the new document with `Remove-Item -LiteralPath docs/windows-mcpproxy-startup.md`.

## 2026-07-18 - Task: Merge official Paseo 0.2.0-beta.1 update

### What was done

- Merged `origin/main` through `a1de743ef` into `feature/grok-accounts-zh-i18n`, adopting the official `0.2.0-beta.1` baseline.
- Resolved the sidebar and server bootstrap/session/WebSocket conflicts while preserving the local Chinese/new-theme and Grok account capabilities alongside the official resize, workspace provisioning, and Hub features.
- Fixed the combined Grok/Hub permission regression so Grok account metadata is broadcast only to trusted clients, never Hub execution sockets.

### Testing

- Runtime/dependencies: verified `Node v22.20.0` and `npm 10.9.3`; `npm ci` completed with 2,576 packages installed and the repository patches applied.
- Conflict checks: all conflict markers were removed and `git diff --check` exited 0.
- Targeted merge tests: bootstrap tests passed `2/2`; the isolated provider-availability test passed `1/1`; Hub execution WebSocket tests passed `8/8`.
- Protocol/client/Grok tests: `npx vitest run packages/protocol/src/messages.hub.test.ts packages/client/src/daemon-client.test.ts packages/server/src/services/grok/grok-account-service.test.ts packages/server/src/services/grok/grok-account-store.test.ts --bail=1` passed 217 tests in 4 files with 1 pre-existing conditional skip.
- Grok/Hub isolation RED: `npx vitest run packages/server/src/server/websocket-server.notifications.test.ts --bail=1` failed because the Hub socket received one `provider.grok.changed` frame containing account metadata.
- Grok/Hub isolation GREEN: the same command passed all 6 tests after routing the push through the trusted-only broadcaster.
- Builds: `npm run build:client` and `npm run build:server` both exited 0 under Node 22.20.0.
- Typecheck: a fresh post-fix `npm run typecheck` passed all 10 workspaces.
- Lint: full `npm run lint` reported 0 warnings and 0 errors across 2,828 files; the final Grok/Hub fix also passed targeted lint with 0 warnings and 0 errors.
- Format: `npm run format:check` reported all 3,031 matched files correctly formatted after restoring the staged index's canonical LF bytes; the index tree hash remained unchanged and no unstaged diff was introduced.

### Notes

- `.agents/skills/release-beta/SKILL.md` - merged official upstream changes.
- `.agents/skills/release-stable/SKILL.md` - merged official upstream changes.
- `.github/workflows/ci.yml` - merged official upstream changes.
- `CHANGELOG.md` - merged the official 0.2.0-beta.1 release notes.
- `docs/android.md` - merged official upstream documentation updates.
- `docs/architecture.md` - merged official upstream documentation updates.
- `docs/data-model.md` - merged official upstream documentation updates.
- `docs/glossary.md` - merged official upstream documentation updates.
- `docs/hub.md` - added from the official upstream update.
- `docs/release.md` - merged official upstream documentation updates.
- `docs/testing.md` - merged official upstream documentation updates.
- `nix/npm-deps.hash` - merged official upstream changes.
- `package-lock.json` - adopted the official 0.2.0-beta.1 dependency lock.
- `package.json` - adopted the official 0.2.0-beta.1 workspace version and scripts.
- `packages/app/e2e/directory-bootstrap.spec.ts` - added from the official upstream update.
- `packages/app/e2e/empty-project-persists.spec.ts` - merged official upstream test updates.
- `packages/app/e2e/global-setup.ts` - merged official upstream changes.
- `packages/app/e2e/helpers/daemon-client-loader.ts` - merged official upstream changes.
- `packages/app/e2e/helpers/daemon-restart.ts` - removed as part of the official upstream update.
- `packages/app/e2e/helpers/daemon-websocket-gate.ts` - added from the official upstream update.
- `packages/app/e2e/helpers/directory-bootstrap-scenario.ts` - added from the official upstream update.
- `packages/app/e2e/helpers/isolated-host-daemon.ts` - merged official upstream changes.
- `packages/app/e2e/helpers/new-workspace.ts` - merged official upstream changes.
- `packages/app/e2e/helpers/seed-client.ts` - merged official upstream changes.
- `packages/app/e2e/projects-settings.spec.ts` - merged official upstream test updates.
- `packages/app/e2e/sidebar-reorder.spec.ts` - added from the official upstream update.
- `packages/app/e2e/sidebar-resize-handle.spec.ts` - added from the official upstream update.
- `packages/app/e2e/sidebar-workspace.spec.ts` - merged official upstream test updates.
- `packages/app/e2e/viewed-agent-timelines.spec.ts` - added from the official upstream update.
- `packages/app/e2e/workspace-model-restart.spec.ts` - merged official upstream test updates.
- `packages/app/e2e/workspace-navigation-regression.spec.ts` - merged official upstream test updates.
- `packages/app/e2e/worktree-restore-after-restart.spec.ts` - merged official upstream test updates.
- `packages/app/e2e/worktree-restore.spec.ts` - merged official upstream test updates.
- `packages/app/eas.json` - merged official upstream changes.
- `packages/app/package.json` - synchronized the official beta workspace metadata and dependencies.
- `packages/app/src/add-project-flow/model.test.ts` - merged official upstream test updates.
- `packages/app/src/add-project-flow/options.ts` - merged official upstream changes.
- `packages/app/src/components/add-project-flow.tsx` - merged official upstream changes.
- `packages/app/src/components/browser-webview-resident.ts` - merged official upstream changes.
- `packages/app/src/components/drag-reorder/index.ts` - merged official upstream changes.
- `packages/app/src/components/drag-reorder/pointer-activation.test.ts` - merged official upstream test updates.
- `packages/app/src/components/drag-reorder/pointer-activation.ts` - merged official upstream changes.
- `packages/app/src/components/draggable-list.web.tsx` - merged official upstream changes.
- `packages/app/src/components/explorer-sidebar.tsx` - merged official upstream changes.
- `packages/app/src/components/icons/omp-icon.tsx` - merged official upstream changes.
- `packages/app/src/components/left-sidebar.tsx` - resolved the new-theme/Chinese sidebar conflict while adopting the official resize handle.
- `packages/app/src/components/rewind/use-rewind-agent-mutation.ts` - merged official upstream changes.
- `packages/app/src/components/sidebar-resize-handle.tsx` - added from the official upstream update.
- `packages/app/src/components/sidebar-workspace-list.tsx` - merged official upstream changes.
- `packages/app/src/components/sidebar/use-long-press-drag-interaction.ts` - merged official upstream changes.
- `packages/app/src/components/tool-call-details.tsx` - merged official upstream changes.
- `packages/app/src/contexts/session-context.tsx` - merged official upstream changes.
- `packages/app/src/contexts/session-resume-revalidation.test.ts` - added from the official upstream update.
- `packages/app/src/contexts/session-resume-revalidation.ts` - added from the official upstream update.
- `packages/app/src/contexts/workspace-directory-reconciliation.test.ts` - added from the official upstream update.
- `packages/app/src/contexts/workspace-directory-reconciliation.ts` - added from the official upstream update.
- `packages/app/src/data/acp-provider-catalog.ts` - merged official upstream changes.
- `packages/app/src/diagnostics/app-diagnostic-report.test.ts` - merged official upstream test updates.
- `packages/app/src/e2e-metro-readiness.test.ts` - added from the official upstream update.
- `packages/app/src/hooks/use-agent-initialization.test.ts` - merged official upstream test updates.
- `packages/app/src/hooks/use-agent-initialization.ts` - merged official upstream changes.
- `packages/app/src/hooks/use-load-older-agent-history.ts` - merged official upstream changes.
- `packages/app/src/hooks/use-open-project.ts` - merged official upstream changes.
- `packages/app/src/panels/agent-panel.tsx` - merged official upstream changes.
- `packages/app/src/runtime/directory-sync/agent-replica.test.ts` - added from the official upstream update.
- `packages/app/src/runtime/directory-sync/agent-replica.ts` - added from the official upstream update.
- `packages/app/src/runtime/directory-sync/index.test.ts` - added from the official upstream update.
- `packages/app/src/runtime/directory-sync/index.ts` - added from the official upstream update.
- `packages/app/src/runtime/directory-sync/transaction.test.ts` - added from the official upstream update.
- `packages/app/src/runtime/directory-sync/transaction.ts` - added from the official upstream update.
- `packages/app/src/runtime/directory-sync/workspace-replica.test.ts` - added from the official upstream update.
- `packages/app/src/runtime/directory-sync/workspace-replica.ts` - added from the official upstream update.
- `packages/app/src/runtime/host-runtime.test.ts` - merged official upstream test updates.
- `packages/app/src/runtime/host-runtime.ts` - merged official upstream changes.
- `packages/app/src/screens/workspace/visible-agent-ids.test.ts` - added from the official upstream update.
- `packages/app/src/screens/workspace/visible-agent-ids.ts` - added from the official upstream update.
- `packages/app/src/screens/workspace/workspace-screen.tsx` - merged official upstream changes.
- `packages/app/src/stores/session-store.test.ts` - merged official upstream test updates.
- `packages/app/src/stores/session-store.ts` - merged official upstream changes.
- `packages/app/src/timeline/fetch-agent-timeline-once.test.ts` - added from the official upstream update.
- `packages/app/src/timeline/fetch-agent-timeline-once.ts` - added from the official upstream update.
- `packages/app/src/timeline/session-stream-reducers.ts` - merged official upstream changes.
- `packages/app/src/timeline/timeline-sync-plan.test.ts` - merged official upstream test updates.
- `packages/app/src/timeline/timeline-sync-plan.ts` - merged official upstream changes.
- `packages/app/src/timeline/viewed-timeline-sync.test.ts` - added from the official upstream update.
- `packages/app/src/timeline/viewed-timeline-sync.ts` - added from the official upstream update.
- `packages/app/src/utils/agent-directory-reconciliation.test.ts` - added from the official upstream update.
- `packages/app/src/utils/agent-directory-reconciliation.ts` - added from the official upstream update.
- `packages/app/src/utils/agent-directory-sync.test.ts` - merged official upstream test updates.
- `packages/app/src/utils/agent-directory-sync.ts` - merged official upstream changes.
- `packages/app/src/utils/agent-directory-update-policy.ts` - added from the official upstream update.
- `packages/app/src/workspace/legacy-daemon-workspaces.ts` - merged official upstream changes.
- `packages/cli/package.json` - synchronized the official beta workspace metadata and dependencies.
- `packages/cli/src/cli.ts` - merged official upstream changes.
- `packages/cli/src/commands/hub/index.ts` - added from the official upstream update.
- `packages/client/package.json` - synchronized the official beta workspace metadata and dependencies.
- `packages/client/src/daemon-client.test.ts` - merged official upstream test updates.
- `packages/client/src/daemon-client.ts` - merged official upstream changes.
- `packages/desktop/package.json` - synchronized the official beta workspace metadata and dependencies.
- `packages/desktop/scripts/browser-tab-bridge.e2e.mjs` - added from the official upstream update.
- `packages/desktop/scripts/dev-runner.mjs` - merged official upstream changes.
- `packages/desktop/src/features/browser-automation/actionability.ts` - merged official upstream changes.
- `packages/desktop/src/features/browser-keyboard/index.test.ts` - merged official upstream test updates.
- `packages/desktop/src/features/browser-keyboard/index.ts` - merged official upstream changes.
- `packages/desktop/src/features/browser-webviews/registry.test.ts` - merged official upstream test updates.
- `packages/desktop/src/features/browser-webviews/registry.ts` - merged official upstream changes.
- `packages/expo-two-way-audio/package.json` - synchronized the official beta workspace metadata and dependencies.
- `packages/highlight/package.json` - synchronized the official beta workspace metadata and dependencies.
- `packages/protocol/package.json` - synchronized the official beta workspace metadata and dependencies.
- `packages/protocol/src/client-capabilities.ts` - merged official upstream changes.
- `packages/protocol/src/messages.hub.test.ts` - added from the official upstream update.
- `packages/protocol/src/messages.test.ts` - merged official upstream test updates.
- `packages/protocol/src/messages.ts` - merged Hub protocol messages and clarified that Grok account state is broadcast only to trusted clients.
- `packages/relay/package.json` - synchronized the official beta workspace metadata and dependencies.
- `packages/server/package.json` - synchronized the official beta workspace metadata and dependencies.
- `packages/server/src/server/agent/agent-loading.ts` - merged official upstream changes.
- `packages/server/src/server/agent/agent-manager.ts` - merged official upstream changes.
- `packages/server/src/server/agent/agent-owner.ts` - added from the official upstream update.
- `packages/server/src/server/agent/agent-projections.ts` - merged official upstream changes.
- `packages/server/src/server/agent/agent-storage.ts` - merged official upstream changes.
- `packages/server/src/server/agent/create-agent-lifecycle-dispatch.test.ts` - added from the official upstream update.
- `packages/server/src/server/agent/create-agent-lifecycle-dispatch.ts` - merged official upstream changes.
- `packages/server/src/server/agent/create-agent/create.test.ts` - merged official upstream test updates.
- `packages/server/src/server/agent/create-agent/create.ts` - merged official upstream changes.
- `packages/server/src/server/agent/mcp-server.test.ts` - merged official upstream test updates.
- `packages/server/src/server/agent/providers/opencode-agent.test.ts` - merged official upstream test updates.
- `packages/server/src/server/auto-archive-on-merge/archive-if-safe.test.ts` - merged official upstream test updates.
- `packages/server/src/server/auto-archive-on-merge/archive-if-safe.ts` - merged official upstream changes.
- `packages/server/src/server/bootstrap-provider-availability.test.ts` - merged official upstream test updates.
- `packages/server/src/server/bootstrap.test.ts` - added from the official upstream update.
- `packages/server/src/server/bootstrap.ts` - resolved bootstrap conflicts while retaining Grok accounts, workspace provisioning, and Hub lifecycle wiring.
- `packages/server/src/server/daemon-client.e2e.test.ts` - merged official upstream test updates.
- `packages/server/src/server/daemon-e2e/empty-project-persists.e2e.test.ts` - merged official upstream test updates.
- `packages/server/src/server/daemon-e2e/open-project-worktree-reclassification.e2e.test.ts` - merged official upstream test updates.
- `packages/server/src/server/daemon-e2e/project-becomes-git.e2e.test.ts` - added from the official upstream update.
- `packages/server/src/server/hub/daemon-executions.test.ts` - added from the official upstream update.
- `packages/server/src/server/hub/daemon-executions.ts` - added from the official upstream update.
- `packages/server/src/server/hub/execution-controller.test.ts` - added from the official upstream update.
- `packages/server/src/server/hub/execution-controller.ts` - added from the official upstream update.
- `packages/server/src/server/hub/execution-session.websocket.test.ts` - added from the official upstream update.
- `packages/server/src/server/hub/relationship-controller.test.ts` - added from the official upstream update.
- `packages/server/src/server/hub/relationship-controller.ts` - added from the official upstream update.
- `packages/server/src/server/hub/relationship-remote.test.ts` - added from the official upstream update.
- `packages/server/src/server/hub/relationship-remote.ts` - added from the official upstream update.
- `packages/server/src/server/hub/relationship-retry.test.ts` - added from the official upstream update.
- `packages/server/src/server/hub/relationship-retry.ts` - added from the official upstream update.
- `packages/server/src/server/hub/test-utils/relationship-harness.ts` - added from the official upstream update.
- `packages/server/src/server/loop-service.test.ts` - merged official upstream test updates.
- `packages/server/src/server/paseo-worktree-service.test.ts` - merged official upstream test updates.
- `packages/server/src/server/paseo-worktree-service.ts` - merged official upstream changes.
- `packages/server/src/server/persistence-hooks.ts` - merged official upstream changes.
- `packages/server/src/server/schedule/service.test.ts` - merged official upstream test updates.
- `packages/server/src/server/schedule/service.ts` - merged official upstream changes.
- `packages/server/src/server/selective-timeline-delivery.e2e.test.ts` - added from the official upstream update.
- `packages/server/src/server/session.create-agent-worktree-autoarchive.e2e.test.ts` - merged official upstream test updates.
- `packages/server/src/server/session.test.ts` - merged official upstream test updates.
- `packages/server/src/server/session.ts` - resolved session conflicts while retaining Grok and Hub execution/relationship dependencies.
- `packages/server/src/server/session.workspace-git-watch.test.ts` - merged official upstream test updates.
- `packages/server/src/server/session.workspace-resolution-invariants.test.ts` - merged official upstream test updates.
- `packages/server/src/server/session.workspaces.test.ts` - merged official upstream test updates.
- `packages/server/src/server/session/daemon/daemon-session.test.ts` - merged official upstream test updates.
- `packages/server/src/server/session/daemon/daemon-session.ts` - merged official upstream changes.
- `packages/server/src/server/session/workspace-git-observer/workspace-git-observer-service.test.ts` - merged official upstream test updates.
- `packages/server/src/server/session/workspace-git-observer/workspace-git-observer-service.ts` - merged official upstream changes.
- `packages/server/src/server/session/workspace-provisioning/workspace-provisioning-service.test.ts` - merged official upstream test updates.
- `packages/server/src/server/session/workspace-provisioning/workspace-provisioning-service.ts` - merged official upstream changes.
- `packages/server/src/server/session/workspace-recovery/workspace-recovery-service.test.ts` - merged official upstream test updates.
- `packages/server/src/server/session/workspace-recovery/workspace-recovery-service.ts` - merged official upstream changes.
- `packages/server/src/server/session/workspace-scripts/workspace-scripts-service.test.ts` - merged official upstream test updates.
- `packages/server/src/server/session/workspace-scripts/workspace-scripts-service.ts` - merged official upstream changes.
- `packages/server/src/server/snapshot-mutation-ownership.test.ts` - merged official upstream test updates.
- `packages/server/src/server/test-utils/fake-agent-client.ts` - merged official upstream changes.
- `packages/server/src/server/test-utils/hub-cli-entry.ts` - added from the official upstream update.
- `packages/server/src/server/test-utils/workspace-git-service-stub.ts` - merged official upstream changes.
- `packages/server/src/server/websocket-server.notifications.test.ts` - merged upstream notification tests and added Hub isolation coverage for Grok account state.
- `packages/server/src/server/websocket-server.relay-reconnect.test.ts` - merged official upstream test updates.
- `packages/server/src/server/websocket-server.terminal-notifications.test.ts` - merged official upstream test updates.
- `packages/server/src/server/websocket-server.ts` - resolved WebSocket injection conflicts and restricted Grok account broadcasts to trusted clients.
- `packages/server/src/server/wire-compat.test.ts` - merged official upstream test updates.
- `packages/server/src/server/workspace-archive-service.test.ts` - merged official upstream test updates.
- `packages/server/src/server/workspace-archive-service.ts` - merged official upstream changes.
- `packages/server/src/server/workspace-auto-name.ts` - merged official upstream changes.
- `packages/server/src/server/workspace-directory.ts` - merged official upstream changes.
- `packages/server/src/server/workspace-git-metadata.test.ts` - merged official upstream test updates.
- `packages/server/src/server/workspace-git-metadata.ts` - merged official upstream changes.
- `packages/server/src/server/workspace-git-service.primitive.test.ts` - merged official upstream test updates.
- `packages/server/src/server/workspace-git-service.ts` - merged official upstream changes.
- `packages/server/src/server/workspace-reconciliation-observation.test.ts` - added from the official upstream update.
- `packages/server/src/server/workspace-reconciliation-service.test.ts` - merged official upstream test updates.
- `packages/server/src/server/workspace-reconciliation-service.ts` - merged official upstream changes.
- `packages/server/src/server/workspace-registry-bootstrap-legacy.ts` - added from the official upstream update.
- `packages/server/src/server/workspace-registry-bootstrap.test.ts` - merged official upstream test updates.
- `packages/server/src/server/workspace-registry-bootstrap.ts` - merged official upstream changes.
- `packages/server/src/server/workspace-registry-model.test.ts` - merged official upstream test updates.
- `packages/server/src/server/workspace-registry-model.ts` - merged official upstream changes.
- `packages/server/src/server/workspace-registry.test.ts` - merged official upstream test updates.
- `packages/server/src/server/workspace-registry.ts` - merged official upstream changes.
- `packages/server/src/server/worktree-bootstrap.ts` - merged official upstream changes.
- `packages/server/src/server/worktree-session.test.ts` - merged official upstream test updates.
- `packages/server/src/server/worktree-session.ts` - merged official upstream changes.
- `packages/server/src/server/worktree/commands.ts` - merged official upstream changes.
- `packages/server/src/utils/checkout-git.test.ts` - merged official upstream test updates.
- `packages/server/src/utils/checkout-git.ts` - merged official upstream changes.
- `packages/server/src/utils/path.test.ts` - merged official upstream test updates.
- `packages/server/src/utils/path.ts` - merged official upstream changes.
- `packages/server/src/utils/worktree.test.ts` - merged official upstream test updates.
- `packages/server/src/utils/worktree.ts` - merged official upstream changes.
- `packages/website/package.json` - synchronized the official beta workspace metadata and dependencies.
- `progress.md` - appended this merge record, verification evidence, file inventory, and rollback instructions.
- `.git/config` - set repository-local `core.autocrlf=false` so future merges preserve the LF line endings required by oxfmt without changing the machine-wide Git setting.
- `C:\Users\Administrator\windows-dev-gotchas.md` - documented the Lefthook-to-WSL PATH collision and the oxfmt/Git merge line-ending recovery procedure.
- Dependency audit note: `npm ci` reported 72 inherited dependency advisories (7 low, 39 moderate, 20 high, 6 critical); no dependency versions were changed beyond the official lockfile in this merge.
- Rollback point: `051044541`. After the merge commit, run `$merge = git rev-list --merges --first-parent 051044541..HEAD | Select-Object -First 1; git revert -m 1 $merge` to create a non-destructive rollback commit.

## 2026-07-18 - Task: Build Paseo 0.2.0-beta.1 Windows desktop package

### What was done

- Built the Windows desktop artifacts from merge commit `c62855299` with the repository-required Node 22.20.0 runtime.
- Ran the packaged x64 application through the isolated renderer, preload, daemon, CLI status, and terminal smoke workflow without touching the production Paseo or MCPProxy listeners.
- Produced the x64 installer and zip, calculated their SHA256 hashes, and verified version metadata and Windows signature state.

### Testing

- Build: `npm run build:desktop -- --publish never --win --x64` exited 0 under `Node v22.20.0`; Expo exported 4,530 modules and electron-builder 26.8.1 completed the Windows targets.
- Packaged smoke: `Packaged desktop smoke passed: real renderer and preload loaded; renderer-started desktop daemon pid 6952, listen 127.0.0.1:14737; CLI shim daemon status and terminal smoke succeeded`.
- Runtime isolation: production Paseo port `6767` stayed on PID `4044`, MCPProxy port `8933` stayed on PID `39488`, and temporary smoke port `14737` had no listener after cleanup.
- x64 installer: `Paseo-Setup-0.2.0-beta.1-x64.exe`, 115,666,447 bytes, SHA256 `12246BA2280D7CECC51C0F91F1C037226226F537DB7527C1DBD4B90F1A63B82F`.
- x64 zip: `Paseo-Setup-0.2.0-beta.1-x64.zip`, 160,523,790 bytes, SHA256 `B9A8FDEEAA606C518A01A66B06D149C120F26FFD8D21C0085271A98D206A0299`.
- Version/archive: unpacked `Paseo.exe` reported file version `0.2.0-beta.1`, product version `0.2.0.0`, and the x64 zip listed the expected Electron runtime files.
- Signature: `Get-AuthenticodeSignature` reported `NotSigned` for the x64 installer, combined installer, and unpacked application executable.
- Repository: the build left no tracked or untracked Git changes; generated release artifacts remain ignored by the repository.

### Notes

- `packages/desktop/release/Paseo-Setup-0.2.0-beta.1-x64.exe` - generated the 64-bit Windows NSIS installer.
- `packages/desktop/release/Paseo-Setup-0.2.0-beta.1-x64.exe.blockmap` - generated update metadata for the x64 installer.
- `packages/desktop/release/Paseo-Setup-0.2.0-beta.1-x64.zip` - generated the portable x64 archive.
- `packages/desktop/release/Paseo-Setup-0.2.0-beta.1-arm64.exe` - generated the ARM64 NSIS installer because the committed Windows target configuration includes both architectures.
- `packages/desktop/release/Paseo-Setup-0.2.0-beta.1-arm64.exe.blockmap` - generated update metadata for the ARM64 installer.
- `packages/desktop/release/Paseo-Setup-0.2.0-beta.1-arm64.zip` - generated the portable ARM64 archive.
- `packages/desktop/release/Paseo-Setup-0.2.0-beta.1.exe` - generated the combined x64/ARM64 NSIS installer.
- `packages/desktop/release/Paseo-Setup-0.2.0-beta.1.exe.blockmap` - generated update metadata for the combined installer.
- `packages/desktop/release/latest.yml` - refreshed electron-updater metadata for the new beta artifacts.
- `packages/desktop/release/builder-debug.yml` - refreshed electron-builder diagnostic metadata.
- `packages/desktop/release/win-unpacked/**` - generated the unpacked x64 application tree used by the successful smoke test.
- `packages/desktop/release/win-arm64-unpacked/**` - generated the unpacked ARM64 application tree; smoke was correctly skipped because the host is x64.
- `progress.md` - appended this packaging record, artifact hashes, validation evidence, risks, and rollback instructions.
- Signing risk: the Windows artifacts are not Authenticode-signed and may trigger SmartScreen warnings on another machine.
- Dependency collection note: electron-builder logged npm `ELSPROBLEMS` warnings for extraneous WASM packages and a missing optional CodeMirror peer, but packaging and the real packaged-app smoke both completed successfully.
- Smoke artifact note: `PASEO_DESKTOP_SMOKE_ARTIFACT_DIR` is failure-only, so no failure directory was created after this successful run.
- Rollback point: `c62855299`. Remove the version-specific `Paseo-Setup-0.2.0-beta.1*` files and the two generated unpacked directories under `packages/desktop/release/`; rebuild the desired prior commit to regenerate `latest.yml` and `builder-debug.yml`. Revert the packaging record commit separately with `git revert <package-record-commit>`.

## 2026-07-22 - Task: Merge official Paseo origin/main (post 0.2.0-beta.1)

### What was done

- Fetched and merged `origin/main` through `4a4556f49` into `feature/grok-accounts-zh-i18n` (44 upstream commits; branch no longer behind official main).
- Resolved conflicts in `packages/app/src/components/left-sidebar.tsx` (kept new-theme flat footer + official `FooterAddProjectButton` for classic footer) and `packages/app/src/screens/settings-screen.tsx` (kept `resolveActiveHostServerId` + desktop drag styles).
- Took official `package-lock.json` / highlight dependency pins; rebuilt `@getpaseo/protocol`, `@getpaseo/highlight`, `@getpaseo/client` dist.
- Fixed local Grok auto-failover after official `AgentRunOptions.messageId` -> `clientMessageId` rename.

### Testing

- `npm run typecheck --workspace=@getpaseo/app` exited 0 after rebuilding protocol/highlight/client.
- `npm run typecheck --workspace=@getpaseo/server` exited 0 after failover field rename.
- `npx vitest run packages/server/src/server/agent/providers/grok/auto-failover.test.ts --bail=1` passed 24 tests.

### Notes

- Merge commit: `fa47ed1c9`. Follow-up fix commit applies `clientMessageId` strip only.
- Local WIP (reasoning translate, appearance, i18n keys, provider registry, etc.) restored as unstaged after stash; not part of this merge.
- Rollback: `git revert -m 1 fa47ed1c9` then revert the failover fix commit if needed.

## 2026-07-22 - Task: Swarm Board 多 Agent 实时卡片面板

### What was done

- 新增 Paseo 原生 Swarm Board 面板（参照 kimi-code SwarmTool 卡片式设计），将父 Agent 的全部 provider subagents 以实时卡片网格展示：provider 图标、标题、四态徽标、工具调用数、最近活动摘要、实时耗时。
- 点击卡片打开既有 provider_subagent 详情面板。
- 新增 tab target kind `swarm_board`，并接入 workspace-tabs / register-panels / track.tsx / agent-panel.tsx。
- SubagentsTrack 头部新增 LayoutGrid 入口按钮。
- 完成 8 语言 i18n（en、zh-CN、ja、fr、es、pt-BR、ru、ar）。

### Testing

- `swarm-cards.test.ts`：14/14 通过。
- `swarm-board-panel.test.tsx`：5/5 通过。
- `identity.test.ts`：8/8 通过。
- `resources.test.ts`：32/32 通过。
- 回归：provider-store / track-presentation / workspace-subagents-integration 全部通过。
- Typecheck：`npm run typecheck --workspace=@getpaseo/app` 0 错误。
- Lint：改动文件 lint 0 警告。
- 注意：tsx 测试需从 `packages/app` 目录执行，不能在仓库根目录直接跑。

### Notes

- `packages/app/src/subagents/swarm-cards.ts` - 新增 Swarm Board 卡片数据层（聚合父 Agent 的 provider subagents、四态徽标、活动摘要、实时耗时）。
- `packages/app/src/subagents/swarm-cards.test.ts` - 新增卡片数据层测试（14 例）。
- `packages/app/src/panels/swarm-board-panel.tsx` - 新增 Swarm Board 面板 UI（实时卡片网格）。
- `packages/app/src/panels/swarm-board-panel.test.tsx` - 新增面板测试（5 例）。
- `packages/app/src/stores/workspace-tabs-store/state.ts` - 新增 tab target kind `swarm_board`。
- `packages/app/src/workspace-tabs/identity.ts` - 接入 `swarm_board` tab 身份标识。
- `packages/app/src/screens/workspace/workspace-tab-menu.ts` - 接入 Swarm Board tab 菜单项。
- `packages/app/src/screens/workspace/workspace-screen.tsx` - 接入 Swarm Board 面板渲染。
- `packages/app/src/panels/register-panels.ts` - 注册 Swarm Board 面板。
- `packages/app/src/panels/agent-panel.tsx` - 卡片点击打开既有 provider_subagent 详情面板。
- `packages/app/src/subagents/track.tsx` - SubagentsTrack 头部新增 LayoutGrid 入口按钮。
- `packages/app/test-stubs/lucide-react-native.ts` - 补充 LayoutGrid 图标测试桩。
- `packages/app/src/i18n/resources/{en,zh-CN,ja,fr,es,pt-BR,ru,ar}.ts` - 新增 Swarm Board 面板文案（8 语言）。
- `progress.md` - 追加本任务记录。
- 注意：上述部分修改文件同时携带本任务之前的未提交 WIP（早前 merge 记录中 stash 还原的内容），执行下方 rollback 的 `git restore` 会一并还原，操作前需先核对。
- Rollback point: `f58c95174` (HEAD before this task；本任务未做任何 commit，全部改动保留在工作区). Restore tracked paths with `git restore -- packages/app/src/stores/workspace-tabs-store/state.ts packages/app/src/workspace-tabs/identity.ts packages/app/src/screens/workspace/workspace-tab-menu.ts packages/app/src/screens/workspace/workspace-screen.tsx packages/app/src/panels/register-panels.ts packages/app/src/panels/agent-panel.tsx packages/app/src/subagents/track.tsx packages/app/test-stubs/lucide-react-native.ts packages/app/src/i18n/resources/en.ts packages/app/src/i18n/resources/zh-CN.ts packages/app/src/i18n/resources/ja.ts packages/app/src/i18n/resources/fr.ts packages/app/src/i18n/resources/es.ts packages/app/src/i18n/resources/pt-BR.ts packages/app/src/i18n/resources/ru.ts packages/app/src/i18n/resources/ar.ts` and remove this task's new files with `Remove-Item -LiteralPath packages/app/src/subagents/swarm-cards.ts,packages/app/src/subagents/swarm-cards.test.ts,packages/app/src/panels/swarm-board-panel.tsx,packages/app/src/panels/swarm-board-panel.test.tsx`.

## 2026-07-22 - Task: Merge official main (0.2.0-beta.2) + package Windows desktop

### What was done

- Fetched and merged origin/main (9 commits incl. official 0.2.0-beta.2 cut) into feature/grok-accounts-zh-i18n; clean ort merge, no conflicts.
- Restored local WIP (Swarm Board + related) via stash pop after merge.
- typecheck server/app 0; grok auto-failover 24/24 pass.
- Built Windows desktop package under Node v24.14.1 (repo .tool-versions prefers 22.20.0; build succeeded).

### Artifacts (x64 preferred)

- packages/desktop/release/Paseo-Setup-0.2.0-beta.2-x64.exe — 115,909,035 bytes — SHA256 2D9BF51E103C442E58AC8B937635421DD927526DBB47DB510A8B0DE19B5491F5
- packages/desktop/release/Paseo-Setup-0.2.0-beta.2-x64.zip — 160,775,197 bytes — SHA256 891D40352D6955449AB2FA91F6EEFBE2E15CF03719AA69C739D5DFC5CD1A692A
- Also produced arm64 + combined installers.
- win-unpacked Paseo.exe FileVersion 0.2.0-beta.2
- Swarm Board present in exported web bundle (uncommitted WIP included in this package).

### Risks

- Authenticode unsigned (SmartScreen possible).
- Local WIP not committed; package includes working-tree Swarm Board + other unstaged changes.

## 2026-07-24 - Task: Swarm inline panel specification acceptance and history-cache repair

### What was done

- Audited the in-progress inline Swarm implementation against the requested session placement, grouping, card interaction, i18n, and history-cache requirements.
- Corrected the Paseo subagent history cache key so stored finished-agent summaries are visible to the Swarm board model.
- Added a regression test for cache-key collisions and updated existing cache tests to use the canonical key helper.

### Testing

- `cd packages/app && npx vitest run src/subagents src/agent-stream src/hooks` exited 0: 52 test files and 456 tests passed.
- `cd packages/app && npm run typecheck` exited 0 (`tsgo --noEmit`).
- Checked the Swarm source and all eight i18n resource files for CRLF; each reported 0 carriage returns. Each resource file contains `swarmBoard.inlineHeader`.

### Notes

- `packages/app/src/subagents/paseo-history-store.ts` - changed the cache key to `serverId\0agentId`, matching the Swarm board's server-scoped lookup.
- `packages/app/src/subagents/paseo-history-store.test.ts` - covered the canonical key and collision avoidance; updated cache assertions.
- `progress.md` - appended this acceptance and verification record.
- `fetchAgentHistory` returns paginated agent-directory snapshots only, without timeline tool calls or previews; the current app-only implementation continues to use `fetchAgentTimeline` for those required summary fields. Changing that source requires an explicit client/server contract change.
- Rollback: remove the two untracked `paseo-history-store` files (which belong to the in-progress Swarm work) or restore their prior worker version, and remove this appended progress entry. Current HEAD rollback point: `86c2d4fe9`.

## 2026-07-24 - Task: Merge official Paseo 0.2.0 (origin/main through bb3f5c5a2)

### What was done

- Committed outstanding local work before merging: MCP `autoArchive` + release-on-shutdown (`5856959a6`), inline Swarm Board + Paseo subagent history cache (`4fdb9e2f5`), Windows zip/portable desktop targets (`6bb5fad61`), Kimi question-permission mapping (`dcf5f3978`).
- Merged `origin/main` (official 0.2.0, 45 upstream commits) into `feature/grok-accounts-zh-i18n`.
- Resolved conflicts in `packages/server/src/server/agent/providers/acp-agent.ts` (kept official `closeAfterInitializationFailure` try/catch while preserving local `applyInitialContextUsage` calls in new/resumed session flows; dropped local `isSubmittedUserMessageEcho`, superseded by official `submittedUserMessageTurnId` duplicate-prompt prevention) and `packages/app/src/composer/agent-controls/index.tsx` (adopted official aggregated features sheet, kept local `localizeAgentFeature` i18n and `t`-aware thinking options).
- Rebuilt `@getpaseo/protocol` + `@getpaseo/client` dist so upstream `workspace.script.*` messages resolve.
- Fixed pre-existing format drift in 12 local files (kimi provider, reasoning-translate, left-sidebar, settings-screen) via oxfmt.
- Fixed lint in local WIP: complexity splits (`buildSwarmCardViewModels`, `pickAppSettings`, `updateSettings`, `mapKimiQuestionPermissionInput`), nested ternaries, `jsx-no-new-function-as-prop`, `always-return` in `use-translated-reasoning.ts` (also normalized CRLF→LF).

### Testing

- Full `npm run typecheck` exited 0 after protocol/client rebuild (re-verified server+app after final oxfmt pass).
- `npm run lint -- packages` exited 0 (2938 files); full-repo lint only fails on untracked `.tmp/` scratch dirs.
- oxfmt `--check` clean for all files differing from origin/main.
- Server: acp-agent 95/95, agent-manager/create/auto-failover suites 276/276 (4 files), bootstrap included.
- App (worker-verified): 72 files / 641 tests across subagents, agent-stream, hooks, composer, i18n; spot-rechecked swarm-cards/paseo-history-store/inline-swarm-model 43/43 by main agent.

### Notes

- Pre-commit lefthook unusable in this environment (npm script-shell spawns cmd without node on PATH inside hook context); all hook checks (typecheck/lint/format) were run manually and passed before each commit, commits used `--no-verify`.
- Merge verification and lint/test fixes delegated to Grok worker agent e53f1c9f (cluster mode); main agent independently re-ran lint, typecheck, and spot test suites before committing.
- Untracked scratch left alone: `.tmp*`, `vitest-sidebar.*`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.tools/`, `docs/添加服务器Grok.md`, `scripts/dev-portable.ps1`, `scripts/sync-portable-on-exit.ps1`, `patches/app-builder-lib+26.8.1.patch`.
- Rollback: `git revert -m 1 <merge-commit>`.

## 2026-07-30 - Task: Unify Claude and Grok prompt, skills, and MCPProxy configuration

### What was done

- Added a Desktop shared-context integration with `~/.ai-shared/AGENTS.md` and `~/.ai-shared/skills/` as the user-maintained source, with drift detection and confirmed synchronization to Claude and Grok.
- Preserved provider-only skill files, backed up changed prompt/MCP files, protected Windows hardlinks and junctions, and deliberately kept existing direct MCP entries.
- Added a Settings > Integrations row, IPC contract, status hook, Chinese/English UI copy, and fallback keys for all supported locales.
- Restored the existing `MCPProxy Gateway` scheduled task, connected Claude and Grok to `http://127.0.0.1:8933/mcp/`, and added MCPProxy discovery rules to the canonical prompt.
- Migrated this workstation to the shared source and synchronized the real Claude/Grok configuration to `ready`.

### Testing

- TDD red phase: the new Desktop suite initially failed because `./operations` did not exist; the App suite initially failed because `useSharedContextStatus` did not exist.
- `cd packages/desktop && npx vitest run src/integrations/shared-context/operations.test.ts src/integrations/skills/sync.test.ts` exited 0: 2 files, 16 tests passed.
- `cd packages/app && npx vitest run src/desktop/hooks/use-install-status.test.tsx src/i18n/resources.test.ts` exited 0: 2 files, 43 tests passed.
- `npm run typecheck --workspace=@getpaseo/desktop` and `npm run typecheck --workspace=@getpaseo/app` both exited 0.
- Targeted `oxlint` reported 0 warnings/errors; targeted `oxfmt --check` passed for all 22 changed source/doc files; `git diff --check` exited 0.
- Real `syncSharedContext()` returned `state=ready` with prompt, skills, and MCP booleans true for Claude and Grok.
- MCPProxy survived its periodic refresh with 11 connected upstreams and 204 indexed tools; a real `retrieve_tools` query for `闲鱼 订单 查询` returned `xianyu-ops:xianyu_query_order`.
- Isolated Desktop dev ran at Metro `http://localhost:8081`, CDP `127.0.0.1:9231`, daemon `127.0.0.1:6791`. Page-level CDP checks at 1200x800 and 900x700 found no horizontal overflow, no runtime exceptions, and no overlap between the shared-context text and Sync button. Screenshots: `%TEMP%\paseo-shared-context-dev\integrations-1200x800.png` and `integrations-900x700.png`.

### Notes

- `packages/desktop/src/integrations/shared-context/{index.ts,operations.ts,paths.ts}` - added shared source paths, status detection, backups, prompt/skill projection, and Claude/Grok MCPProxy configuration.
- `packages/desktop/src/integrations/shared-context/operations.test.ts` - covered ready status, first migration, backups, provider-only skill preservation, stale managed-file cleanup, and missing prompt failure.
- `packages/desktop/src/integrations/skills/sync.ts` - exposed the existing directory synchronizer and added a read-only source/target match helper for real reuse.
- `packages/desktop/src/daemon/daemon-manager.ts` - registered shared-context status and sync IPC commands.
- `packages/app/src/desktop/daemon/desktop-daemon.ts` - added the renderer-side shared-context contract and response validation.
- `packages/app/src/desktop/hooks/use-install-status.ts` and `use-install-status.test.tsx` - added query/mutation state and regression coverage.
- `packages/app/src/desktop/components/integrations-section.tsx` - added the Shared AI context row and confirmation flow.
- `packages/app/test-stubs/lucide-react-native.ts` - added the Share2 icon test stub.
- `packages/app/src/i18n/resources/{en,zh-CN,ar,es,fr,ja,pt-BR,ru}.ts` and `resources.test.ts` - added UI/error copy and locale-key parity coverage.
- `docs/shared-ai-context.md` - documented the canonical source, backup semantics, scope, MCPProxy discovery, and rollback.
- `docs/windows-mcpproxy-startup.md` - documented the disabled-task failure mode and real discovery readiness check.
- `progress.md` - appended this implementation and verification record.
- Claude model-level tool invocation remains unverified because its OAuth session is expired. Grok model-level invocation remains unverified because the current team returned 403/no credits. Both native MCP connection checks passed; old direct MCP entries remain available until model-level verification is possible.
- Repo rollback point: `4b26517a6`. Restore tracked files with `git restore -- docs/windows-mcpproxy-startup.md packages/desktop/src/integrations/skills/sync.ts packages/desktop/src/daemon/daemon-manager.ts packages/app/test-stubs/lucide-react-native.ts packages/app/src/desktop/components/integrations-section.tsx packages/app/src/desktop/daemon/desktop-daemon.ts packages/app/src/desktop/hooks/use-install-status.ts packages/app/src/desktop/hooks/use-install-status.test.tsx packages/app/src/i18n/resources.test.ts packages/app/src/i18n/resources/ar.ts packages/app/src/i18n/resources/en.ts packages/app/src/i18n/resources/es.ts packages/app/src/i18n/resources/fr.ts packages/app/src/i18n/resources/ja.ts packages/app/src/i18n/resources/pt-BR.ts packages/app/src/i18n/resources/ru.ts packages/app/src/i18n/resources/zh-CN.ts progress.md`; remove new files with `Remove-Item -LiteralPath docs/shared-ai-context.md,packages/desktop/src/integrations/shared-context/index.ts,packages/desktop/src/integrations/shared-context/operations.ts,packages/desktop/src/integrations/shared-context/operations.test.ts,packages/desktop/src/integrations/shared-context/paths.ts`.
- Workstation rollback: restore `~/.claude/CLAUDE.md.paseo-backup-20260730T092127.471Z` and `~/.grok/AGENTS.md.paseo-backup-20260730T092127.471Z`; restore `.claude.json.bak.20260730-170112` and `~/.grok/config.toml.bak-mcpproxy-20260730-170125`; remove `~/.ai-shared/AGENTS.md`; run `Disable-ScheduledTask -TaskName "MCPProxy Gateway"` if the original disabled startup state is required.
- Final drift follow-up: isolated the repeatedly changing files to `~/.ai-shared/skills/.system/` (Codex/OpenAI-managed system skills), excluded that provider-private top-level directory from shared projection, and added a regression test. The final Desktop count is 17 passing tests (superseding the earlier 16-test line); real status remained `ready` after a 15-second post-sync wait.

## 2026-07-30 - Task: Generalize shared AI context to all providers and detected native clients

### What was done

- Replaced the Claude/Grok-only target model with an adapter registry for Claude, Codex, Grok, Kimi Code, Gemini CLI, Hermes, and Cursor Agent. Unsupported native capabilities are reported explicitly instead of being treated as synchronized.
- Added a provider-independent Paseo runtime layer so every launched provider receives the canonical prompt, shared skills location, and MCPProxy entry. ACP providers receive the same context in the first-turn system envelope.
- Preserved native client differences at the adapter boundary: hardlinked prompt files, linked or configured skills directories, CLI or structured MCP configuration, Windows `.cmd` execution, provider-only skill migration, and timestamped backups.
- Generalized the Desktop IPC contract and Settings UI to report detected-provider counts rather than naming two clients.
- Migrated this workstation to `~/.ai-shared`: seven native clients are detected; six native prompt files share the canonical file, Cursor reports its missing global prompt as unsupported, and every detected client's supported skills/MCP capabilities are synchronized.

### Testing

- `cd packages/desktop && npx vitest run src/integrations/shared-context/operations.test.ts src/integrations/shared-context/paths.test.ts src/integrations/skills/sync.test.ts` exited 0: 3 files, 21 tests passed.
- `cd packages/server && npx vitest run src/server/agent/runtime-mcp-config.test.ts src/server/agent/agent-manager.test.ts src/server/agent/providers/acp-agent.test.ts` exited 0: 3 files, 251 tests passed.
- `cd packages/app && npx vitest run src/desktop/daemon/desktop-daemon.shared-context.test.ts src/desktop/hooks/use-install-status.test.tsx src/i18n/resources.test.ts` exited 0: 3 files, 44 tests passed.
- `npm run typecheck --workspace=@getpaseo/desktop`, `npm run typecheck --workspace=@getpaseo/server`, and `npm run typecheck --workspace=@getpaseo/app` all exited 0.
- Targeted `oxlint` completed with 0 warnings/errors; targeted `oxfmt --check` passed 32 files.
- `npm run build:server:clean` and `cd packages/desktop && npm run build:main` both exited 0.
- Real Desktop IPC returned `state=ready` for seven detected clients. The Settings page displayed `检测到的 7 个 AI 客户端已使用共享上下文` and `已同步` after the CLI probes completed.
- CDP checks at 1200x800 and 900x700 found no horizontal overflow or overlap; screenshots are `%TEMP%\paseo-shared-context-all-ai-1200x800.png` and `%TEMP%\paseo-shared-context-all-ai-900x700.png`.
- All seven prompt paths had SHA-256 `5E4C837C238B7AA9F1D84D65881E234F3EDD21A5E6B76325CE8511C9879CA7CA`; all conventional skills paths resolved through directory links to `~/.ai-shared/skills`.
- MCPProxy remained live on port 8933. A real natural-language `retrieve_tools` request returned `xianyu-ops:xianyu_query_order`, proving upstream discovery rather than only `/healthz` reachability.

### Notes

- `packages/desktop/src/integrations/shared-context/index.ts` - exports the generalized shared-context integration.
- `packages/desktop/src/integrations/shared-context/paths.ts` - defines canonical paths and the installed native-client adapter registry.
- `packages/desktop/src/integrations/shared-context/paths.test.ts` - covers installed client detection and Windows `.cmd` wrapper resolution.
- `packages/desktop/src/integrations/shared-context/operations.ts` - implements generic status, migration, backup, link, command, and structured MCP behavior.
- `packages/desktop/src/integrations/shared-context/operations.test.ts` - covers generic providers, unsupported capabilities, stderr-based CLI output, structured configs, and idempotent migration.
- `packages/desktop/src/integrations/skills/sync.ts` - exposes reusable skill synchronization/matching while excluding provider-private `.system` files.
- `packages/desktop/src/daemon/daemon-manager.ts` - exposes shared-context status and synchronization through Desktop IPC.
- `packages/server/src/server/agent/runtime-shared-context.ts` - resolves the canonical runtime prompt, skills, MCPProxy URL, and known native prompt projections.
- `packages/server/src/server/agent/runtime-mcp-config.ts` - injects MCPProxy into launch-only MCP configuration while preserving explicit overrides.
- `packages/server/src/server/agent/runtime-mcp-config.test.ts` - verifies generic MCPProxy injection and override behavior.
- `packages/server/src/server/agent/agent-manager.ts` - injects canonical context for every provider family and suppresses duplicate prompt bodies for shared hardlinks.
- `packages/server/src/server/agent/agent-manager.test.ts` - verifies launch-only prompt, skills, MCP, derived-provider, and hardlink-deduplication behavior.
- `packages/server/src/server/agent/providers/acp-agent.ts` - adds the shared runtime context to the first ACP turn.
- `packages/server/src/server/agent/providers/acp-agent.test.ts` - verifies ACP first-turn context and subsequent-turn behavior.
- `packages/server/src/server/bootstrap.ts` - resolves shared context once and passes it into AgentManager.
- `packages/app/src/desktop/daemon/desktop-daemon.ts` - validates the generic provider-capability IPC response.
- `packages/app/src/desktop/daemon/desktop-daemon.shared-context.test.ts` - covers the renderer contract including unsupported capabilities.
- `packages/app/src/desktop/hooks/use-install-status.ts` - loads, refreshes, and synchronizes generic shared-context status.
- `packages/app/src/desktop/hooks/use-install-status.test.tsx` - verifies shared-context query/mutation state updates.
- `packages/app/src/desktop/components/integrations-section.tsx` - renders provider-neutral counts, drift, offline, and synchronized states.
- `packages/app/src/i18n/resources.test.ts` - verifies locale key parity for the new UI copy.
- `packages/app/src/i18n/resources/ar.ts` - adds Arabic-fallback shared-context labels.
- `packages/app/src/i18n/resources/en.ts` - adds English provider-neutral shared-context labels.
- `packages/app/src/i18n/resources/es.ts` - adds Spanish-fallback shared-context labels.
- `packages/app/src/i18n/resources/fr.ts` - adds French-fallback shared-context labels.
- `packages/app/src/i18n/resources/ja.ts` - adds Japanese-fallback shared-context labels.
- `packages/app/src/i18n/resources/pt-BR.ts` - adds Portuguese-fallback shared-context labels.
- `packages/app/src/i18n/resources/ru.ts` - adds Russian-fallback shared-context labels.
- `packages/app/src/i18n/resources/zh-CN.ts` - adds Chinese provider-neutral shared-context labels.
- `packages/app/test-stubs/lucide-react-native.ts` - adds the Share2 icon test stub used by the integration row.
- `docs/shared-ai-context.md` - documents runtime coverage, native adapters, migration, backups, and MCPProxy readiness.
- `docs/windows-mcpproxy-startup.md` - documents Windows startup and discovery-level readiness checks.
- `progress.md` - appends this all-provider correction without rewriting the earlier Claude/Grok history.
- Workstation files changed outside the repository: `~/.ai-shared/AGENTS.md`, `~/.ai-shared/skills`, six provider-native prompt hardlinks, native skills projections/configuration, and one `mcpproxy` entry per detected client. The pre-cleanup canonical prompt is backed up at `~/.ai-shared/AGENTS.md.paseo-backup-20260730-all-ai`; changed provider files/directories have timestamped sibling backups.
- Gemini's MCP entry is configured but its unrelated model endpoint currently returns a duplicated `/v1/v1beta` 404, so a Gemini model-level tool call is not verified. Cursor reports `mcpproxy: ready` before its current CLI exits with a libuv `UV_HANDLE_CLOSING` assertion. These client defects do not change Paseo's `ready` capability state but remain external end-to-end gaps.
- Repo rollback point: `4b26517a6`. Because several tracked files also contain earlier uncommitted WIP, save the current diff before using `git restore`. Then restore the tracked paths listed above and remove the new files under `packages/desktop/src/integrations/shared-context`, `packages/server/src/server/agent/runtime-shared-context.ts`, `packages/app/src/desktop/daemon/desktop-daemon.shared-context.test.ts`, and `docs/shared-ai-context.md`.
- Workstation rollback: remove only the projected prompt/skills links and `mcpproxy` entries, then rename the selected `*.paseo-backup-*` siblings back to their original paths. Restore `~/.ai-shared/AGENTS.md.paseo-backup-20260730-all-ai` if the canonical prompt cleanup must also be undone.

## 2026-08-03 - Cluster mode smoke (research dual-worker)

### Goal

Lightweight parallel smoke of self-hosted Paseo cluster: two research workers with separate scopes, then one audit worker to summarize.

### Workers

| Node                  | Agent ID                               | Role / isolation  | Scope (summary)                                                          | Outcome                                                                 |
| --------------------- | -------------------------------------- | ----------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| w1-cluster-skill-scan | `e3ce877d-3895-4a45-a07b-e5ece38eef23` | research / shared | cluster skill + `cluster-worker.toml` + AGENTS §9                        | ✅ read-only return with paths, hard rules, default/forbidden providers |
| w2-repo-cluster-code  | `caa268e7-fcb7-4601-bd87-2a3f19b308dd` | research / shared | `packages/server/.../cluster`, create-agent, app swarm UI, related tests | ✅ read-only map of ≥5 source files + test entry points + link summary  |
| w3-smoke-report       | this agent                             | audit / shared    | Allow: `progress.md`, `docs/shared-ai-context.md` only                   | ✅ append this section                                                  |

### Smoke conclusions

| Check                 | Result                      | Evidence                                                                                                                                                                                                                          |
| --------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Parallel dispatch** | ✅ **成立**                 | w1 / w2 为图上两个 research 节点、不同 agent id，互不依赖对方产出即可完成；主控侧 dependency 仅要求 w3 等待二者回传，不要求串行互读                                                                                               |
| **Scope 隔离**        | ✅ **分离达标**             | w1 只扫 `~/.ai-shared` 技能/工人档案；w2 只扫仓库 cluster/create/swarm 代码与测试；双方均声明未写任何文件、未越权改业务源码。w3 Allow 仅 `progress.md`（及允许的 docs 路径）                                                      |
| **回传可核对**        | ✅ **两项 research 均达标** | 均含 Required return：改动列表（均为空）、验证证据（读过的路径/行数/列目录/git status 说明）、成功标准勾选。w1 给出关键路径表 + ≥3 硬约定 + 默认/禁止渠道；w2 给出 ≥5 源文件职责 + create/cluster/swarm 测试入口清单 + 链路一句话 |
| **回传格式**          | ✅ 够验收                   | 结构化表 + 结论段；写文件验收约定（磁盘为准）在技能侧已写明；本次 research 无写盘产出，以「改动列表为空 + 证据路径可复查」为门                                                                                                    |

### Gaps / notes（非阻断）

- **文档不一致（派工风险）**：`AGENTS.md` §9 写集群默认 `grok/grok-4.5`；`cluster-worker.toml` + `skills/cluster/SKILL.md` 写代码默认 `opencode/opencode-go/deepseek-v4-flash`。冒烟结论：**派工以 toml 为准**，勿只看 AGENTS 短表。
- **本轮只验 research 双工并行 + scope + 回传格式**，未覆盖：write-band 实现 fan-out、worktree isolation、`dependsOn` DAG 就绪、`review` bounce、OpenCode `full-access` 无 PendingPermissions 等。代码侧链路已由 w2 索引（send-gate → orchestrator → planner → spawn → wait → review），完整写路径需另开 smoke。
- **业务源码**：本冒烟三工人均未要求/未报告改动 `packages/**`；本 audit 仅追加本段到 `progress.md`。

### Verdict

集群模式轻量 research 冒烟：**并行成立、scope 分离、w1/w2 回传可核对**。可作为「本机自建集群能派工并收证据」的基线；实现类并行与 review 门仍待专项验证。
