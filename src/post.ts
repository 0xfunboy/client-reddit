import {
  composeContext,
  elizaLogger,
  generateText,
  ModelClass,
  parseJSONObjectFromText,
  stringToUuid,
  type IAgentRuntime,
} from "@elizaos/core";
import { RedditClient, RedditApiError } from "./base";
import { redditAutonomousPostTemplate } from "./templates";
import type {
  RedditDeadLetterState,
  RedditPostedState,
  RedditQueueItem,
  RedditQueueKind,
  RedditQueueState,
} from "./types";
import {
  normalizeSubreddit,
  nowMs,
  readJsonFile,
  resolveRuntimeDataDir,
  sha256,
  sleep,
  toDisplaySubreddit,
  truncate,
  writeJsonFile,
} from "./utils";

const defaultQueueState: RedditQueueState = { version: 1, items: [] };
const defaultDeadLetter: RedditDeadLetterState = { version: 1, items: [] };
const defaultPostedState: RedditPostedState = {
  version: 1,
  lastPostTime: 0,
  lastPostedHash: "",
  recentHashes: [],
  postTimestampsByKind: {
    news: [],
    trade: [],
  },
  postedThingIds: [],
};

export class RedditPostClient {
  private client: RedditClient;
  private runtime: IAgentRuntime;
  private running = false;

  private queueFile: string;
  private deadLetterFile: string;
  private postedStateFile: string;
  private postLoopPromise: Promise<void> | null = null;

  constructor(client: RedditClient, runtime: IAgentRuntime) {
    this.client = client;
    this.runtime = runtime;

    const baseDir = resolveRuntimeDataDir(runtime);
    this.queueFile = `${baseDir}/post-queue.json`;
    this.deadLetterFile = `${baseDir}/dead-letter.json`;
    this.postedStateFile = `${baseDir}/posted-state.json`;
  }

