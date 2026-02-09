# @elizaos/client-reddit

Production-ready Reddit client for ElizaOS with:
- autonomous posting loop,
- autonomous interactions loop,
- persistent queue/state for idempotency,
- OAuth2 auth,
- Reddit-aware rate-limit + backoff behavior,
- dry-run and read-only safety modes.

This package is designed to mirror the architecture style used by other Eliza clients (`client-twitter`, `client-farcaster`, `client-moltbot`) while adapting to Reddit’s API model.

## Table of Contents

1. Purpose and scope
2. Package structure
3. Runtime wiring and activation
4. Dependencies
5. Authentication and OAuth2 model
6. Rate limit and retry model
7. Posting system
8. Interactions system
9. Persistence/state model
10. Quotas and scheduling behavior
11. Environment variables
12. Character configuration
13. Build and run
14. Debugging and observability
15. Operational playbook
16. Troubleshooting
17. Security notes
18. Known limitations and future extensions

## 1) Purpose and scope

`@elizaos/client-reddit` allows an Eliza agent to:
- publish Reddit self posts to configured target subreddits,
- poll for replies/mentions/comments and respond automatically,
- preserve state across restarts to avoid duplicate actions,
- behave safely under Reddit API limits and feature-scope restrictions.

Primary goals:
- autonomous operation (no manual trigger required),
- idempotency and resilience,
- safe defaults for production deployment.

## 2) Package structure

```text
packages/client-reddit/
  package.json
  tsconfig.json
  tsup.config.ts
  README.md
  src/
    index.ts
    environment.ts
    base.ts
    post.ts
    interactions.ts
    templates.ts
    types.ts
    utils.ts
    plugins/
      postJSON/
        postedState.json
        postQueueState.json
        deadLetterState.json
      interactionJSON/
        interactionState.json
```

### File responsibilities

- `src/index.ts`
  - entrypoint exposing `RedditClientInterface` with `start(runtime)`.
  - constructs manager (`base + post + interactions`).

- `src/environment.ts`
  - reads runtime settings / env values.
  - validates and normalizes configuration.
  - computes resolved User-Agent.

- `src/base.ts`
  - API transport layer.
  - OAuth token lifecycle.
  - request pacing, retries, backoff, rate-header awareness.
  - endpoint wrappers for `me`, inbox, user posts/comments, submit, comment, vote.

- `src/post.ts`
  - post loop, queue draining, quota checks, dedupe logic.
  - dead-letter handling for permanently failing items.

- `src/interactions.ts`
  - interactions polling loop.
  - candidate collection from multiple sources.
  - context building and AI response generation.
  - dedupe/watermarks/cooldowns.

- `src/utils.ts`
  - JSON file helpers, hashing, path resolution, spam/bot heuristics.

- `src/types.ts`
  - queue/state/domain types.

- `src/templates.ts`
  - prompt templates for should-respond/reply/autonomous post generation.

## 3) Runtime wiring and activation

### Core enum
`Clients.REDDIT = "reddit"` is required in core types so character validation accepts the client.

### Agent startup wiring
In agent initialization, Reddit is started only when the character includes `reddit` in `clients`.

Current behavior:
- dynamic import in startup block (lazy load),
- if package is missing/unavailable, startup logs error without hard-crashing the whole runtime.

### Activation rules
Reddit client runs only when both are true:
1. Character has `"reddit"` in `clients`.
2. `REDDIT_ENABLED=true`.

## 4) Dependencies

Runtime dependencies:
- `@elizaos/core`
- `zod`

No Reddit SDK is used; HTTP fetch is used directly to keep full control over request behavior and headers.

Build tooling:
- `tsup`
- TypeScript project config from workspace conventions.

## 5) Authentication and OAuth2 model

### Supported flows
1. Preferred: refresh token flow
   - uses `REDDIT_REFRESH_TOKEN` with `grant_type=refresh_token`.
2. Optional fallback: password grant
   - uses `REDDIT_USERNAME` + `REDDIT_PASSWORD` with `grant_type=password`.

### Endpoints
- token: `https://www.reddit.com/api/v1/access_token`
- API base: `https://oauth.reddit.com`
- identity check: `GET /api/v1/me`

### Token lifecycle
- access token cached in-memory with expiry margin.
- auto-refresh on expiry.
- 401 triggers token cache reset and retry.

### User-Agent
Reddit requires descriptive User-Agent.
Effective value is:
- explicit `REDDIT_USER_AGENT`, or
- default: `elizaos:client-reddit:<version> (by /u/<username>)`.

## 6) Rate limit and retry model

### Request pacing
- global pace from `REDDIT_RPM` via min-gap scheduler.
- each request waits for pacer turn.

