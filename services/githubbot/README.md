# githubbot

GitHub ingress for the Centaur agent. Mirrors `linearbot` (session-backed replies) in a
**comment-thread model**: a GitHub PR or issue comment thread maps to one centaur sandbox/context,
and the bot answers *in the thread* with a comment. It's built on the official
[`@chat-adapter/github`](https://www.npmjs.com/package/@chat-adapter/github) chat-SDK adapter, so
the session logic (`session-api.ts`) and rendering are the same as the other bots; the Rust `api-rs`
control plane is unchanged (`github:…` thread keys flow through identically).

The bot authenticates as either a preferred GitHub App installation or a dedicated
machine-user PAT. Both identities can be `@`-mentioned. PAT accounts can also be assigned and
requested as reviewers; App deployments use the explicit `centaur-managed` ownership label because
Apps cannot be assignees or requested reviewers.

## Behavior

- **`@`-mentioning the bot in an issue or PR comment** (Conversation tab) or a **PR review comment**
  (Files changed tab) → the bot answers in that thread, keyed `github:{owner}/{repo}:{prNumber}`
  (PR/issue level) or `github:{owner}/{repo}:{prNumber}:rc:{commentId}` (a review-comment thread) —
  one thread === one sandbox/context stack. For a **review-comment thread** the file path, line, and
  diff hunk it's anchored to are injected into the turn so the agent knows exactly what it's looking
  at; for a **PR conversation thread** the agent is pointed at `gh pr view`/`gh pr diff` to fetch the
  PR itself. A 👀 reaction acks the triggering comment while the bot works, settling to 🚀 / 😕. The
  reply is one comment: the answer with the chain-of-thought folded into a collapsed `<details>`
  section. Mention detection is the adapter's (matches the bot account's `@username`). Only authors
  whose GitHub `author_association` is allowed (default `OWNER` / `MEMBER` / `COLLABORATOR`) can drive
  a turn — the agent runs in a write-capable sandbox and posts its transcript back, so untrusted
  commenters can't steer it. Widen or open it with `GITHUBBOT_ALLOWED_AUTHOR_ASSOCIATIONS` (`*` allows
  everyone, e.g. a fully-private repo). Every path also requires an exact match in
  `GITHUBBOT_REPOSITORY_ALLOWLIST`; lifecycle triggers (ownership handoff, review-request) are gated by the
  same repository boundary plus GitHub permissions.
- **`@`-mentioning the bot in the body of a newly-opened issue or PR** (the description, not a
  comment) → the same conversational turn runs, keyed to that issue/PR thread, with the reply posted
  as a comment. Only the `opened` event is handled — an edit that adds a mention later won't
  re-trigger, so re-issue it as a comment. Same author gate as the comment path.
- **Plain comments in a thread the bot is already active in** (no mention) are appended to that
  thread's session as append-only context — no execution, no reply — so a follow-up like "actually,
  hold off" is seen by the next turn. The bot's own comments are skipped (loop guard) and inactive
  threads are ignored.
- **Requesting the PAT teammate bot's review on a PR** (`pull_request` / `review_requested`
  targeting the bot account — or a **team the bot belongs to**, whose membership is checked and
  briefly cached) → a review turn runs on a **dedicated, isolated session thread**
  (`github-review:{owner}/{repo}:{prNumber}`) — kept separate from the PR conversation so reviews
  never share a sandbox with chit-chat, but persistent per PR so a re-request builds on the prior
  review. The chat adapter only surfaces comment threads, so this lifecycle event is handled
  directly: githubbot verifies the webhook signature itself, and the agent reviews the PR in its
  sandbox, posting inline comments + a summary via `gh`. The **review methodology** is a bundled,
  standalone default (`src/review-prompt.ts`) — good and reliable with zero config — that a
  deployment can **fully replace** via `GITHUBBOT_REVIEW_PROMPT` / `GITHUBBOT_REVIEW_PROMPT_FILE`
  (the override is used verbatim, so org conventions supersede ours wholesale; for Splits this is
  where the overlay supplies its review guide). Webhook redeliveries are de-duplicated by delivery id.
