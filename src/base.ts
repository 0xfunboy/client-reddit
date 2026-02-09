import { type IAgentRuntime, elizaLogger } from "@elizaos/core";
import type {
  RedditComment,
  RedditInboxItem,
  RedditListing,
  RedditMe,
  RedditSubmission,
} from "./types";
import type { RedditConfig } from "./environment";
import { jitterMs, sleep } from "./utils";

type Capability = "inbox" | "submit" | "comment" | "vote" | "history";

type TokenCache = {
  accessToken: string;
  expiresAt: number;
};

class RequestPacer {
  private readonly minGapMs: number;
  private nextAllowedAt = 0;

  constructor(rpm: number) {
    this.minGapMs = Math.max(250, Math.floor(60000 / Math.max(1, rpm)));
  }

  async waitTurn(): Promise<void> {
    const now = Date.now();
    if (this.nextAllowedAt > now) {
      await sleep(this.nextAllowedAt - now);
    }
    this.nextAllowedAt = Math.max(Date.now(), this.nextAllowedAt) + this.minGapMs;
  }

  slowdownForHeader(remaining: number, resetSec: number): void {
    if (!Number.isFinite(remaining) || !Number.isFinite(resetSec)) return;
    if (remaining > 10) return;

    const perRequestMs = Math.ceil((Math.max(1, resetSec) * 1000) / Math.max(1, remaining));
    this.nextAllowedAt = Math.max(this.nextAllowedAt, Date.now() + perRequestMs);
  }

  applyRetryAfter(delayMs: number): void {
    this.nextAllowedAt = Math.max(this.nextAllowedAt, Date.now() + Math.max(500, delayMs));
  }
}

export class RedditApiError extends Error {
  status?: number;
  data?: unknown;
  retryAfterMs?: number;

  constructor(message: string, status?: number, data?: unknown, retryAfterMs?: number) {
    super(message);
    this.name = "RedditApiError";
    this.status = status;
    this.data = data;
    this.retryAfterMs = retryAfterMs;
  }
}

function parseRetryAfterMs(value: string | null): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return Math.floor(seconds * 1000);

  const epochMs = Date.parse(value);
  if (!Number.isNaN(epochMs)) return Math.max(0, epochMs - Date.now());
  return 0;
}

function asListing<T>(value: any): RedditListing<T> {
  if (!value || value.kind !== "Listing") {
    throw new Error("Unexpected Reddit listing response shape");
  }
  return value as RedditListing<T>;
}

export class RedditClient {
  runtime: IAgentRuntime;
  config: RedditConfig;

  private tokenCache: TokenCache | null = null;
  private tokenPromise: Promise<string> | null = null;
  private pacer: RequestPacer;

  private warnedScopes = new Set<string>();
  private capabilityEnabled: Record<Capability, boolean> = {
    inbox: true,
    submit: true,
    comment: true,
    vote: false,
    history: true,
  };

  profile: RedditMe | null = null;

  constructor(runtime: IAgentRuntime, config: RedditConfig) {
    this.runtime = runtime;
    this.config = config;
    this.pacer = new RequestPacer(config.REDDIT_RPM);

    this.capabilityEnabled.vote = config.REDDIT_ENABLE_UPVOTE;
  }