### Header-aware slowdown
Reads if present:
- `x-ratelimit-remaining`
- `x-ratelimit-reset`

When remaining is low, pace auto-slows to avoid spikes near reset windows.

### Retry policy
- retries on `429` and `5xx` (bounded attempts).
- exponential backoff using:
  - `REDDIT_BACKOFF_BASE_MS`
  - `REDDIT_BACKOFF_MAX_MS`
- `Retry-After` is honored when provided.

### Capability degradation on missing scope
If endpoint returns scope/insufficient-style errors, affected capability is disabled with one WARN:
- inbox (`privatemessages`),
- submit (`submit`),
- comment (`read+submit`),
- vote (`vote`),
- history (`history`).

## 7) Posting system

### Post targets
Configured by:
- `REDDIT_SUBREDDITS_NEWS`
- `REDDIT_SUBREDDITS_TRADES`
- fallback: `REDDIT_DEFAULT_SUBREDDIT`

### Queue model
Persistent queue file:
- `data/reddit/post-queue.json`

Queue item shape (simplified):
```json
{
  "id": "reddit:...",
  "type": "news|trade",
  "target": "subreddit",
  "content": {
    "title": "...",
    "body": "...",
    "imageUrl": "optional"
  },
  "approved": true,
  "priority": 0,
  "retries": 0,
  "createdAt": 0
}
```

### Publish path
- chooses next item by priority + age.
- enforces trade approval gate when `REDDIT_REQUIRE_TRADE_APPROVAL=true`.
- dedupe by deterministic content hash + target.
- posts as Reddit `self` post via `/api/submit`.

### Autonomous generation
When backlog is low, post loop can generate content via model template and enqueue it.

### Dead-letter behavior
On repeated hard failures (`REDDIT_MAX_QUEUE_RETRIES`), item moves to:
- `data/reddit/dead-letter.json`

This prevents infinite poison-message retries.

## 8) Interactions system

### Interaction sources
1. Inbox polling (`/message/inbox`) for replies/mentions.
2. My submissions/comments scans (`/user/{username}/submitted`, `/comments`).
3. Thread permalink comment scans (`<permalink>.json`) for watched own threads.
4. Optional watched-subreddit comment scan.

### Candidate processing
Each candidate is normalized and filtered:
- skip deleted authors,
- skip likely bots,
- skip likely spam,
- skip self-authored content.

### Response decision
For each candidate:
1. Build thread context (parent chain where available).
2. Run `generateShouldRespond` template.
3. If `RESPOND`, run `generateMessageResponse` template.
4. Post reply via `/api/comment`.

Optional:
- upvote if enabled and score threshold met.

### Cooldowns/anti-loop controls
- global reply per-day limit (`REDDIT_REPLIES_PER_DAY`),
- min interval between replies (`REDDIT_REPLY_MIN_INTERVAL_SEC`),
- per-user cooldown (`REDDIT_USER_COOLDOWN_MINUTES`).

## 9) Persistence/state model

### Runtime state files
All runtime state lives under runtime data dir (`data/reddit` by default):
- `post-queue.json`
- `dead-letter.json`
- `posted-state.json`
- `interactions-state.json`

### `posted-state.json`
Stores:
- `lastPostTime`,
- `lastPostedHash`,
- rolling recent post hashes,
- per-kind daily post timestamps,
- posted thing IDs.

### `interactions-state.json`
Stores:
- `lastSeenInboxThingId` watermark,
- `lastSeenCommentTimestampByThread`,
- processed thing IDs + timestamps,
- per-user cooldown map,
- reply timestamps,
- watched thread permalinks.

### Idempotency behavior
- duplicate post content hash is skipped.
- already-processed interaction thing IDs are skipped.
- deferred interactions (quota/cooldown) are not marked processed, allowing later retry.

## 10) Quotas and scheduling behavior

Posting quotas:
- `REDDIT_POSTS_PER_DAY_NEWS`
- `REDDIT_POSTS_PER_DAY_TRADES`
- `REDDIT_POST_MIN_INTERVAL_SEC`
- `REDDIT_POST_POLL_INTERVAL_SEC`

Interaction quotas:
- `REDDIT_REPLIES_PER_DAY`
- `REDDIT_REPLY_MIN_INTERVAL_SEC`
- `REDDIT_USER_COOLDOWN_MINUTES`
- `REDDIT_INTERACTION_POLL_INTERVAL_SEC`

Queue/backlog controls:
- `REDDIT_MAX_QUEUE_SIZE`
- `REDDIT_MAX_QUEUE_RETRIES`
- `REDDIT_MAX_PROCESSED_IDS`

