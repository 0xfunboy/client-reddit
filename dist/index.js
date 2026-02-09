import { parseBooleanFromText, elizaLogger, stringToUuid, composeContext, generateText, ModelClass, parseJSONObjectFromText, getEmbeddingZeroVector, generateShouldRespond, generateMessageResponse, shouldRespondFooter, messageCompletionFooter } from '@elizaos/core';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { z, ZodError } from 'zod';

// src/index.ts
var __filename = fileURLToPath(import.meta.url);
path.dirname(__filename);
function nowMs() {
  return Date.now();
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function jitterMs(baseMs, ratio = 0.35) {
  const jitter = Math.floor(baseMs * ratio * Math.random());
  return baseMs + jitter;
}
function sha256(input) {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}
function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}
function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      ensureDirForFile(filePath);
      fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2), "utf8");
      return fallback;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    elizaLogger.warn(`[Reddit] failed reading JSON ${filePath}; using fallback`, error);
    return fallback;
  }
}
function writeJsonFile(filePath, value) {
  ensureDirForFile(filePath);
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
}
function resolveRuntimeDataDir(runtime) {
  const explicit = runtime.getSetting("REDDIT_DATA_DIR") || process.env.REDDIT_DATA_DIR;
  if (explicit) return explicit;
  const cwd = process.cwd();
  const agentDataFromRoot = path.resolve(cwd, "agent", "data");
  if (fs.existsSync(agentDataFromRoot)) return path.join(agentDataFromRoot, "reddit");
  const localData = path.resolve(cwd, "data");
  return path.join(localData, "reddit");
}
function normalizeSubreddit(value) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.replace(/^r\//i, "").replace(/\s+/g, "");
}
function toDisplaySubreddit(value) {
  const normalized = normalizeSubreddit(value);
  return normalized ? `r/${normalized}` : "";
}
function isLikelySpam(text) {
  const lower = text.toLowerCase();
  if (lower.length < 6) return true;
  if (/https?:\/\//.test(lower) && lower.split(/https?:\/\//).length > 3) return true;
  if (/(buy now|airdrop|promo code|discount|free money)/i.test(lower)) return true;
  return false;
}
function isLikelyBot(author) {
  const lower = author.toLowerCase();
  return lower.endsWith("bot") || lower.includes("automoderator");
}
function truncate(text, maxLen) {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 3)).trimEnd()}...`;
}

// src/base.ts
var RequestPacer = class {
  constructor(rpm) {
    this.nextAllowedAt = 0;
    this.minGapMs = Math.max(250, Math.floor(6e4 / Math.max(1, rpm)));
  }
  async waitTurn() {
    const now = Date.now();
    if (this.nextAllowedAt > now) {
      await sleep(this.nextAllowedAt - now);
    }
    this.nextAllowedAt = Math.max(Date.now(), this.nextAllowedAt) + this.minGapMs;
  }
  slowdownForHeader(remaining, resetSec) {
    if (!Number.isFinite(remaining) || !Number.isFinite(resetSec)) return;
    if (remaining > 10) return;
    const perRequestMs = Math.ceil(Math.max(1, resetSec) * 1e3 / Math.max(1, remaining));
    this.nextAllowedAt = Math.max(this.nextAllowedAt, Date.now() + perRequestMs);
  }
  applyRetryAfter(delayMs) {
    this.nextAllowedAt = Math.max(this.nextAllowedAt, Date.now() + Math.max(500, delayMs));
  }
};
var RedditApiError = class extends Error {
  constructor(message, status, data, retryAfterMs) {
    super(message);
    this.name = "RedditApiError";
    this.status = status;
    this.data = data;
    this.retryAfterMs = retryAfterMs;
  }
};
function parseRetryAfterMs(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return Math.floor(seconds * 1e3);
  const epochMs = Date.parse(value);
  if (!Number.isNaN(epochMs)) return Math.max(0, epochMs - Date.now());
  return 0;
}
function asListing(value) {
  if (!value || value.kind !== "Listing") {
    throw new Error("Unexpected Reddit listing response shape");
  }
  return value;
}
var RedditClient = class {
  constructor(runtime, config) {
    this.tokenCache = null;
    this.tokenPromise = null;
    this.warnedScopes = /* @__PURE__ */ new Set();
    this.capabilityEnabled = {
      inbox: true,
      submit: true,
      comment: true,
      vote: false,
      history: true
    };
    this.profile = null;
    this.runtime = runtime;
    this.config = config;
    this.pacer = new RequestPacer(config.REDDIT_RPM);
    this.capabilityEnabled.vote = config.REDDIT_ENABLE_UPVOTE;
  }
  async init() {
    if (this.config.REDDIT_READ_ONLY) {
      elizaLogger.warn("[Reddit] REDDIT_READ_ONLY=true; posting/replies/upvotes disabled");
    }
    if (this.config.REDDIT_DRY_RUN) {
      elizaLogger.warn("[Reddit] REDDIT_DRY_RUN=true; write actions will be logged only");
    }
    try {
      this.profile = await this.getMe();
      if (this.config.REDDIT_DEBUG_AUTH) {
        elizaLogger.info(`[Reddit] auth ok user=${this.profile.name} id=${this.profile.id}`);
      } else {
        elizaLogger.info(`[Reddit] authenticated as /u/${this.profile.name}`);
      }
    } catch (error) {
      elizaLogger.error("[Reddit] unable to verify /api/v1/me", error);
      throw error;
    }
  }
  stop() {
  }
  isCapabilityEnabled(capability) {
    return this.capabilityEnabled[capability];
  }
  disableCapability(capability, reason) {
    if (!this.capabilityEnabled[capability]) return;
    this.capabilityEnabled[capability] = false;
    elizaLogger.warn(`[Reddit] disabling ${capability}: ${reason}`);
  }
  warnScopeOnce(scope, feature) {
    const key = `${scope}:${feature}`;
    if (this.warnedScopes.has(key)) return;
    this.warnedScopes.add(key);
    this.disableCapability(feature, `missing scope '${scope}'`);
  }
  maybeDisableFeatureByPath(path2, responseData) {
    const msg = `${responseData?.message || ""} ${responseData?.error || ""}`.toLowerCase();
    const isScopeError = msg.includes("scope") || msg.includes("insufficient");
    if (!isScopeError) return;
    if (path2.startsWith("/message/")) this.warnScopeOnce("privatemessages", "inbox");
    if (path2.startsWith("/user/")) this.warnScopeOnce("history", "history");
    if (path2 === "/api/submit") this.warnScopeOnce("submit", "submit");
    if (path2 === "/api/comment") this.warnScopeOnce("read+submit", "comment");
    if (path2 === "/api/vote") this.warnScopeOnce("vote", "vote");
  }
  async getAccessToken() {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt > now + 1e4) {
      return this.tokenCache.accessToken;
    }
    if (this.tokenPromise) return this.tokenPromise;
    this.tokenPromise = (async () => {
      const auth = Buffer.from(`${this.config.REDDIT_CLIENT_ID}:${this.config.REDDIT_CLIENT_SECRET || ""}`).toString("base64");
      const body = new URLSearchParams();
      if (this.config.REDDIT_REFRESH_TOKEN) {
        body.set("grant_type", "refresh_token");
        body.set("refresh_token", this.config.REDDIT_REFRESH_TOKEN);
      } else {
        body.set("grant_type", "password");
        body.set("username", this.config.REDDIT_USERNAME);
        body.set("password", this.config.REDDIT_PASSWORD || "");
      }
      const response = await fetch("https://www.reddit.com/api/v1/access_token", {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": this.config.REDDIT_USER_AGENT_RESOLVED
        },
        body: body.toString()
      });
      const payload = await response.json();
      if (!response.ok || !payload.access_token) {
        throw new RedditApiError(
          `[Reddit] token error: ${payload.error || response.statusText}`,
          response.status,
          payload
        );
      }
      const expiresInSec = Math.max(60, Number(payload.expires_in || 3600));
      this.tokenCache = {
        accessToken: payload.access_token,
        expiresAt: Date.now() + (expiresInSec - 30) * 1e3
      };
      return payload.access_token;
    })();
    try {
      return await this.tokenPromise;
    } finally {
      this.tokenPromise = null;
    }
  }
  async withRetry(path2, action) {
    const maxAttempts = 6;
    let lastError;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        return await action();
      } catch (error) {
        lastError = error;
        const status = error?.status;
        const retryAfterMs = Number(error?.retryAfterMs || 0);
        if (status === 401 && attempt < maxAttempts - 1) {
          this.tokenCache = null;
          continue;
        }
        if ((status === 429 || status >= 500 && status < 600) && attempt < maxAttempts - 1) {
          const exponential = Math.min(
            this.config.REDDIT_BACKOFF_MAX_MS,
            this.config.REDDIT_BACKOFF_BASE_MS * 2 ** attempt
          );
          const waitMs = retryAfterMs > 0 ? retryAfterMs : jitterMs(exponential);
          this.pacer.applyRetryAfter(waitMs);
          elizaLogger.warn(
            `[Reddit] request retry for ${path2} status=${status} attempt=${attempt + 1}/${maxAttempts} wait=${waitMs}ms`
          );
          await sleep(waitMs);
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  }
  async request(path2, opts) {
    const method = opts?.method || "GET";
    return this.withRetry(path2, async () => {
      await this.pacer.waitTurn();
      const accessToken = opts?.allowWithoutAuth ? "" : await this.getAccessToken();
      const url = new URL(
        path2.startsWith("http") ? path2 : `https://oauth.reddit.com${path2}`
      );
      if (opts?.query) {
        for (const [key, value] of Object.entries(opts.query)) {
          if (value == null) continue;
          url.searchParams.set(key, String(value));
        }
      }
      const headers = new Headers({
        "User-Agent": this.config.REDDIT_USER_AGENT_RESOLVED,
        Accept: "application/json"
      });
      if (!opts?.allowWithoutAuth) {
        headers.set("Authorization", `Bearer ${accessToken}`);
      }
      let body;
      if (opts?.form) {
        const params = new URLSearchParams();
        Object.entries(opts.form).forEach(([k, v]) => {
          if (v == null) return;
          params.set(k, String(v));
        });
        body = params.toString();
        headers.set("Content-Type", "application/x-www-form-urlencoded");
      } else if (opts?.body != null) {
        body = JSON.stringify(opts.body);
        headers.set("Content-Type", "application/json");
      }
      const response = await fetch(url.toString(), {
        method,
        headers,
        body
      });
      const remaining = Number(response.headers.get("x-ratelimit-remaining") || NaN);
      const reset = Number(response.headers.get("x-ratelimit-reset") || NaN);
      this.pacer.slowdownForHeader(remaining, reset);
      const text = await response.text();
      const payload = text ? safeJsonParse(text) : null;
      if (!response.ok) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
        this.maybeDisableFeatureByPath(path2, payload);
        throw new RedditApiError(
          payload?.message || payload?.error || `Reddit request failed (${response.status})`,
          response.status,
          payload,
          retryAfterMs
        );
      }
      return payload;
    });
  }
  canWrite(capability) {
    if (!this.capabilityEnabled[capability]) return false;
    if (this.config.REDDIT_READ_ONLY) return false;
    return true;
  }
  async getMe() {
    return this.request("/api/v1/me", { method: "GET" });
  }
  async getInbox(limit = 25, after) {
    if (!this.isCapabilityEnabled("inbox")) return { items: [] };
    const listing = asListing(
      await this.request("/message/inbox", {
        method: "GET",
        query: { limit: Math.min(Math.max(limit, 1), 100), after }
      })
    );
    return {
      items: listing.data.children.map((c) => c.data),
      after: listing.data.after || undefined
    };
  }
  async markMessagesRead(ids) {
    if (!ids.length) return;
    if (!this.canWrite("inbox")) return;
    if (this.config.REDDIT_DRY_RUN) {
      elizaLogger.info(`[Reddit][DRY_RUN] would mark ${ids.length} inbox item(s) read`);
      return;
    }
    await this.request("/api/read_message", {
      method: "POST",
      form: {
        api_type: "json",
        id: ids.join(",")
      }
    });
  }
  async getUserSubmitted(username, limit = 25) {
    if (!this.isCapabilityEnabled("history")) return [];
    const listing = asListing(
      await this.request(`/user/${encodeURIComponent(username)}/submitted`, {
        method: "GET",
        query: { limit: Math.min(Math.max(limit, 1), 100) }
      })
    );
    return listing.data.children.map((c) => c.data);
  }
  async getUserComments(username, limit = 25) {
    if (!this.isCapabilityEnabled("history")) return [];
    const listing = asListing(
      await this.request(`/user/${encodeURIComponent(username)}/comments`, {
        method: "GET",
        query: { limit: Math.min(Math.max(limit, 1), 100) }
      })
    );
    return listing.data.children.map((c) => c.data);
  }
  async getCommentsByPermalink(permalink, limit = 100) {
    const clean = permalink.replace(/\.json$/i, "");
    const payload = await this.request(`${clean}.json`, {
      method: "GET",
      query: { limit }
    });
    if (!Array.isArray(payload) || payload.length < 2) return [];
    const commentsListing = asListing(payload[1]);
    return commentsListing.data.children.map((child) => child.data).filter((item) => item && typeof item.id === "string");
  }
  async submitSelfPost(input) {
    if (!this.canWrite("submit")) {
      throw new RedditApiError("posting disabled by config/scope", 403);
    }
    if (this.config.REDDIT_DRY_RUN) {
      elizaLogger.info(
        `[Reddit][DRY_RUN] would submit post to r/${input.subreddit} title="${input.title}"`
      );
      return { thingId: "t3_dryrun", url: "https://reddit.com" };
    }
    const payload = await this.request("/api/submit", {
      method: "POST",
      form: {
        api_type: "json",
        sr: input.subreddit,
        kind: "self",
        title: input.title,
        text: input.text,
        resubmit: false,
        send_replies: input.sendReplies ?? true
      }
    });
    const things = payload?.json?.data?.things;
    const first = Array.isArray(things) ? things[0] : undefined;
    return {
      thingId: first?.id,
      url: first?.data?.url
    };
  }
  async commentReply(parentThingId, text) {
    if (!this.canWrite("comment")) {
      throw new RedditApiError("commenting disabled by config/scope", 403);
    }
    if (this.config.REDDIT_DRY_RUN) {
      elizaLogger.info(`[Reddit][DRY_RUN] would comment reply to ${parentThingId}: ${text.slice(0, 120)}`);
      return { thingId: "t1_dryrun" };
    }
    const payload = await this.request("/api/comment", {
      method: "POST",
      form: {
        api_type: "json",
        thing_id: parentThingId,
        text
      }
    });
    const things = payload?.json?.data?.things;
    const id = things?.[0]?.data?.name;
    return { thingId: id };
  }
  async upvote(thingId) {
    if (!this.canWrite("vote")) return;
    if (this.config.REDDIT_DRY_RUN) {
      elizaLogger.info(`[Reddit][DRY_RUN] would upvote ${thingId}`);
      return;
    }
    await this.request("/api/vote", {
      method: "POST",
      form: {
        id: thingId,
        dir: 1
      }
    });
  }
};
function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
var toBool = (v, def = false) => parseBooleanFromText(v ?? "") ?? def;
var toInt = (v, def) => {
  if (!v) return def;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? def : n;
};
var toList = (v) => (v ?? "").split(",").map((x) => normalizeSubreddit(x)).filter(Boolean);
function getSetting(runtime, key) {
  return runtime.getSetting(key) || process.env[key];
}
var redditEnvSchema = z.object({
  REDDIT_ENABLED: z.boolean().default(true),
  REDDIT_ENABLE_POSTS: z.boolean().default(true),
  REDDIT_ENABLE_INTERACTIONS: z.boolean().default(true),
  REDDIT_READ_ONLY: z.boolean().default(false),
  REDDIT_DRY_RUN: z.boolean().default(false),
  REDDIT_CLIENT_ID: z.string().min(1, "REDDIT_CLIENT_ID is required"),
  REDDIT_CLIENT_SECRET: z.string().optional(),
  REDDIT_REFRESH_TOKEN: z.string().optional(),
  REDDIT_USERNAME: z.string().min(1, "REDDIT_USERNAME is required"),
  REDDIT_PASSWORD: z.string().optional(),
  REDDIT_USER_AGENT: z.string().optional(),
  REDDIT_RPM: z.number().int().min(5).default(50),
  REDDIT_BACKOFF_BASE_MS: z.number().int().min(250).default(2e3),
  REDDIT_BACKOFF_MAX_MS: z.number().int().min(1e3).default(6e4),
  REDDIT_POSTS_PER_DAY_NEWS: z.number().int().min(0).default(10),
  REDDIT_POSTS_PER_DAY_TRADES: z.number().int().min(0).default(10),
  REDDIT_POST_MIN_INTERVAL_SEC: z.number().int().min(10).default(900),
  REDDIT_REPLIES_PER_DAY: z.number().int().min(0).default(50),
  REDDIT_REPLY_MIN_INTERVAL_SEC: z.number().int().min(5).default(60),
  REDDIT_USER_COOLDOWN_MINUTES: z.number().int().min(1).default(30),
  REDDIT_SUBREDDITS_NEWS: z.array(z.string()).default([]),
  REDDIT_SUBREDDITS_TRADES: z.array(z.string()).default([]),
  REDDIT_DEFAULT_SUBREDDIT: z.string().default("general"),
  REDDIT_WATCHED_SUBREDDITS: z.array(z.string()).default([]),
  REDDIT_INTERACTION_POLL_INTERVAL_SEC: z.number().int().min(10).default(60),
  REDDIT_POST_POLL_INTERVAL_SEC: z.number().int().min(20).default(60),
  REDDIT_MAX_PROCESSED_IDS: z.number().int().min(100).default(5e3),
  REDDIT_MAX_QUEUE_SIZE: z.number().int().min(20).default(500),
  REDDIT_MAX_QUEUE_RETRIES: z.number().int().min(1).default(8),
  REDDIT_ENABLE_UPVOTE: z.boolean().default(false),
  REDDIT_UPVOTE_MIN_SCORE: z.number().int().default(5),
  REDDIT_REQUIRE_TRADE_APPROVAL: z.boolean().default(true),
  REDDIT_TRADE_AUTO_APPROVE: z.boolean().default(false),
  REDDIT_DEBUG_AUTH: z.boolean().default(false)
});
async function validateRedditConfig(runtime) {
  try {
    const packageVersion = process.env.npm_package_version || "0.0.0";
    const raw = {
      REDDIT_ENABLED: toBool(getSetting(runtime, "REDDIT_ENABLED"), true),
      REDDIT_ENABLE_POSTS: toBool(getSetting(runtime, "REDDIT_ENABLE_POSTS"), true),
      REDDIT_ENABLE_INTERACTIONS: toBool(getSetting(runtime, "REDDIT_ENABLE_INTERACTIONS"), true),
      REDDIT_READ_ONLY: toBool(getSetting(runtime, "REDDIT_READ_ONLY"), false),
      REDDIT_DRY_RUN: toBool(getSetting(runtime, "REDDIT_DRY_RUN"), false),
      REDDIT_CLIENT_ID: getSetting(runtime, "REDDIT_CLIENT_ID"),
      REDDIT_CLIENT_SECRET: getSetting(runtime, "REDDIT_CLIENT_SECRET"),
      REDDIT_REFRESH_TOKEN: getSetting(runtime, "REDDIT_REFRESH_TOKEN"),
      REDDIT_USERNAME: getSetting(runtime, "REDDIT_USERNAME"),
      REDDIT_PASSWORD: getSetting(runtime, "REDDIT_PASSWORD"),
      REDDIT_USER_AGENT: getSetting(runtime, "REDDIT_USER_AGENT"),
      REDDIT_RPM: toInt(getSetting(runtime, "REDDIT_RPM"), 50),
      REDDIT_BACKOFF_BASE_MS: toInt(getSetting(runtime, "REDDIT_BACKOFF_BASE_MS"), 2e3),
      REDDIT_BACKOFF_MAX_MS: toInt(getSetting(runtime, "REDDIT_BACKOFF_MAX_MS"), 6e4),
      REDDIT_POSTS_PER_DAY_NEWS: toInt(getSetting(runtime, "REDDIT_POSTS_PER_DAY_NEWS"), 10),
      REDDIT_POSTS_PER_DAY_TRADES: toInt(getSetting(runtime, "REDDIT_POSTS_PER_DAY_TRADES"), 10),
      REDDIT_POST_MIN_INTERVAL_SEC: toInt(getSetting(runtime, "REDDIT_POST_MIN_INTERVAL_SEC"), 900),
      REDDIT_REPLIES_PER_DAY: toInt(getSetting(runtime, "REDDIT_REPLIES_PER_DAY"), 50),
      REDDIT_REPLY_MIN_INTERVAL_SEC: toInt(getSetting(runtime, "REDDIT_REPLY_MIN_INTERVAL_SEC"), 60),
      REDDIT_USER_COOLDOWN_MINUTES: toInt(getSetting(runtime, "REDDIT_USER_COOLDOWN_MINUTES"), 30),
      REDDIT_SUBREDDITS_NEWS: toList(getSetting(runtime, "REDDIT_SUBREDDITS_NEWS")),
      REDDIT_SUBREDDITS_TRADES: toList(getSetting(runtime, "REDDIT_SUBREDDITS_TRADES")),
      REDDIT_DEFAULT_SUBREDDIT: normalizeSubreddit(getSetting(runtime, "REDDIT_DEFAULT_SUBREDDIT") || "general"),
      REDDIT_WATCHED_SUBREDDITS: toList(getSetting(runtime, "REDDIT_WATCHED_SUBREDDITS")),
      REDDIT_INTERACTION_POLL_INTERVAL_SEC: toInt(getSetting(runtime, "REDDIT_INTERACTION_POLL_INTERVAL_SEC"), 60),
      REDDIT_POST_POLL_INTERVAL_SEC: toInt(getSetting(runtime, "REDDIT_POST_POLL_INTERVAL_SEC"), 60),
      REDDIT_MAX_PROCESSED_IDS: toInt(getSetting(runtime, "REDDIT_MAX_PROCESSED_IDS"), 5e3),
      REDDIT_MAX_QUEUE_SIZE: toInt(getSetting(runtime, "REDDIT_MAX_QUEUE_SIZE"), 500),
      REDDIT_MAX_QUEUE_RETRIES: toInt(getSetting(runtime, "REDDIT_MAX_QUEUE_RETRIES"), 8),
      REDDIT_ENABLE_UPVOTE: toBool(getSetting(runtime, "REDDIT_ENABLE_UPVOTE"), false),
      REDDIT_UPVOTE_MIN_SCORE: toInt(getSetting(runtime, "REDDIT_UPVOTE_MIN_SCORE"), 5),
      REDDIT_REQUIRE_TRADE_APPROVAL: toBool(getSetting(runtime, "REDDIT_REQUIRE_TRADE_APPROVAL"), true),
      REDDIT_TRADE_AUTO_APPROVE: toBool(getSetting(runtime, "REDDIT_TRADE_AUTO_APPROVE"), false),
      REDDIT_DEBUG_AUTH: toBool(getSetting(runtime, "REDDIT_DEBUG_AUTH"), false)
    };
    const parsed = redditEnvSchema.parse(raw);
    if (!parsed.REDDIT_REFRESH_TOKEN && !(parsed.REDDIT_USERNAME && parsed.REDDIT_PASSWORD)) {
      throw new Error(
        "Provide REDDIT_REFRESH_TOKEN (recommended) or REDDIT_USERNAME + REDDIT_PASSWORD for password grant"
      );
    }
    const userAgentDefault = `elizaos:client-reddit:${packageVersion} (by /u/${parsed.REDDIT_USERNAME})`;
    const REDDIT_USER_AGENT_RESOLVED = parsed.REDDIT_USER_AGENT?.trim() || userAgentDefault;
    return {
      ...parsed,
      REDDIT_USER_AGENT_RESOLVED
    };
  } catch (error) {
    if (error instanceof ZodError) {
      const details = error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("\n");
      throw new Error(`Reddit configuration validation failed:
${details}`);
    }
    throw error;
  }
}
var redditShouldRespondTemplate = `# INSTRUCTIONS: Determine if {{agentName}} should respond to the Reddit message.
Respond with exactly one tag: [RESPOND], [IGNORE], or [STOP].

Respond [RESPOND] when:
- The comment is directly addressing {{agentName}}
- The topic matches {{agentName}}'s expertise
- A concise, useful answer can be provided

Respond [IGNORE] when:
- It is spam, trolling, or clearly off-topic
- It asks for unsafe or policy-violating behavior
- It is too low-effort to add value

Respond [STOP] when:
- The user asks to end the thread
- The conversation is already concluded

Current post:
{{currentPost}}

Thread context:
{{formattedConversation}}

` + shouldRespondFooter;
var redditMessageHandlerTemplate = `# About {{agentName}}
{{bio}}
{{lore}}
{{topics}}

{{providers}}
{{characterPostExamples}}
{{postDirections}}

# Task
Write a concise Reddit reply in {{agentName}} style.

Rules:
- Keep it high-signal and specific
- No hype or spam
- Prefer plain language
- Include actions only if relevant to configured actions

Current post:
{{currentPost}}

Thread context:
{{formattedConversation}}

` + messageCompletionFooter;
var redditAutonomousPostTemplate = `You are creating a Reddit self-post for {{agentName}}.

Topic bucket: {{topicBucket}}
Target subreddit: {{targetSubreddit}}

Output JSON with exactly these fields:
{
  "title": "...",
  "body": "..."
}

Rules:
- Practical and concise
- No fabricated claims
- No investment guarantees
- Max 220 chars for title
- Max 3000 chars for body`;

