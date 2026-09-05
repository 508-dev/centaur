# discordbot

Discord chat ingress for the Centaur agent. Mirrors `slackbotv2` (streamed, session-backed
replies to `@`-mentions) using Vercel's Chat SDK Discord adapter. The session logic is a
deliberate clone of `services/slackbotv2` kept in sync manually (there is no shared package).
Authenticated actor policy is carried through `api-rs` and reconciled onto a user-scoped
iron-control principal; it is never attached to the channel principal.

## Behavior

- **`@`-mention in a channel** → the adapter creates a **public thread from that message**, the
  bot streams the answer inside it, and the thread is renamed to the message text. The session is
  keyed by the new thread (`discord:{guild}:{channel}:{threadId}`).
- **`@`-mention inside an existing thread** → the bot answers in that thread.
- **Follow-ups inside an authorized thread** append to the same session without a re-mention
  only for the original actor, while the root TTL and their current role policy remain valid. An
  unmentioned reply with a canonical `<@user-id>` / `<@!user-id>` mention of another member is
  ignored instead of steering Centaur; a direct Centaur mention keeps its normal behavior even if
  another member is also named.
- **`@centaur stop`** interrupts only the active execution attached to that authorized thread.
- **`@centaur approve sha256:…`** atomically consumes one exact, unexpired workflow proposal
  when the actor's reviewed role is permitted to approve it. It does not create a coding session.
- **Safe public output**: a run instantly reacts 👀 on the triggering message. The **final
  answer** streams into a separate message created when its first text arrives, so it lands at the
  bottom of the thread even when users chime in mid-run. On settle the 👀 flips to ✅ (or ❌).
  Reasoning, commentary, activity summaries, task/tool details, and transcripts are never posted
  to Discord.

## Ingress model

Discord delivers normal messages over a **Gateway WebSocket** (outbound), not HTTP webhooks. The
bot opens a single long-lived Gateway connection in "direct mode" (`startGatewayListener` with a
large duration; discord.js maintains the session with native RESUME). There is **no public
event ingress** — only `GET /health` plus an authenticated internal workflow-delivery endpoint.
The ready Gateway identity must exactly match `DISCORD_APPLICATION_ID`; forwarded JSON from the
Chat SDK's in-process emulator is not accepted in production. Each message ID is durably claimed
and audited before thread, session, workflow, or sandbox side effects.

> ⚠️ **Run exactly one replica.** Two pods on the same bot token open two Gateway sessions and
> every message is handled twice. Deploy with `replicas: 1` + `strategy: Recreate`, never autoscale.

> ⚠️ **Do not proxy the Gateway.** discord.js ignores `HTTPS_PROXY` for the WebSocket. Give the pod
> direct `:443` egress to Discord and exclude Discord hosts via `NO_PROXY`.

## Environment

| Var | Required | Notes |
|-----|----------|-------|
| `DISCORD_BOT_TOKEN` | ✅ | Bot token (account-level credential — keep secret). |
| `DISCORD_PUBLIC_KEY` | ✅ | Ed25519 public key required by the adapter constructor. Centaur does not expose Discord HTTP interactions. |
| `DISCORD_APPLICATION_ID` | ✅ | Doubles as the bot user id for mention detection. |
| `DISCORDBOT_GUILD_ALLOWLIST` | ✅ to do anything | Comma/space-separated guild IDs. **Fail-closed when empty.** |
| `DISCORDBOT_CHANNEL_ALLOWLIST` | ✅ to do anything | Comma/space-separated parent channel IDs. Messages in other channels and their threads are ignored before a thread/session is created. |
| `DISCORDBOT_ROLE_BINDINGS_JSON` | ✅ to do anything | Non-empty reviewed JSON array mapping immutable numeric role IDs to one capability class, policy-managed principal role, exact repository/project scopes, explicit priority, and optional `can_approve`. Unknown or ambiguous combinations fail closed. |
| `DISCORDBOT_API_KEY` | ✅ | Dedicated bearer used for Discordbot → api-rs and api-rs → Discordbot internal calls. Do not reuse another ingress key. |
| `CENTAUR_API_URL` | – | api-rs base URL (default `http://127.0.0.1:8080`). |
| `DISCORDBOT_DATABASE_URL` / `DATABASE_URL` / `POSTGRES_URL` | ✅ | Thread-state store. The bot refuses to boot without one (no silent localhost fallback). |
| `DISCORDBOT_MAX_CONCURRENT_EXECUTIONS_PER_GUILD` | – | In-flight execution cap per guild (default 3). Over the cap, the triggering message gets a 🚦 reaction and is kept as context only. |
| `DISCORDBOT_CONTINUATION_TTL_MS` | – | Maximum lifetime of an authorized root interaction (default 24h). A new authorized mention is required after expiry. |
| `DISCORDBOT_INGRESS_MAX_EVENT_AGE_MS` | – | Maximum accepted Gateway event age (default 5m). Future/stale events fail closed. |
| `DISCORDBOT_INGRESS_DELIVERY_TTL_MS` | – | Durable inbound delivery/audit dedupe retention (default 7d). |
| `DISCORDBOT_ACTIVE_EXECUTION_TTL_MS` | – | Staleness TTL for the per-thread active-execution flag (default 30 min) — unwedges threads after a crash mid-handoff. |
| `DISCORDBOT_ANSWER_EDIT_INTERVAL_MS` | – | Edit cadence for the streamed answer message (default 1500 ms, clamped to ≥1500 to respect Discord rate limits). |
| `DISCORD_MENTION_ROLE_IDS` | – | Role mentions that also trigger the bot. |
| `DISCORDBOT_NAME_THREADS` | – | Set `false` to keep the adapter's generic thread names. |
| `DISCORDBOT_USER_NAME` | – | Bot display name used for mention parsing/thread naming (default `centaur`; the chart sets it from `discordbot.userName`). |
| `DISCORDBOT_STATE_KEY_PREFIX` | – | Prefix for rows in the Postgres thread-state store (default `centaur-discordbot`). |
| `DISCORD_API_URL` | – | Override Discord API base. |
| `PORT` | – | Health server port (default 3001). |
| `SESSION_IDLE_TIMEOUT_MS` / `SESSION_MAX_DURATION_MS` | – | Forwarded to api-rs execute. |