Behavioral principle:
- quotas are soft-operational constraints; backlog is retained and drained safely over time.

## 11) Environment variables

Quick start:
- use `packages/client-reddit/.env.example.partial` as minimal copy/paste block.

### Required minimum
- `REDDIT_CLIENT_ID`
- `REDDIT_USERNAME`
- auth mode:
  - `REDDIT_REFRESH_TOKEN` (recommended), or
  - `REDDIT_PASSWORD` (fallback)

### Strongly recommended
- `REDDIT_CLIENT_SECRET`
- `REDDIT_USER_AGENT`

### Feature toggles
- `REDDIT_ENABLED`
- `REDDIT_ENABLE_POSTS`
- `REDDIT_ENABLE_INTERACTIONS`
- `REDDIT_DRY_RUN`
- `REDDIT_READ_ONLY`
- `REDDIT_DEBUG_AUTH`

### Targeting
- `REDDIT_SUBREDDITS_NEWS`
- `REDDIT_SUBREDDITS_TRADES`
- `REDDIT_DEFAULT_SUBREDDIT`
- `REDDIT_WATCHED_SUBREDDITS`

### Rate/Retry
- `REDDIT_RPM`
- `REDDIT_BACKOFF_BASE_MS`
- `REDDIT_BACKOFF_MAX_MS`

### Optional voting
- `REDDIT_ENABLE_UPVOTE`
- `REDDIT_UPVOTE_MIN_SCORE`

## 12) Character configuration

Enable via character file:

```json
{
  "clients": ["reddit"]
}
```

Optional per-character secret override (if your runtime supports it):

```json
{
  "settings": {
    "secrets": {
      "REDDIT_ENABLE_POSTS": "true",
      "REDDIT_ENABLE_INTERACTIONS": "true",
      "REDDIT_DRY_RUN": "false",
      "REDDIT_READ_ONLY": "false"
    }
  }
}
```

## 13) Build and run

From workspace root:

```bash
pnpm -C packages/client-reddit build
pnpm -C agent check-types
pnpm start dev --character="characters/<name>.character.json"
```

## 14) Debugging and observability

Use:
- `REDDIT_DEBUG_AUTH=true` to print resolved account identity (`/api/v1/me`) without logging secrets.
- `REDDIT_DRY_RUN=true` to exercise loops without write-side effects.
- `REDDIT_READ_ONLY=true` for strict no-write operation.

Log prefixes include `[Reddit]` to keep cross-client logs easy to grep.

## 15) Operational playbook

Recommended rollout:
1. Start with `REDDIT_DRY_RUN=true` and low poll frequencies.
2. Validate auth + inbox reads + thread scans.
3. Enable posting to low-risk test subreddit.
4. Set conservative quotas and observe.
5. Increase cadence only after stable run and mod compliance.

## 16) Troubleshooting

### `Cannot find package '@elizaos/client-reddit'`
- Ensure dependency exists in `agent/package.json`.
- Run workspace install and build.
- If using ts-node startup, prefer lazy import in agent startup block.

### `401` / token failure
- invalid/revoked refresh token,
- incorrect client id/secret,
- password grant credentials invalid.

### `403` on inbox/submit/comment
- missing API scope,
- subreddit restrictions,
- account trust/karma limits,
- feature auto-disables for some scope failures by design.

### `429`
- reduce `REDDIT_RPM`,
- increase poll interval,
- reduce per-day quotas,
- monitor backlog and dead-letter growth.

### No interactions replied
Check in order:
1. `REDDIT_ENABLE_INTERACTIONS=true`
2. character includes `reddit`
3. inbox/history scopes present
4. candidate filters/cooldowns not over-restrictive
5. `interactions-state.json` watermarks and processed IDs

## 17) Security notes

- Never log tokens/secrets.
- Use dedicated bot account.
- Keep subreddit lists explicit to avoid accidental posting scope.
- Prefer refresh token over password grant in production.
- Treat `.env` as sensitive; do not commit real credentials.

## 18) Known limitations and future extensions

Current limitations:
- Media upload is URL-in-body style for MVP (no native Reddit media upload flow here).
- Scope-granular diagnostics can be expanded further.
- Cross-thread deep context is intentionally bounded for safety/latency.

Potential extensions:
- native Reddit media upload pipeline,
- stricter per-subreddit policy templates,
- semantic thread relevance scoring,
- richer dead-letter replay tooling.

---

## Quick checklist

- [ ] `clients` includes `reddit`
- [ ] OAuth creds configured
- [ ] User-Agent configured
- [ ] target subreddits set
- [ ] dry-run tested
- [ ] posting enabled
- [ ] interaction quotas tuned
- [ ] mod/subreddit policy validated
