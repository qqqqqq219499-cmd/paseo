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