- **Handing an issue to the bot** (assigning the PAT account, or applying the configured ownership
  label in App or PAT mode) → an autonomous work
  turn runs on a **dedicated, isolated session thread** (`github-issue:{owner}/{repo}:{n}`): the agent
  reads the issue, implements a fix in its sandbox, and opens a PR carrying the same ownership label
  so it then manages that PR toward merge. Like reviews, this lifecycle event is handled directly (githubbot
  verifies the signature) and de-duplicated by delivery id. The **issue-work methodology** is a
  bundled, standalone default (`src/issue-prompt.ts`) that a deployment can **fully replace** via
  `GITHUBBOT_ISSUE_PROMPT` / `GITHUBBOT_ISSUE_PROMPT_FILE` (used verbatim, like the review prompt).
- **Per-turn context**: every turn prepends a compact header naming the PR/issue so a recycled
  sandbox always knows which subject to act on and where to reply.
- `--claude` / `--codex` / `--amp` / `--provider …` / `--model …` / `--opus|--sonnet|--haiku` inline flags pick the
  harness/model, same as the other bots.

## PR self-management (v2)

For PRs the bot **owns**—authored by its exact actor login, assigned to its PAT account, or carrying
the configured ownership label—githubbot drives the PR toward merge by reacting to lifecycle
webhooks. Remove the ownership label (and PAT assignment, if present) to hand a human-authored PR
back. It only ever acts on owned PRs, and on a dedicated management thread
(`github-manage:{owner}/{repo}:{n}`); the agent does its GitHub writes via `gh`.

- **Take over on handoff.** Assignment or application of the ownership label is an explicit signal,
  so the bot
  immediately evaluates CI (fixing red or merging green) rather than waiting for the next lifecycle
  event.