  async start(): Promise<void> {
    if (!this.client.config.REDDIT_ENABLE_POSTS) {
      elizaLogger.warn("[Reddit] post loop disabled via REDDIT_ENABLE_POSTS=false");
      return;
    }

    this.running = true;
    this.ensureStateFiles();

    this.postLoopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.postLoopPromise) {
      await this.postLoopPromise;
      this.postLoopPromise = null;
    }
  }

  enqueue(item: Omit<RedditQueueItem, "id" | "retries" | "createdAt">): void {
    const state = this.loadQueueState();

    if (state.items.length >= this.client.config.REDDIT_MAX_QUEUE_SIZE) {
      // Prefer dropping oldest low-priority item.
      state.items.sort((a, b) => (a.priority || 0) - (b.priority || 0) || a.createdAt - b.createdAt);
      state.items.shift();
    }

    const queueItem: RedditQueueItem = {
      ...item,
      target: normalizeSubreddit(item.target || ""),
      id: `reddit:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
      retries: 0,
      createdAt: Date.now(),
      priority: item.priority ?? 0,
    };

    state.items.push(queueItem);
    this.saveQueueState(state);
  }

  private ensureStateFiles(): void {
    readJsonFile(this.queueFile, defaultQueueState);
    readJsonFile(this.deadLetterFile, defaultDeadLetter);
    readJsonFile(this.postedStateFile, defaultPostedState);
  }

  private loadQueueState(): RedditQueueState {
    return readJsonFile(this.queueFile, defaultQueueState);
  }

  private saveQueueState(state: RedditQueueState): void {
    writeJsonFile(this.queueFile, state);
  }

  private loadDeadLetterState(): RedditDeadLetterState {
    return readJsonFile(this.deadLetterFile, defaultDeadLetter);
  }

  private saveDeadLetterState(state: RedditDeadLetterState): void {
    writeJsonFile(this.deadLetterFile, state);
  }

  private loadPostedState(): RedditPostedState {
    return readJsonFile(this.postedStateFile, defaultPostedState);
  }

  private savePostedState(state: RedditPostedState): void {
    writeJsonFile(this.postedStateFile, state);
  }

  private pickTarget(kind: RedditQueueKind): string {
    const source =
      kind === "trade"
        ? this.client.config.REDDIT_SUBREDDITS_TRADES
        : this.client.config.REDDIT_SUBREDDITS_NEWS;

    const fallback = normalizeSubreddit(this.client.config.REDDIT_DEFAULT_SUBREDDIT);
    const options = source.length > 0 ? source : fallback ? [fallback] : [];
    if (options.length === 0) return "general";

    const idx = Math.floor(Math.random() * options.length);
    return normalizeSubreddit(options[idx] || fallback || "general");
  }

  private prunePostedState(state: RedditPostedState): void {
    const dayAgo = nowMs() - 24 * 60 * 60 * 1000;
    state.postTimestampsByKind.news = state.postTimestampsByKind.news.filter((ts) => ts >= dayAgo);
    state.postTimestampsByKind.trade = state.postTimestampsByKind.trade.filter((ts) => ts >= dayAgo);
    state.recentHashes = state.recentHashes.slice(-200);
    state.postedThingIds = state.postedThingIds.slice(-1000);
  }

  private canPostNow(kind: RedditQueueKind, state: RedditPostedState): { ok: boolean; reason?: string } {
    const now = nowMs();
    this.prunePostedState(state);

    const minIntervalMs = this.client.config.REDDIT_POST_MIN_INTERVAL_SEC * 1000;
    if (state.lastPostTime && now - state.lastPostTime < minIntervalMs) {
      return { ok: false, reason: "min interval" };
    }

    const dailyCount = state.postTimestampsByKind[kind].length;
    const maxPerDay =
      kind === "trade"
        ? this.client.config.REDDIT_POSTS_PER_DAY_TRADES
        : this.client.config.REDDIT_POSTS_PER_DAY_NEWS;

    if (dailyCount >= maxPerDay) {
      return { ok: false, reason: "daily quota" };
    }

    return { ok: true };
  }

  private addPostedMarker(kind: RedditQueueKind, hash: string, thingId?: string): void {
    const state = this.loadPostedState();
    const now = nowMs();

    this.prunePostedState(state);
    state.lastPostTime = now;
    state.lastPostedHash = hash;
    state.recentHashes.push(hash);
    if (thingId) state.postedThingIds.push(thingId);
    state.postTimestampsByKind[kind].push(now);

    state.recentHashes = state.recentHashes.slice(-200);
    state.postedThingIds = state.postedThingIds.slice(-1000);

    this.savePostedState(state);
  }

  private moveToDeadLetter(item: RedditQueueItem, reason: string): void {
    const dead = this.loadDeadLetterState();
    dead.items.push({
      ...item,
      reason,
      failedAt: Date.now(),
    });
    dead.items = dead.items.slice(-2000);
    this.saveDeadLetterState(dead);
  }

  private async maybeGenerateAutonomousQueueItem(): Promise<void> {
    if (this.client.config.REDDIT_READ_ONLY) return;

    const queue = this.loadQueueState();
    const backlogLimit = Math.max(5, Math.floor(this.client.config.REDDIT_MAX_QUEUE_SIZE * 0.2));
    if (queue.items.length >= backlogLimit) return;

    const posted = this.loadPostedState();
    const newsAllowed = this.canPostNow("news", posted).ok;
    const tradeAllowed = this.canPostNow("trade", posted).ok;

    let kind: RedditQueueKind | null = null;
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
      createdAt: Date.now(),
    } as any;

    const state = await this.runtime.composeState(message, {
      topicBucket: kind,
      targetSubreddit: toDisplaySubreddit(target),
    });

    const context = composeContext({
      state,
      template:
        this.runtime.character.templates?.redditAutonomousPostTemplate ||
        redditAutonomousPostTemplate,
    });

    const out = await generateText({
      runtime: this.runtime,
      context,
      modelClass: ModelClass.SMALL,
    });

    const parsed = parseJSONObjectFromText(out || "") as { title?: string; body?: string } | null;
    const title = (parsed?.title || "").trim();
    const body = (parsed?.body || "").trim();
    if (!title || !body) return;

    this.enqueue({
      type: kind,
      target,
      content: {
        title: truncate(title, 220),
        body: truncate(body, 3000),
      },
      approved: kind === "trade" ? this.client.config.REDDIT_TRADE_AUTO_APPROVE : true,
      priority: 0,
    });

    elizaLogger.info(`[Reddit] queued autonomous ${kind} post for ${toDisplaySubreddit(target)}`);
  }

  private selectNextItem(queue: RedditQueueState): RedditQueueItem | null {
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

  private removeQueueItem(queue: RedditQueueState, id: string): void {
    queue.items = queue.items.filter((item) => item.id !== id);
  }

  private hashForItem(item: RedditQueueItem, target: string): string {
    return sha256(`${item.type}::${target}::${item.content.title}::${item.content.body}`);
  }

  private async publishQueueItem(item: RedditQueueItem): Promise<boolean> {
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

    const text = item.content.imageUrl
      ? `${item.content.body.trim()}\n\nImage: ${item.content.imageUrl}`
      : item.content.body;

    const result = await this.client.submitSelfPost({
      subreddit: target,
      title: truncate(item.content.title, 220),
      text: truncate(text, 10000),
      sendReplies: true,
    });

    this.addPostedMarker(item.type, postHash, result.thingId);
    elizaLogger.info(`[Reddit] posted ${item.type} to ${toDisplaySubreddit(target)} id=${result.thingId || "unknown"}`);
    return true;
  }

  private async drainQueueOnce(): Promise<void> {
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
    } catch (error: any) {
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
        queue.items = queue.items.map((item) => (item.id === next.id ? next : item));
      }

      this.saveQueueState(queue);

      if (error instanceof RedditApiError && error.retryAfterMs) {
        await sleep(error.retryAfterMs);
      }
    }
  }

  private async runLoop(): Promise<void> {
    const tickMs = this.client.config.REDDIT_POST_POLL_INTERVAL_SEC * 1000;

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
}
