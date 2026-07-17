# Grok provider adapters

The built-in `grok` provider runs Grok Build over the generic ACP transport. Provider-specific
behavior stays under `packages/server/src/server/agent/providers/grok/`; the shared ACP session
only exposes narrow hooks and context-usage state.

## Composer thinking controls

Grok's ACP model metadata can advertise only part of the effort ladder. Paseo merges the Grok CLI
`/effort` values (`xhigh`, `high`, `medium`, `low`) into reasoning-capable models before the
generic ACP catalog is converted to composer controls.

- `grok/reasoning-efforts.ts` owns the Grok effort ladder and model metadata transformation.
- `grok/acp-agent.ts` composes reasoning and permission-mode transformations.
- Switching between reasoning-capable ACP models carries the selected effort when supported and
  otherwise uses the target model's current/default effort.
- Models that do not advertise reasoning support remain unchanged.

## Context window usage

The composer context ring receives Grok usage through three inputs:

1. Standard ACP `usage_update` events are mapped in `acp-context-usage.ts` for every ACP provider.
2. Grok notification-level `_meta.totalTokens` is parsed by `grok/session-context.ts`. The current
   explicit window size wins; otherwise Grok's CLI default of 500,000 tokens is used.
3. When a Grok session is created or resumed, `grok/session-context.ts` can seed usage from
   `$GROK_HOME/sessions/<cwd-key>/<sessionId>/signals.json`.

`ACPAgentSession` merges these updates, suppresses duplicate occupancy events, replays seeded usage
to new subscribers, and carries the latest used/max values into turn completion. No new WebSocket
protocol fields are needed; the existing `AgentUsage` and `usage_updated` event are used.

The Grok quota-failover wrapper subscribes to the ACP session before the agent manager does. It
caches the latest `usage_updated` payload and replays it to later subscribers so initial disk usage
is not lost at that wrapper boundary.

## Module boundary

| Module                                | Responsibility                                                        |
| ------------------------------------- | --------------------------------------------------------------------- |
| `providers/acp-context-usage.ts`      | Standard ACP mapping, validation, merge/dedup, and resolver interface |
| `providers/acp-model-thinking.ts`     | ACP model-metadata effort parsing and model-switch resolution         |
| `providers/acp-agent.ts`              | Resolver lifecycle hook and normalized usage event delivery           |
| `providers/generic-acp-agent.ts`      | Pass optional provider resolvers into the shared ACP client           |
| `providers/grok/auto-failover.ts`     | Preserve usage events across the Grok account wrapper                 |
| `providers/grok/reasoning-efforts.ts` | Grok CLI thinking ladder                                              |
| `providers/grok/session-context.ts`   | Grok `_meta` and `signals.json` formats                               |
| `providers/grok/acp-agent.ts`         | Grok-only adapter composition                                         |

Keep Grok constants, disk paths, and vendor metadata out of `acp-agent.ts`. A future provider with a
non-standard context source should implement its own `ACPContextUsageResolver`.