- **Fix CI.** When **all** checks for a head SHA are settled (not per failing job — interwoven jobs
  make early firing harmful) and red, a fix turn diagnoses and pushes a fix. Bounded to
  `GITHUBBOT_CI_FIX_MAX_ATTEMPTS` consecutive attempts (default 3, reset when CI goes green); on
  exhaustion the bot comments tagging a human and stops. On the steady-state CI path it backs off if
  the failing head commit was authored by a human (it won't step on someone mid-edit) — except right
  after an explicit handoff, when it fixes the PR regardless of who
  pushed last.
- **Address review.** A submitted review (`changes_requested` / `commented`) triggers one holistic
  turn that reads all the feedback, validates each finding against reachable code
  and enforced contracts, makes one minimal coherent commit, replies on each thread, resolves what
  it addressed, and re-requests review only when code changed. The controller fingerprints each
  normalized finding independently of reviewer identity and retains machine-readable accepted or
  evidence-rejected dispositions. A decided fingerprint is not re-opened by another bot or a moved
  line; a still-pending finding remains actionable. Inline dispositions are accepted only from the
  bot's reply to the original comment and must bind the original review ID. A rejection also needs
  a concrete `Centaur-Finding-Evidence` line. An acceptance is persisted only after GitHub proves
  the head advanced, the finding's exact path changed, and a complete descendant commit range
  contains that finding's `Centaur-Review-Finding` trailer. Incomplete or capped comparisons fail
  closed. Review authors
  must currently be an owner, organization member, or repository collaborator. Reviewer bots whose
  GitHub association is `NONE` require an exact login in `GITHUBBOT_REVIEW_AUTHOR_ALLOWLIST`;
  wildcards are rejected.
- **Bound review loops.** Each reviewer is limited to three rounds per epoch by default: the first
  broad review plus two repair-validation rounds. Reviewer budgets use the stable GitHub user ID
  when available (with a normalized-login fallback), so one review bot cannot consume another's
  allowance. The epoch also has a six-round aggregate cap, so adding reviewers cannot create an
  unbounded side channel. Repeated reviews of the same head consume both counters.
  For a new head, githubbot compares the change since the last reviewed head. New runtime behavior,
  meaningful runtime diff growth, dependency/build changes, migrations, authorization/data/API
  boundaries, and CI/deployment changes are a new risk surface. Formatting-only changes,
  tree-identical rebases, generated/docs/test-only diffs, and bounded repairs explicitly linked to
  an accepted finding stay in the current epoch. Non-linear or unreadable comparisons pause instead
  of guessing. A new-risk human-authored change starts a fresh epoch until the PR-wide epoch cap;
  automated changes consume the current epoch and cannot award themselves a reset by widening the
  diff. The accepted/rejected ledger survives epoch transitions. Admitting the final allowed round
  records the handoff pause before its repair
  turn starts. Once exhausted, auto-merge remains paused across descendant heads until a reviewed,
  authorized transition clears the handoff; an already-running repair cannot push around the pause.
  Only while that handoff pause is active, a non-bot collaborator with write/admin
  permission can continue by adding the
  `centaur-review-reset` label and re-requesting review. The approval is pinned to the current head,
  stored without expiry, consumed in the same durable write that advances the epoch, and invalidated
  with its label when the head changes. Transient permission checks and consumed-label removals stay
  in the retained lifecycle path and retry; permanent permission failures still fail closed. Rejected
  reset labels are also removed so a later authorized human can retry the documented flow. Create
  that label in each managed repository before use. An approval-only reset may merge even when a
  round cap is one; unlike a commented or changes-requested review, it does not start a repair turn
  that needs a final-round handoff. Handoff notices are keyed to the original paused head, so a
  descendant review retries a failed notice without duplicating one that already succeeded.
  Approved repair heads are recorded under the same per-PR lock even when draft, CI, or a hold
  prevents immediate merge, preserving the correct authorship boundary for the next review. Active
  handoff pauses are stored without expiry; ordinary in-progress budget state retains its 90-day TTL.
  One new inline P0/security finding may interrupt an exhausted budget by default, without resetting
  an epoch. The interrupt requires exact `Centaur-Severity`, `Impact`, and `Evidence` fields plus a
  concrete path and line/diff hunk, is keyed by the finding fingerprint, and leaves the PR paused
  after that one repair turn. Ordinary severity prose cannot trigger it.
- **Merge when ready.** Deterministic — no agent. When GitHub reports the PR `mergeable_state == clean`
  the bot merges it (`GITHUBBOT_MERGE_METHOD`, default squash) and deletes the branch. `dirty` →
  conflict-resolution turn; `behind` → branch update; anything else → wait. Enabled by default for
  owned PRs; disable globally with `GITHUBBOT_AUTO_MERGE=false`, or per-PR with the hold label
  (`GITHUBBOT_HOLD_LABEL`, default `do-not-merge`) or by keeping the PR a draft.
- **Owned-PR conversation.** An @-mention in an owned PR's conversation (or a review-comment thread)
  runs in that PR's management session too — so the bot answers with the context of the CI fixes and
  review work it's been doing on the PR — while the rendered reply still posts to the comment thread.
  An @-mention in the conversation of an **issue owned by the bot** likewise runs in that issue's
  work session (`github-issue:…`), so the bot replies with the context of the work it's doing on it.

> **Scope.** v2 targets **same-repo PRs on repos you control** (where you own the webhook). The
> fork → upstream contribution flow (e.g. PRs against `paradigmxyz/centaur`) is out of scope: it
> needs the upstream repo to deliver webhooks to this bot, which isn't yours to configure.
>
> **Op requirement:** the agent's sandbox `git`/`gh` identity must be able to push to the managed
> PR branches (ideally authenticated as the bot account, so commits and replies come from it).

## Ingress model

GitHub delivers **HTTP webhooks** to `POST /api/webhooks/github` (content type **must** be
`application/json`). Githubbot first verifies the `X-Hub-Signature-256` HMAC over the raw body,
then parses the body and applies the exact repository allowlist before dispatching supported
events. Allowed comment events (`issue_comment`, `pull_request_review_comment`) are then handed to
the chat adapter, which repeats signature verification and maps them to thread/message events.
Lifecycle events (`pull_request`, `pull_request_review`, `issues`, and the CI events) are handled by
githubbot directly (the adapter ignores them). Turns run in the background — webhooks are
acknowledged immediately (cold sandbox spin-up far exceeds GitHub's webhook deadline), with a
bounded retry inside the turn for transient cold-start failures. On `SIGTERM` (a deploy/rollout)
the bot stops accepting webhooks and **drains in-flight turns** for up to
`GITHUBBOT_SHUTDOWN_DRAIN_MS` before exiting, so
running work isn't dropped (claims are taken before the work, so a dropped turn would never retry).
It also **serializes turns targeting the same session** so two turns can't interleave git/push in one
sandbox. Both require the **single replica** the chart enforces (`replicaCount: 1`); increase sandbox
runner and warm-pool capacity for concurrent work instead of scaling this webhook controller.
Review delivery claims and accepted review-state reads, writes, and handoff claims that encounter a
transient state-store error remain in process and retry with capped backoff; they are included in
the same shutdown drain rather than being treated as completed work.

## Auth

Use exactly one controller identity:

- Preferred for production: a fixed GitHub App installation. Set
  `GITHUB_APP_CLIENT_ID`, `GITHUB_INSTALLATION_ID`, and either
  `GITHUB_PRIVATE_KEY_FILE` or `GITHUB_PRIVATE_KEY`. The Client ID is passed as
  the JWT issuer, and Octokit transparently mints and refreshes short-lived
  installation tokens. The chart mounts the PEM from a dedicated Secret rather
  than placing it in an environment variable.
- Compatibility mode: a personal access token for a bot teammate account in
  `GITHUB_TOKEN`. Keep it distinct from any repo-cache or sandbox token.

Do not configure both modes. The bot fails startup on missing, partial, or mixed
credentials. In App mode, `GITHUB_BOT_USERNAME` is the mention slug and the
controller separately recognizes the event actor as `slug[bot]` (override with
`GITHUB_BOT_ACTOR_LOGIN` only when needed). Because Apps are not normal user
accounts, assignment and requested-review flows require a teammate PAT. App
deployments use `GITHUBBOT_OWNERSHIP_LABEL` for explicit PR/issue handoff, and
App-authored PRs are owned automatically.

Webhook events to subscribe: **Issue comments**, **Pull request review comments**, **Issues**, **Pull
requests**, **Pull request reviews**, **Check runs**, **Check suites**, and **Workflow runs**
(**Issues** drives assignment/ownership-label issue work; the last four drive v2 PR self-management).

## Environment

| Var | Required | Notes |
|-----|----------|-------|
| `GITHUB_TOKEN` | one auth mode | PAT for the bot's teammate account. |
| `GITHUB_APP_CLIENT_ID` | one auth mode | Recommended GitHub App JWT issuer (legacy `GITHUB_APP_ID` is accepted). |
| `GITHUB_INSTALLATION_ID` | App mode | Fixed positive installation ID. |
| `GITHUB_PRIVATE_KEY_FILE` | App mode | Preferred path to a mounted PEM; mutually exclusive with `GITHUB_PRIVATE_KEY`. |
| `GITHUB_PRIVATE_KEY` | App mode | Inline PEM compatibility input. |
| `GITHUB_WEBHOOK_SECRET` | ✅ | Webhook signing secret (or `GITHUBBOT_WEBHOOK_SECRET`). |
| `GITHUB_BOT_USERNAME` | ✅ | Mention name used by the bot. For an App, use its slug without the `[bot]` suffix; for a teammate PAT, use the account login (or `GITHUBBOT_USER_NAME`). |
| `GITHUB_BOT_ACTOR_LOGIN` | — | Exact login on bot-authored events. Defaults to `GITHUB_BOT_USERNAME[bot]` in App mode and `GITHUB_BOT_USERNAME` in PAT mode. |
| `GITHUBBOT_DATABASE_URL` | ✅ | Postgres for chat-SDK state (falls back to `DATABASE_URL` / `POSTGRES_URL`). |
| `GITHUBBOT_REPOSITORY_ALLOWLIST` | ✅ | Comma-separated exact `owner/repository` names. Empty/unset is rejected at startup; wildcards are not supported. Signed events for other repositories are acknowledged but ignored before chat state or agent work is created. |
| `CENTAUR_API_URL` | — | api-rs control plane, default `http://127.0.0.1:8080`. |
| `GITHUBBOT_API_KEY` | — | Dedicated bearer sent to api-rs. |
| `GITHUBBOT_DEFAULT_HARNESS` | — | Harness for new threads without an inline flag, default `codex`. |
| `GITHUBBOT_REVIEW_PROMPT` | — | Full review methodology, inline. Replaces the bundled default verbatim. |
| `GITHUBBOT_REVIEW_PROMPT_FILE` | — | Path to a file holding the review methodology (e.g. an overlay-mounted file). Used when the inline var is unset. |
| `GITHUBBOT_ISSUE_PROMPT` | — | Full issue-work methodology, inline. Replaces the bundled default verbatim. |
| `GITHUBBOT_ISSUE_PROMPT_FILE` | — | Path to a file holding the issue-work methodology (e.g. an overlay-mounted file). Used when the inline var is unset. |
| `GITHUBBOT_MANAGEMENT_PROMPT` | — | Extra guidance prepended to owned-PR management turns (CI-fix / conflict / address-review), inline. The per-action preamble still rides underneath. |
| `GITHUBBOT_MANAGEMENT_PROMPT_FILE` | — | Path to a file holding the management guidance (e.g. an overlay-mounted file). Used when the inline var is unset. |
| `GITHUBBOT_ALLOWED_AUTHOR_ASSOCIATIONS` | — | Comma-separated `author_association` values allowed to drive the comment path. Default `OWNER,MEMBER,COLLABORATOR`; `*` allows everyone. |
| `GITHUB_API_URL` | — | Override the GitHub REST base URL (GitHub Enterprise). |
| `GITHUBBOT_USER_ID` | — | Bot's numeric user id for self-message detection (auto-detected otherwise). |
| `GITHUBBOT_STATE_KEY_PREFIX` | — | Chat-SDK state key prefix, default `centaur-githubbot`. |
| `GITHUBBOT_LOG_LEVEL` | — | `debug`/`info`/`warn`/`error`, default `info`. |
| `GITHUBBOT_AUTO_MERGE` | — | Auto-merge owned PRs when mergeable. Default `true`. |
| `GITHUBBOT_MERGE_METHOD` | — | `merge` / `squash` / `rebase`. Default `squash`. |
| `GITHUBBOT_OWNERSHIP_LABEL` | — | Exact App-compatible PR/issue handoff label. Default `centaur-managed`; must differ from the review-reset label. |
| `GITHUBBOT_HOLD_LABEL` | — | Label that pauses auto-merge. Default `do-not-merge`. |
| `GITHUBBOT_CI_FIX_MAX_ATTEMPTS` | — | Consecutive CI-fix attempts before escalating. Default 3. |
| `GITHUBBOT_REVIEW_MAX_ROUNDS_PER_EPOCH` | — | Review heads handled per reviewer within one epoch. Default 3 (initial review plus two validations). |
| `GITHUBBOT_REVIEW_MAX_TOTAL_ROUNDS_PER_EPOCH` | — | Aggregate review heads handled across all reviewers in one epoch. Default 6. |
| `GITHUBBOT_REVIEW_MAX_EPOCHS` | — | Material human-change epochs before explicit continuation is required. Default 3. |
| `GITHUBBOT_REVIEW_MAX_SECURITY_INTERRUPTS_PER_PR` | — | Evidence-backed inline P0/security findings allowed to interrupt an exhausted or inconclusive PR-wide budget without resetting an epoch. Default 1; hard maximum 16. |
| `GITHUBBOT_REVIEW_MATERIAL_CHANGE_LINES` | — | Changed runtime lines since the last reviewed head that start a new epoch for a human change. Default 200. |
| `GITHUBBOT_REVIEW_MATERIAL_CHANGE_FILES` | — | Changed runtime files since the last reviewed head that start a new epoch for a human change. Default 8. |
| `GITHUBBOT_REVIEW_AUTHOR_ALLOWLIST` | — | Comma-separated exact GitHub logins for trusted reviewer bots whose `author_association` is `NONE`. Empty by default; wildcards are rejected. Collaborator/organization/owner reviews are allowed without listing. |
| `GITHUBBOT_REVIEW_RESET_LABEL` | — | One-shot, write-authorized human continuation label. Default `centaur-review-reset`. |
| `GITHUBBOT_WORKFLOW_EVENTS` | — | Emit settled CI and submitted-review events to durable workflows. Default `false`. |
| `GITHUBBOT_DELETE_BRANCH_ON_MERGE` | — | Delete head branch after merge. Default `true`. |
| `GITHUBBOT_ESCALATION_HANDLE` | — | Fallback @handle (no leading @) tagged when the bot gives up. |
| `SESSION_IDLE_TIMEOUT_MS` / `SESSION_MAX_DURATION_MS` | — | Forwarded to api-rs executes. |
| `GITHUBBOT_SHUTDOWN_DRAIN_MS` | — | How long to let in-flight turns finish on `SIGTERM` before exiting. Default `25000`; the chart derives it from the pod's termination grace period. |

The chart checksum includes the mounted private-key Secret's live resource
version. Rotate the Secret through the same Helm reconcile used for deployment;
the resulting pod-template change restarts githubbot, which reads the PEM once
at process startup. Do not edit the Secret out of band without reconciling the
release.

## Tests

`bun test test` — unit tests for the override flag parser, the GitHub thread-key parsing / context
preamble, the review-request trigger gating (incl. team requests), the issue-ownership handoff, the
v2 PR-manager decision logic (CI evaluation, actor/label/assignment ownership, merge gating, the CI-fix
counter / escalation, and the merge-claim release-on-failure), the author-association gate, body
mentions, and the per-session serialization queue.