  async init(): Promise<void> {
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

  stop(): void {
    // loops are managed by post/interactions modules.
  }

  isCapabilityEnabled(capability: Capability): boolean {
    return this.capabilityEnabled[capability];
  }

  disableCapability(capability: Capability, reason: string): void {
    if (!this.capabilityEnabled[capability]) return;
    this.capabilityEnabled[capability] = false;
    elizaLogger.warn(`[Reddit] disabling ${capability}: ${reason}`);
  }

  private warnScopeOnce(scope: string, feature: Capability): void {
    const key = `${scope}:${feature}`;
    if (this.warnedScopes.has(key)) return;
    this.warnedScopes.add(key);
    this.disableCapability(feature, `missing scope '${scope}'`);
  }

  private maybeDisableFeatureByPath(path: string, responseData: any): void {
    const msg = `${responseData?.message || ""} ${responseData?.error || ""}`.toLowerCase();
    const isScopeError = msg.includes("scope") || msg.includes("insufficient");
    if (!isScopeError) return;

    if (path.startsWith("/message/")) this.warnScopeOnce("privatemessages", "inbox");
    if (path.startsWith("/user/")) this.warnScopeOnce("history", "history");
    if (path === "/api/submit") this.warnScopeOnce("submit", "submit");
    if (path === "/api/comment") this.warnScopeOnce("read+submit", "comment");
    if (path === "/api/vote") this.warnScopeOnce("vote", "vote");
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt > now + 10_000) {
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
          "User-Agent": this.config.REDDIT_USER_AGENT_RESOLVED,
        },
        body: body.toString(),
      });

      const payload = (await response.json()) as {
        access_token?: string;
        expires_in?: number;
        error?: string;
        error_description?: string;
      };

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
        expiresAt: Date.now() + (expiresInSec - 30) * 1000,
      };

      return payload.access_token;
    })();

    try {
      return await this.tokenPromise;
    } finally {
      this.tokenPromise = null;
    }
  }

  private async withRetry<T>(path: string, action: () => Promise<T>): Promise<T> {
    const maxAttempts = 6;
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        return await action();
      } catch (error: any) {
        lastError = error;
        const status = error?.status;
        const retryAfterMs = Number(error?.retryAfterMs || 0);

        if (status === 401 && attempt < maxAttempts - 1) {
          this.tokenCache = null;
          continue;
        }

        if ((status === 429 || (status >= 500 && status < 600)) && attempt < maxAttempts - 1) {
          const exponential = Math.min(
            this.config.REDDIT_BACKOFF_MAX_MS,
            this.config.REDDIT_BACKOFF_BASE_MS * 2 ** attempt
          );
          const waitMs = retryAfterMs > 0 ? retryAfterMs : jitterMs(exponential);
          this.pacer.applyRetryAfter(waitMs);
          elizaLogger.warn(
            `[Reddit] request retry for ${path} status=${status} attempt=${attempt + 1}/${maxAttempts} wait=${waitMs}ms`
          );
          await sleep(waitMs);
          continue;
        }

        throw error;
      }
    }

    throw lastError;
  }

  async request<T = any>(
    path: string,
    opts?: {
      method?: "GET" | "POST";
      query?: Record<string, string | number | boolean | undefined>;
      form?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
      allowWithoutAuth?: boolean;
    }
  ): Promise<T> {
    const method = opts?.method || "GET";

    return this.withRetry(path, async () => {
      await this.pacer.waitTurn();

      const accessToken = opts?.allowWithoutAuth ? "" : await this.getAccessToken();

      const url = new URL(
        path.startsWith("http") ? path : `https://oauth.reddit.com${path}`
      );

      if (opts?.query) {
        for (const [key, value] of Object.entries(opts.query)) {
          if (value == null) continue;
          url.searchParams.set(key, String(value));
        }
      }

      const headers = new Headers({
        "User-Agent": this.config.REDDIT_USER_AGENT_RESOLVED,
        Accept: "application/json",
      });

      if (!opts?.allowWithoutAuth) {
        headers.set("Authorization", `Bearer ${accessToken}`);
      }

      let body: BodyInit | undefined;
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
        body,
      });

      const remaining = Number(response.headers.get("x-ratelimit-remaining") || NaN);
      const reset = Number(response.headers.get("x-ratelimit-reset") || NaN);
      this.pacer.slowdownForHeader(remaining, reset);

      const text = await response.text();
      const payload = text ? safeJsonParse(text) : null;

      if (!response.ok) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
        this.maybeDisableFeatureByPath(path, payload);
        throw new RedditApiError(
          payload?.message || payload?.error || `Reddit request failed (${response.status})`,
          response.status,
          payload,
          retryAfterMs
        );
      }

      return payload as T;
    });
  }

  private canWrite(capability: Capability): boolean {
    if (!this.capabilityEnabled[capability]) return false;
    if (this.config.REDDIT_READ_ONLY) return false;
    return true;
  }

  async getMe(): Promise<RedditMe> {
    return this.request<RedditMe>("/api/v1/me", { method: "GET" });
  }

  async getInbox(limit = 25, after?: string): Promise<{ items: RedditInboxItem[]; after?: string }> {
    if (!this.isCapabilityEnabled("inbox")) return { items: [] };

    const listing = asListing<RedditInboxItem>(
      await this.request("/message/inbox", {
        method: "GET",
        query: { limit: Math.min(Math.max(limit, 1), 100), after },
      })
    );

    return {
      items: listing.data.children.map((c) => c.data),
      after: listing.data.after || undefined,
    };
  }

  async markMessagesRead(ids: string[]): Promise<void> {
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
        id: ids.join(","),
      },
    });
  }

  async getUserSubmitted(username: string, limit = 25): Promise<RedditSubmission[]> {
    if (!this.isCapabilityEnabled("history")) return [];
    const listing = asListing<RedditSubmission>(
      await this.request(`/user/${encodeURIComponent(username)}/submitted`, {
        method: "GET",
        query: { limit: Math.min(Math.max(limit, 1), 100) },
      })
    );

    return listing.data.children.map((c) => c.data);
  }

  async getUserComments(username: string, limit = 25): Promise<RedditComment[]> {
    if (!this.isCapabilityEnabled("history")) return [];
    const listing = asListing<RedditComment>(
      await this.request(`/user/${encodeURIComponent(username)}/comments`, {
        method: "GET",
        query: { limit: Math.min(Math.max(limit, 1), 100) },
      })
    );

    return listing.data.children.map((c) => c.data);
  }

  async getCommentsByPermalink(permalink: string, limit = 100): Promise<RedditComment[]> {
    const clean = permalink.replace(/\.json$/i, "");
    const payload = (await this.request(`${clean}.json`, {
      method: "GET",
      query: { limit },
    })) as RedditListing<any>[];

    if (!Array.isArray(payload) || payload.length < 2) return [];
    const commentsListing = asListing<RedditComment>(payload[1]);
    return commentsListing.data.children
      .map((child) => child.data)
      .filter((item) => item && typeof item.id === "string");
  }

  async submitSelfPost(input: {
    subreddit: string;
    title: string;
    text: string;
    sendReplies?: boolean;
  }): Promise<{ thingId?: string; url?: string }> {
    if (!this.canWrite("submit")) {
      throw new RedditApiError("posting disabled by config/scope", 403);
    }
    if (this.config.REDDIT_DRY_RUN) {
      elizaLogger.info(
        `[Reddit][DRY_RUN] would submit post to r/${input.subreddit} title="${input.title}"`
      );
      return { thingId: "t3_dryrun", url: "https://reddit.com" };
    }

    const payload = (await this.request("/api/submit", {
      method: "POST",
      form: {
        api_type: "json",
        sr: input.subreddit,
        kind: "self",
        title: input.title,
        text: input.text,
        resubmit: false,
        send_replies: input.sendReplies ?? true,
      },
    })) as any;

    const things = payload?.json?.data?.things as Array<{ id: string; data?: { url?: string } }>;
    const first = Array.isArray(things) ? things[0] : undefined;
    return {
      thingId: first?.id,
      url: first?.data?.url,
    };
  }

  async commentReply(parentThingId: string, text: string): Promise<{ thingId?: string }> {
    if (!this.canWrite("comment")) {
      throw new RedditApiError("commenting disabled by config/scope", 403);
    }
    if (this.config.REDDIT_DRY_RUN) {
      elizaLogger.info(`[Reddit][DRY_RUN] would comment reply to ${parentThingId}: ${text.slice(0, 120)}`);
      return { thingId: "t1_dryrun" };
    }

    const payload = (await this.request("/api/comment", {
      method: "POST",
      form: {
        api_type: "json",
        thing_id: parentThingId,
        text,
      },
    })) as any;

    const things = payload?.json?.data?.things as Array<{ data?: { name?: string } }>;
    const id = things?.[0]?.data?.name;
    return { thingId: id };
  }

  async upvote(thingId: string): Promise<void> {
    if (!this.canWrite("vote")) return;
    if (this.config.REDDIT_DRY_RUN) {
      elizaLogger.info(`[Reddit][DRY_RUN] would upvote ${thingId}`);
      return;
    }

    await this.request("/api/vote", {
      method: "POST",
      form: {
        id: thingId,
        dir: 1,
      },
    });
  }
}

function safeJsonParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