// src/interactions.ts
var defaultState = {
  version: 1,
  lastSeenInboxThingId: undefined,
  lastSeenCommentTimestampByThread: {},
  processedThingIds: [],
  processedAtByThingId: {},
  userCooldownByAuthor: {},
  replyTimestamps: [],
  lastReplyAt: 0,
  watchedThreadPermalinks: [],
  warnedFeatures: {}
};
var RedditInteractionClient = class {
  constructor(client, runtime) {
    this.running = false;
    this.loopPromise = null;
    this.client = client;
    this.runtime = runtime;
    const baseDir = resolveRuntimeDataDir(runtime);
    this.stateFile = `${baseDir}/interactions-state.json`;
  }
  async start() {
    if (!this.client.config.REDDIT_ENABLE_INTERACTIONS) {
      elizaLogger.warn("[Reddit] interactions loop disabled via REDDIT_ENABLE_INTERACTIONS=false");
      return;
    }
    this.running = true;
    this.loadState();
    this.loopPromise = this.runLoop();
  }
  async stop() {
    this.running = false;
    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = null;
    }
  }
  loadState() {
    return readJsonFile(this.stateFile, defaultState);
  }
  saveState(state) {
    writeJsonFile(this.stateFile, state);
  }
  pruneState(state) {
    const maxIds = this.client.config.REDDIT_MAX_PROCESSED_IDS;
    const cutoff = nowMs() - 7 * 24 * 60 * 60 * 1e3;
    state.processedThingIds = state.processedThingIds.filter((id) => (state.processedAtByThingId[id] || 0) >= cutoff);
    state.processedThingIds = state.processedThingIds.slice(-maxIds);
    const keep = new Set(state.processedThingIds);
    for (const key of Object.keys(state.processedAtByThingId)) {
      if (!keep.has(key)) delete state.processedAtByThingId[key];
    }
    state.replyTimestamps = state.replyTimestamps.filter((ts) => ts >= nowMs() - 24 * 60 * 60 * 1e3);
    for (const author of Object.keys(state.userCooldownByAuthor)) {
      if (state.userCooldownByAuthor[author] < nowMs() - 24 * 60 * 60 * 1e3) {
        delete state.userCooldownByAuthor[author];
      }
    }
    state.watchedThreadPermalinks = Array.from(new Set(state.watchedThreadPermalinks)).slice(-500);
  }
  alreadyProcessed(state, thingId) {
    return Boolean(state.processedAtByThingId[thingId]);
  }
  markProcessed(state, thingId) {
    state.processedAtByThingId[thingId] = nowMs();
    state.processedThingIds.push(thingId);
    state.processedThingIds = Array.from(new Set(state.processedThingIds));
    if (state.processedThingIds.length > this.client.config.REDDIT_MAX_PROCESSED_IDS) {
      state.processedThingIds = state.processedThingIds.slice(-this.client.config.REDDIT_MAX_PROCESSED_IDS);
    }
  }
  canReplyNow(state, author) {
    const now = nowMs();
    if (state.replyTimestamps.length >= this.client.config.REDDIT_REPLIES_PER_DAY) return false;
    const minInterval = this.client.config.REDDIT_REPLY_MIN_INTERVAL_SEC * 1e3;
    if (state.lastReplyAt > 0 && now - state.lastReplyAt < minInterval) return false;
    const cooldownMinutes = this.client.config.REDDIT_USER_COOLDOWN_MINUTES;
    const userLast = state.userCooldownByAuthor[author.toLowerCase()] || 0;
    if (now - userLast < cooldownMinutes * 60 * 1e3) return false;
    return true;
  }
  trackReply(state, author) {
    const now = nowMs();
    state.lastReplyAt = now;
    state.replyTimestamps.push(now);
    state.userCooldownByAuthor[author.toLowerCase()] = now;
  }
  isCandidateIgnored(candidate) {
    if (!candidate.author || candidate.author === "[deleted]") return true;
    if (isLikelyBot(candidate.author)) return true;
    if (isLikelySpam(candidate.body || "")) return true;
    const me = this.client.profile?.name?.toLowerCase();
    if (me && candidate.author.toLowerCase() === me) return true;
    return false;
  }
  maybeWarnOnce(state, key, message) {
    if (state.warnedFeatures[key]) return;
    state.warnedFeatures[key] = true;
    elizaLogger.warn(message);
  }
  async collectInboxCandidates(state) {
    const candidates = [];
    const seenInboxIds = [];
    if (!this.client.isCapabilityEnabled("inbox")) {
      this.maybeWarnOnce(state, "inbox-disabled", "[Reddit] inbox polling disabled by missing scope/permissions");
      return { candidates, seenInboxIds };
    }
    try {
      const inbox = await this.client.getInbox(50);
      const watermark = state.lastSeenInboxThingId;
      for (const item of inbox.items) {
        if (watermark && item.name === watermark) break;
        const type = this.mapInboxType(item);
        if (!type) continue;
        const thingId = item.name;
        const parentThingId = item.name.startsWith("t1_") || item.name.startsWith("t3_") ? item.name : item.parent_id || item.link_id || item.name;
        candidates.push({
          thingId,
          parentThingId,
          triggerType: "inbox",
          author: item.author,
          subreddit: normalizeSubreddit(item.subreddit || ""),
          permalink: item.context || item.permalink,
          body: item.body || "",
          title: item.link_title,
          score: void 0,
          createdUtc: item.created_utc,
          threadId: item.link_id
        });
        seenInboxIds.push(item.name);
      }
      if (inbox.items[0]?.name) {
        state.lastSeenInboxThingId = inbox.items[0].name;
      }
    } catch (error) {
      if (error?.status === 403) {
        this.maybeWarnOnce(state, "inbox-403", "[Reddit] inbox polling returned 403; disabling inbox feature");
        this.client.disableCapability("inbox", "403 from inbox endpoint");
      } else {
        elizaLogger.warn("[Reddit] inbox poll failed", error);
      }
    }
    return { candidates, seenInboxIds };
  }
  mapInboxType(item) {
    const subject = (item.subject || "").toLowerCase();
    if (subject.includes("comment reply") || subject.includes("post reply")) return "reply";
    if (subject.includes("username mention") || subject.includes("mention")) return "mention";
    return null;
  }
  async collectOwnThreadCandidates(state) {
    const out = [];
    const username = this.client.profile?.name || this.client.config.REDDIT_USERNAME;
    let mySubmissions = [];
    let myComments = [];
    try {
      mySubmissions = await this.client.getUserSubmitted(username, 20);
    } catch (error) {
      elizaLogger.warn("[Reddit] unable to fetch own submissions", error);
    }
    try {
      myComments = await this.client.getUserComments(username, 20);
    } catch (error) {
      elizaLogger.warn("[Reddit] unable to fetch own comments", error);
    }
    for (const submission of mySubmissions) {
      state.watchedThreadPermalinks.push(submission.permalink);
      const latestSeen = state.lastSeenCommentTimestampByThread[submission.name] || 0;
      let maxSeen = latestSeen;
      try {
        const comments = await this.client.getCommentsByPermalink(submission.permalink, 100);
        for (const c of comments) {
          const created = Math.floor(c.created_utc * 1e3);
          if (created <= latestSeen) continue;
          if (c.author.toLowerCase() === username.toLowerCase()) continue;
          out.push({
            thingId: c.name,
            parentThingId: c.name,
            triggerType: "thread",
            author: c.author,
            subreddit: normalizeSubreddit(c.subreddit),
            permalink: c.permalink,
            body: c.body,
            title: submission.title,
            score: c.score,
            createdUtc: c.created_utc,
            threadId: submission.name
          });
          if (created > maxSeen) maxSeen = created;
        }
      } catch (error) {
        elizaLogger.warn(`[Reddit] thread scan failed for ${submission.permalink}`, error);
      }
      state.lastSeenCommentTimestampByThread[submission.name] = maxSeen;
    }
    const myCommentNames = new Set(myComments.map((c) => c.name));
    for (const permalink of state.watchedThreadPermalinks.slice(-50)) {
      try {
        const comments = await this.client.getCommentsByPermalink(permalink, 100);
        for (const c of comments) {
          if (!myCommentNames.has(c.parent_id)) continue;
          out.push({
            thingId: c.name,
            parentThingId: c.name,
            triggerType: "fallback",
            author: c.author,
            subreddit: normalizeSubreddit(c.subreddit),
            permalink: c.permalink,
            body: c.body,
            title: void 0,
            score: c.score,
            createdUtc: c.created_utc,
            threadId: c.link_id
          });
        }
      } catch {
      }
    }
    for (const subreddit of this.client.config.REDDIT_WATCHED_SUBREDDITS) {
      try {
        const listing = asListing2(
          await this.client.request(`/r/${encodeURIComponent(subreddit)}/comments`, {
            method: "GET",
            query: { limit: 20 }
          })
        );
        for (const child of listing.data.children) {
          const c = child.data;
          if (!c?.name || !c?.body) continue;
          out.push({
            thingId: c.name,
            parentThingId: c.name,
            triggerType: "thread",
            author: c.author,
            subreddit,
            permalink: c.permalink,
            body: c.body,
            score: c.score,
            createdUtc: c.created_utc,
            threadId: c.link_id
          });
        }
      } catch (error) {
        elizaLogger.warn(`[Reddit] watched subreddit scan failed for r/${subreddit}`, error);
      }
    }
    return out;
  }
  async buildContext(candidate) {
    if (!candidate.permalink) {
      return {
        currentPost: candidate.body,
        formattedConversation: candidate.body,
        parentPostTitle: candidate.title
      };
    }
    try {
      const comments = await this.client.getCommentsByPermalink(candidate.permalink, 100);
      const byName = /* @__PURE__ */ new Map();
      for (const c of comments) byName.set(c.name, c);
      const current = byName.get(candidate.thingId) || comments.find((c) => c.name === candidate.thingId);
      const parent = current ? byName.get(current.parent_id) : void 0;
      const grandParent = parent ? byName.get(parent.parent_id) : void 0;
      const formattedConversation = [
        grandParent ? `Parent-2 (${grandParent.author}): ${grandParent.body}` : "",
        parent ? `Parent-1 (${parent.author}): ${parent.body}` : "",
        `Current (${candidate.author}): ${current?.body || candidate.body}`
      ].filter(Boolean).join("\n\n");
      return {
        currentPost: current?.body || candidate.body,
        formattedConversation,
        parentPostTitle: candidate.title,
        permalink: candidate.permalink
      };
    } catch {
      return {
        currentPost: candidate.body,
        formattedConversation: candidate.body,
        parentPostTitle: candidate.title,
        permalink: candidate.permalink
      };
    }
  }
  async ensureConnection(candidate) {
    const roomKey = candidate.threadId || candidate.parentThingId || candidate.thingId;
    const roomId = stringToUuid(`reddit:room:${roomKey}:${this.runtime.agentId}`);
    const userId = stringToUuid(`reddit:user:${candidate.author}`);
    await this.runtime.ensureConnection(
      userId,
      roomId,
      candidate.author,
      candidate.author,
      "reddit"
    );
    return { roomId, userId };
  }
  async generateReplyText(candidate, context) {
    const { roomId, userId } = await this.ensureConnection(candidate);
    const incomingMemory = {
      id: stringToUuid(`reddit:incoming:${candidate.thingId}:${this.runtime.agentId}`),
      userId,
      roomId,
      agentId: this.runtime.agentId,
      content: {
        text: context.currentPost,
        source: "reddit",
        url: context.permalink
      },
      embedding: getEmbeddingZeroVector(),
      createdAt: Math.floor(candidate.createdUtc * 1e3)
    };
    await this.runtime.messageManager.createMemory(incomingMemory);
    const state = await this.runtime.composeState(incomingMemory, {
      currentPost: context.currentPost,
      formattedConversation: context.formattedConversation,
      redditUserName: this.client.profile?.name || this.client.config.REDDIT_USERNAME
    });
    const shouldContext = composeContext({
      state,
      template: this.runtime.character.templates?.redditShouldRespondTemplate || redditShouldRespondTemplate
    });
    const should = await generateShouldRespond({
      runtime: this.runtime,
      context: shouldContext,
      modelClass: ModelClass.SMALL
    });
    if (should !== "RESPOND") return null;
    const messageContext = composeContext({
      state,
      template: this.runtime.character.templates?.redditMessageHandlerTemplate || redditMessageHandlerTemplate
    });
    const response = await generateMessageResponse({
      runtime: this.runtime,
      context: messageContext,
      modelClass: ModelClass.MEDIUM
    });
    return response;
  }
  async maybeReply(state, candidate) {
    if (!this.canReplyNow(state, candidate.author)) return "defer";
    const context = await this.buildContext(candidate);
    const content = await this.generateReplyText(candidate, context);
    const text = truncate((content?.text || "").trim(), 9500);
    if (!text) return "ignored";
    try {
      await this.client.commentReply(candidate.parentThingId, text);
      this.trackReply(state, candidate.author);
      if (this.client.config.REDDIT_ENABLE_UPVOTE && typeof candidate.score === "number" && candidate.score >= this.client.config.REDDIT_UPVOTE_MIN_SCORE) {
        await this.client.upvote(candidate.thingId);
      }
      return "replied";
    } catch (error) {
      if (error instanceof RedditApiError && error.status === 403) {
        this.client.disableCapability("comment", "403 from /api/comment");
      }
      throw error;
    }
  }
  uniqueCandidates(candidates) {
    const map = /* @__PURE__ */ new Map();
    for (const candidate of candidates) {
      if (!candidate.thingId) continue;
      const prev = map.get(candidate.thingId);
      if (!prev || candidate.createdUtc > prev.createdUtc) {
        map.set(candidate.thingId, candidate);
      }
    }
    return [...map.values()].sort((a, b) => a.createdUtc - b.createdUtc);
  }
  async tick() {
    const state = this.loadState();
    this.pruneState(state);
    const inbox = await this.collectInboxCandidates(state);
    const own = await this.collectOwnThreadCandidates(state);
    const candidates = this.uniqueCandidates([...inbox.candidates, ...own]);
    for (const candidate of candidates) {
      if (this.alreadyProcessed(state, candidate.thingId)) continue;
      if (this.isCandidateIgnored(candidate)) {
        this.markProcessed(state, candidate.thingId);
        continue;
      }
      try {
        const outcome = await this.maybeReply(state, candidate);
        if (outcome !== "defer") {
          this.markProcessed(state, candidate.thingId);
        }
      } catch (error) {
        elizaLogger.warn(`[Reddit] interaction handling failed for ${candidate.thingId}`, error);
      }
      this.pruneState(state);
      this.saveState(state);
    }
    if (inbox.seenInboxIds.length > 0) {
      try {
        await this.client.markMessagesRead(inbox.seenInboxIds.slice(0, 100));
      } catch (error) {
        elizaLogger.warn("[Reddit] failed to mark inbox messages read", error);
      }
    }
    this.saveState(state);
  }
  async runLoop() {
    const delayMs = this.client.config.REDDIT_INTERACTION_POLL_INTERVAL_SEC * 1e3;
    while (this.running) {
      try {
        await this.tick();
      } catch (error) {
        elizaLogger.error("[Reddit] interactions loop error", error);
      }
      await sleep(delayMs);
    }
  }
};
function asListing2(value) {
  if (!value || value.kind !== "Listing") {
    throw new Error("Unexpected listing shape");
  }
  return value;
}
var defaultQueueState = { version: 1, items: [] };
var defaultDeadLetter = { version: 1, items: [] };
var defaultPostedState = {
  version: 1,
  lastPostTime: 0,
  lastPostedHash: "",
  recentHashes: [],
  postTimestampsByKind: {
    news: [],
    trade: []
  },
  postedThingIds: []
};
var RedditPostClient = class {
  constructor(client, runtime) {
    this.running = false;
    this.postLoopPromise = null;
    this.client = client;
    this.runtime = runtime;
    const baseDir = resolveRuntimeDataDir(runtime);
    this.queueFile = `${baseDir}/post-queue.json`;
    this.deadLetterFile = `${baseDir}/dead-letter.json`;
    this.postedStateFile = `${baseDir}/posted-state.json`;
  }
  async start() {
    if (!this.client.config.REDDIT_ENABLE_POSTS) {
      elizaLogger.warn("[Reddit] post loop disabled via REDDIT_ENABLE_POSTS=false");
      return;
    }
    this.running = true;
    this.ensureStateFiles();
    this.postLoopPromise = this.runLoop();
  }
  async stop() {
    this.running = false;
    if (this.postLoopPromise) {
      await this.postLoopPromise;
      this.postLoopPromise = null;
    }
  }
  enqueue(item) {
    const state = this.loadQueueState();
    if (state.items.length >= this.client.config.REDDIT_MAX_QUEUE_SIZE) {
      state.items.sort((a, b) => (a.priority || 0) - (b.priority || 0) || a.createdAt - b.createdAt);
      state.items.shift();
    }
    const queueItem = {
      ...item,
      target: normalizeSubreddit(item.target || ""),
      id: `reddit:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
      retries: 0,
      createdAt: Date.now(),
      priority: item.priority ?? 0
    };
    state.items.push(queueItem);
    this.saveQueueState(state);
  }
  ensureStateFiles() {
    readJsonFile(this.queueFile, defaultQueueState);
    readJsonFile(this.deadLetterFile, defaultDeadLetter);
    readJsonFile(this.postedStateFile, defaultPostedState);
  }
  loadQueueState() {
    return readJsonFile(this.queueFile, defaultQueueState);
  }
  saveQueueState(state) {
    writeJsonFile(this.queueFile, state);
  }
  loadDeadLetterState() {
    return readJsonFile(this.deadLetterFile, defaultDeadLetter);
  }
  saveDeadLetterState(state) {
    writeJsonFile(this.deadLetterFile, state);
  }
  loadPostedState() {
    return readJsonFile(this.postedStateFile, defaultPostedState);
  }
  savePostedState(state) {
    writeJsonFile(this.postedStateFile, state);
  }
  pickTarget(kind) {
    const source = kind === "trade" ? this.client.config.REDDIT_SUBREDDITS_TRADES : this.client.config.REDDIT_SUBREDDITS_NEWS;
    const fallback = normalizeSubreddit(this.client.config.REDDIT_DEFAULT_SUBREDDIT);
    const options = source.length > 0 ? source : fallback ? [fallback] : [];
    if (options.length === 0) return "general";
    const idx = Math.floor(Math.random() * options.length);
    return normalizeSubreddit(options[idx] || fallback || "general");
  }
  prunePostedState(state) {
    const dayAgo = nowMs() - 24 * 60 * 60 * 1e3;
    state.postTimestampsByKind.news = state.postTimestampsByKind.news.filter((ts) => ts >= dayAgo);
    state.postTimestampsByKind.trade = state.postTimestampsByKind.trade.filter((ts) => ts >= dayAgo);
    state.recentHashes = state.recentHashes.slice(-200);
    state.postedThingIds = state.postedThingIds.slice(-1e3);
  }
  canPostNow(kind, state) {
    const now = nowMs();
    this.prunePostedState(state);
    const minIntervalMs = this.client.config.REDDIT_POST_MIN_INTERVAL_SEC * 1e3;
    if (state.lastPostTime && now - state.lastPostTime < minIntervalMs) {
      return { ok: false, reason: "min interval" };
    }
    const dailyCount = state.postTimestampsByKind[kind].length;
    const maxPerDay = kind === "trade" ? this.client.config.REDDIT_POSTS_PER_DAY_TRADES : this.client.config.REDDIT_POSTS_PER_DAY_NEWS;
    if (dailyCount >= maxPerDay) {
      return { ok: false, reason: "daily quota" };
    }
    return { ok: true };
  }
  addPostedMarker(kind, hash, thingId) {
    const state = this.loadPostedState();
    const now = nowMs();
    this.prunePostedState(state);
    state.lastPostTime = now;
    state.lastPostedHash = hash;
    state.recentHashes.push(hash);
    if (thingId) state.postedThingIds.push(thingId);
    state.postTimestampsByKind[kind].push(now);
    state.recentHashes = state.recentHashes.slice(-200);
    state.postedThingIds = state.postedThingIds.slice(-1e3);
    this.savePostedState(state);
  }
  moveToDeadLetter(item, reason) {
    const dead = this.loadDeadLetterState();
    dead.items.push({
      ...item,
      reason,
      failedAt: Date.now()
    });
    dead.items = dead.items.slice(-2e3);
    this.saveDeadLetterState(dead);
  }
  async maybeGenerateAutonomousQueueItem() {
    if (this.client.config.REDDIT_READ_ONLY) return;
    const queue = this.loadQueueState();
    const backlogLimit = Math.max(5, Math.floor(this.client.config.REDDIT_MAX_QUEUE_SIZE * 0.2));
    if (queue.items.length >= backlogLimit) return;
    const posted = this.loadPostedState();
    const newsAllowed = this.canPostNow("news", posted).ok;
    const tradeAllowed = this.canPostNow("trade", posted).ok;
    let kind = null;
    if (newsAllowed) {
      kind = "news";
    } else if (tradeAllowed && !this.client.config.REDDIT_REQUIRE_TRADE_APPROVAL) {
      kind = "trade";
    }
    if (!kind) return;
    const target = this.pickTarget(kind);
    const roomId = stringToUuid(`reddit:auto-post:${this.runtime.agentId}`);
    const message = {
      id: stringToUuid(`reddit:auto-post:msg:${Date.now()}`),
      userId: this.runtime.agentId,
      roomId,
      agentId: this.runtime.agentId,
      content: { text: kind, source: "reddit" },
      createdAt: Date.now()
    };
    const state = await this.runtime.composeState(message, {
      topicBucket: kind,
      targetSubreddit: toDisplaySubreddit(target)
    });
    const context = composeContext({
      state,
      template: this.runtime.character.templates?.redditAutonomousPostTemplate || redditAutonomousPostTemplate
    });
    const out = await generateText({
      runtime: this.runtime,
      context,
      modelClass: ModelClass.SMALL
    });
    const parsed = parseJSONObjectFromText(out || "");
    const title = (parsed?.title || "").trim();
    const body = (parsed?.body || "").trim();
    if (!title || !body) return;
    this.enqueue({
      type: kind,
      target,
      content: {
        title: truncate(title, 220),
        body: truncate(body, 3e3)
      },
      approved: kind === "trade" ? this.client.config.REDDIT_TRADE_AUTO_APPROVE : true,
      priority: 0
    });
    elizaLogger.info(`[Reddit] queued autonomous ${kind} post for ${toDisplaySubreddit(target)}`);
  }
  selectNextItem(queue) {
    if (!queue.items.length) return null;
    const sorted = [...queue.items].sort((a, b) => {
      const p = (b.priority || 0) - (a.priority || 0);
      if (p !== 0) return p;
      return a.createdAt - b.createdAt;
    });
    for (const item of sorted) {
      if (item.type === "trade" && this.client.config.REDDIT_REQUIRE_TRADE_APPROVAL && !item.approved) {
        continue;
      }
      return item;
    }
    return null;
  }
  removeQueueItem(queue, id) {
    queue.items = queue.items.filter((item) => item.id !== id);
  }
  hashForItem(item, target) {
    return sha256(`${item.type}::${target}::${item.content.title}::${item.content.body}`);
  }
  async publishQueueItem(item) {
    const posted = this.loadPostedState();
    const quota = this.canPostNow(item.type, posted);
    if (!quota.ok) {
      return false;
    }
    const target = normalizeSubreddit(item.target || this.pickTarget(item.type));
    const postHash = this.hashForItem(item, target);
    if (posted.recentHashes.includes(postHash)) {
      elizaLogger.info(`[Reddit] skip duplicate queued post (${item.id})`);
      return true;
    }
    const text = item.content.imageUrl ? `${item.content.body.trim()}

Image: ${item.content.imageUrl}` : item.content.body;
    const result = await this.client.submitSelfPost({
      subreddit: target,
      title: truncate(item.content.title, 220),
      text: truncate(text, 1e4),
      sendReplies: true
    });
    this.addPostedMarker(item.type, postHash, result.thingId);
    elizaLogger.info(`[Reddit] posted ${item.type} to ${toDisplaySubreddit(target)} id=${result.thingId || "unknown"}`);
    return true;
  }
  async drainQueueOnce() {
    const queue = this.loadQueueState();
    const next = this.selectNextItem(queue);
    if (!next) {
      return;
    }
    try {
      const done = await this.publishQueueItem(next);
      if (!done) return;
      this.removeQueueItem(queue, next.id);
      this.saveQueueState(queue);
    } catch (error) {
      const status = error?.status;
      next.retries += 1;
      if (status === 429 || status >= 500) {
        elizaLogger.warn(
          `[Reddit] queue item delayed by upstream limit/error id=${next.id} retries=${next.retries}`
        );
      } else {
        elizaLogger.warn(`[Reddit] queue item publish error id=${next.id}`, error);
      }
      if (next.retries >= this.client.config.REDDIT_MAX_QUEUE_RETRIES) {
        this.removeQueueItem(queue, next.id);
        this.moveToDeadLetter(next, error?.message || `status=${status || "unknown"}`);
        elizaLogger.warn(`[Reddit] moved item to dead-letter id=${next.id}`);
      } else {
        queue.items = queue.items.map((item) => item.id === next.id ? next : item);
      }
      this.saveQueueState(queue);
      if (error instanceof RedditApiError && error.retryAfterMs) {
        await sleep(error.retryAfterMs);
      }
    }
  }
  async runLoop() {
    const tickMs = this.client.config.REDDIT_POST_POLL_INTERVAL_SEC * 1e3;
    while (this.running) {
      try {
        await this.maybeGenerateAutonomousQueueItem();
        await this.drainQueueOnce();
      } catch (error) {
        elizaLogger.error("[Reddit] post loop tick failed", error);
      }
      await sleep(tickMs);
    }
  }
};

// src/index.ts
var RedditManager = class {
  constructor(runtime, config) {
    this.client = new RedditClient(runtime, config);
    this.post = new RedditPostClient(this.client, runtime);
    this.interaction = new RedditInteractionClient(this.client, runtime);
  }
  enqueuePost(item) {
    this.post.enqueue(item);
  }
  async stop() {
    await this.post.stop();
    await this.interaction.stop();
    this.client.stop();
  }
};
var RedditClientInterface = {
  async start(runtime) {
    const config = await validateRedditConfig(runtime);
    if (!config.REDDIT_ENABLED) {
      elizaLogger.warn("[Reddit] client disabled via REDDIT_ENABLED=false");
      return null;
    }
    const manager = new RedditManager(runtime, config);
    await manager.client.init();
    await manager.post.start();
    await manager.interaction.start();
    elizaLogger.info(
      `[Reddit] client started | posts=${config.REDDIT_ENABLE_POSTS} interactions=${config.REDDIT_ENABLE_INTERACTIONS} dryRun=${config.REDDIT_DRY_RUN} readOnly=${config.REDDIT_READ_ONLY}`
    );
    return manager;
  },
  async stop(runtime) {
    const client = runtime.clients?.reddit;
    if (client?.stop) await client.stop();
  }
};
var index_default = RedditClientInterface;

export { RedditClientInterface, index_default as default, validateRedditConfig };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map