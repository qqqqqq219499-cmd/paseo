# Shared AI context

Paseo uses one user-maintained source for AI instructions and skills:

- prompt: `~/.ai-shared/AGENTS.md`;
- skills: `~/.ai-shared/skills/`;
- MCP gateway: `http://127.0.0.1:8933/mcp/`.

Use **Settings > Integrations > Shared AI context** to inspect detected clients and run a
confirmed migration. The status is adapter-based; it is not limited to two named providers.

## Paseo sessions

Every agent launched by Paseo receives the canonical prompt at runtime. Direct providers use
their native system/developer instruction field. ACP providers receive the same content in a
`<paseo-system>` block on the first turn because ACP has no portable system-prompt field.
When a provider already loads a native prompt hardlinked to the canonical file, AgentManager
detects the shared file identity and omits the duplicate runtime body.

Paseo also exposes the canonical skills path through `PASEO_SHARED_SKILLS_DIR` and names it in
the runtime instructions. Providers with native skill discovery additionally use the client
projections below.

The `mcpproxy` HTTP server is added to every launch config without being persisted into an
agent's stored config. An explicit per-agent `mcpproxy` override wins. Providers that do not
advertise MCP support ignore the MCP entry but still receive the shared prompt and skills path.

## Native client adapters

Desktop detects installed clients before changing anything. The current adapters are:

| Client       | Prompt                              | Skills                               | MCPProxy                    |
| ------------ | ----------------------------------- | ------------------------------------ | --------------------------- |
| Claude       | `~/.claude/CLAUDE.md` hardlink      | `~/.claude/skills` directory link    | Claude CLI                  |
| Codex        | `~/.codex/AGENTS.md` hardlink       | `~/.codex/skills` directory link     | Codex CLI                   |
| Grok         | `~/.grok/AGENTS.md` hardlink        | `~/.grok/skills` directory link      | Grok CLI                    |
| Kimi Code    | `~/.kimi-code/AGENTS.md` hardlink   | `~/.kimi-code/skills` directory link | structured `mcp.json` merge |
| Gemini CLI   | `~/.gemini/GEMINI.md` hardlink      | standard `~/.agents/skills` link     | Gemini CLI, user scope      |
| Hermes       | `$HERMES_HOME/AGENTS.md` hardlink   | native `skills.external_dirs`        | structured `config set`     |
| Cursor Agent | no stable native global prompt file | standard `~/.agents/skills` link     | structured `mcp.json` merge |

Cursor's missing native global prompt is reported as `unsupported`, not as successful. Cursor
agents launched inside Paseo still receive the runtime prompt.

The adapter registry is the compatibility boundary for native clients. New Paseo providers do
not need an adapter to receive runtime prompt/MCP configuration; a new adapter is needed only
when an independently launched client has its own global files or CLI syntax.

## Migration behavior

If the canonical prompt is absent, Paseo seeds it from the first detected client prompt. After
that, provider prompt files become hardlinks to the canonical file, so editing any linked name
updates the same underlying file.

Skills use directory links where the client supports a conventional directory. Before replacing
an existing directory, Paseo copies provider-only top-level skills into the canonical directory,
renames the old directory to a timestamped backup, and then creates the link. Hermes keeps its
bundled skill directory and reads the canonical directory through `skills.external_dirs`.

The top-level `.system/` directory is never migrated from a provider directory. It is maintained
independently by host runtimes and would expose host-specific internal skills to other clients.

Each native client receives exactly one entry named `mcpproxy`. All upstream MCP servers remain
owned by MCPProxy. Existing client MCP entries are preserved.

## Backups and rollback

Changed prompt and config files get a sibling `*.paseo-backup-<UTC timestamp>`. Replaced skill
directories are renamed with the same suffix. The migration is idempotent: linked prompts,
linked skill directories, and existing MCPProxy entries are skipped on later runs.

To roll back one client, remove its linked prompt/skill path and restore the selected sibling
backup. Remove the `mcpproxy` entry with that client's MCP CLI. Kimi and Cursor store the entry
under `mcpServers.mcpproxy` in JSON; remove only that key with a structured JSON editor. This does
not change MCPProxy's upstream configuration or another client's projection.

## MCPProxy readiness

`/healthz` proves only that the gateway process is listening. A useful readiness check must also
confirm that upstream servers are connected and that `retrieve_tools` returns an expected tool.

Search with a natural-language task description. Do not apply restrictive annotation filters
while diagnosing legacy local MCP servers: absent annotations are interpreted conservatively and
can hide every tool even when the transport is healthy. Follow the returned `call_with` value and
use the exact server/tool identity.

See [windows-mcpproxy-startup.md](./windows-mcpproxy-startup.md) for workstation startup and
process verification.