DM, private-message, bot, self, and webhook-authored events are denied. The adapter requests only
Guilds, GuildMessages, and Message Content intents. Guild, parent channel, current role policy,
actor, thread, and TTL checks happen before a channel mention creates a public thread and again
before every follow-up. Removing a role therefore blocks the member's next message, including
replies inside an already-active thread. Every allow/deny decision is logged with a stable reason
code and immutable IDs, never message content.

Example role policy:

```json
[
  {
    "role_id": "100000000000000001",
    "capability_class": "github:observe",
    "principal_role": "discord-observer",
    "can_approve": false,
    "priority": 10,
    "repository_scope": ["example-org/example-repo"],
    "project_scope": []
  }
]
```

Multiple held roles do not form an implicit union: the highest explicit priority wins, while
equal-priority non-identical bundles are denied. Repository wildcards and mutable role names are
invalid configuration.

## Discord application setup

1. **Create the application** at <https://discord.com/developers/applications>. Note the
   **Application ID** and **Public Key** (General Information).
2. **Bot** tab → reveal/reset the **token** (`DISCORD_BOT_TOKEN`).
3. **Bot → Privileged Gateway Intents** → enable **Message Content Intent**. Without it,
   non-mention messages arrive with empty content and follow-ups break. (Bots in 100+ servers must
   apply for it; below that it's a toggle.)
4. **Invite the bot** (OAuth2 → URL Generator) with scope `bot` and permissions:
   _View Channels_, _Send Messages_, _Send Messages in Threads_, **Create Public Threads**,
   _Embed Links_, _Read Message History_, _Add Reactions_ (the 👀/✅ run-status indicator).
5. Set `DISCORDBOT_GUILD_ALLOWLIST`, `DISCORDBOT_CHANNEL_ALLOWLIST`, and
   `DISCORDBOT_ROLE_BINDINGS_JSON` with numeric IDs. The bot is **inert** for human messages until
   all three are set. Use Discord's role API or Developer Mode during deployment to translate role
   names to IDs; review and pin the resulting IDs rather than checking mutable names at runtime.

## Runtime assumptions (validated 2026-06-02)

A throwaway spike confirmed the three things the static build couldn't prove: discord.js's Gateway
runs under Bun, a Gateway `MESSAGE_CREATE` dispatches in-process to `chat.onNewMention`, and a
channel mention auto-creates a thread that the bot streams into. An `@`-mention produced a threaded
reply end-to-end. The spike has served its purpose and been removed.

## Develop / test

```bash
bun run check:types   # tsgo
bun test test         # allowlist, threading, gateway controller (no Discord needed)
bun run dev           # run the server locally (needs env above)
```

## Known limitations

- The Gateway listener can't expose the precise close code on a fatal end; an unexpected
  disconnect exits the process so Kubernetes restarts it (CrashLoopBackOff surfaces bad
  token/intents). `/health` liveness is "listener still running", not a deep socket probe.
- Concurrency is `'drop'`: the per-thread lock serializes handling so two near-simultaneous mentions
  can't double-execute. The tradeoff is that a follow-up sent *while a stream is still running* is
  dropped rather than appended mid-stream; send it again once the reply finishes.
- Thread renaming is best-effort, applies on the first execution, and only touches threads the
  bot created from a channel mention (`isThreadCreatedForMessage`); a mention inside a
  user-created thread never renames it (set `DISCORDBOT_NAME_THREADS=false` to disable renaming
  entirely).
- Exact actor binding intentionally prevents a different participant from continuing an
  authorized shared thread. A future collaborative mode needs an explicit reviewed delegation
  policy; it must not infer authority from thread membership.
