import {
  composeContext,
  generateMessageResponse,
  generateShouldRespond,
  getEmbeddingZeroVector,
  type Content,
  type IAgentRuntime,
  type Memory,
  ModelClass,
  stringToUuid,
  elizaLogger,
} from "@elizaos/core";
import { RedditApiError, RedditClient } from "./base";
import { redditMessageHandlerTemplate, redditShouldRespondTemplate } from "./templates";
import type {
  RedditCandidate,
  RedditComment,
  RedditContext,
  RedditInboxItem,
  RedditInteractionState,
  RedditListing,
  RedditSubmission,
} from "./types";
import {
  isLikelyBot,
  isLikelySpam,
  normalizeSubreddit,
  nowMs,
  readJsonFile,
  resolveRuntimeDataDir,
  sleep,
  truncate,
  writeJsonFile,
} from "./utils";

const defaultState: RedditInteractionState = {
  version: 1,
  lastSeenInboxThingId: undefined,
  lastSeenCommentTimestampByThread: {},
  processedThingIds: [],
  processedAtByThingId: {},
  userCooldownByAuthor: {},
  replyTimestamps: [],
  lastReplyAt: 0,
  watchedThreadPermalinks: [],
  warnedFeatures: {},
};

export class RedditInteractionClient {
  private client: RedditClient;
  private runtime: IAgentRuntime;
  private running = false;
  private loopPromise: Promise<void> | null = null;

  private stateFile: string;

  constructor(client: RedditClient, runtime: IAgentRuntime) {
    this.client = client;
    this.runtime = runtime;

    const baseDir = resolveRuntimeDataDir(runtime);
    this.stateFile = `${baseDir}/interactions-state.json`;
  }

  async start(): Promise<void> {
    if (!this.client.config.REDDIT_ENABLE_INTERACTIONS) {
      elizaLogger.warn("[Reddit] interactions loop disabled via REDDIT_ENABLE_INTERACTIONS=false");
      return;
    }

    this.running = true;
    this.loadState();
    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = null;
    }
  }

  private loadState(): RedditInteractionState {
    return readJsonFile(this.stateFile, defaultState);
  }

  private saveState(state: RedditInteractionState): void {
    writeJsonFile(this.stateFile, state);
  }

  private pruneState(state: RedditInteractionState): void {
    const maxIds = this.client.config.REDDIT_MAX_PROCESSED_IDS;
    const cutoff = nowMs() - 7 * 24 * 60 * 60 * 1000;

    state.processedThingIds = state.processedThingIds.filter((id) => (state.processedAtByThingId[id] || 0) >= cutoff);
    state.processedThingIds = state.processedThingIds.slice(-maxIds);

    const keep = new Set(state.processedThingIds);
    for (const key of Object.keys(state.processedAtByThingId)) {
      if (!keep.has(key)) delete state.processedAtByThingId[key];
    }

    state.replyTimestamps = state.replyTimestamps.filter((ts) => ts >= nowMs() - 24 * 60 * 60 * 1000);

    for (const author of Object.keys(state.userCooldownByAuthor)) {
      if (state.userCooldownByAuthor[author] < nowMs() - 24 * 60 * 60 * 1000) {
        delete state.userCooldownByAuthor[author];
      }
    }

    state.watchedThreadPermalinks = Array.from(new Set(state.watchedThreadPermalinks)).slice(-500);
  }

  private alreadyProcessed(state: RedditInteractionState, thingId: string): boolean {
    return Boolean(state.processedAtByThingId[thingId]);
  }

  private markProcessed(state: RedditInteractionState, thingId: string): void {
    state.processedAtByThingId[thingId] = nowMs();
    state.processedThingIds.push(thingId);
    state.processedThingIds = Array.from(new Set(state.processedThingIds));
    if (state.processedThingIds.length > this.client.config.REDDIT_MAX_PROCESSED_IDS) {
      state.processedThingIds = state.processedThingIds.slice(-this.client.config.REDDIT_MAX_PROCESSED_IDS);
    }
  }

  private canReplyNow(state: RedditInteractionState, author: string): boolean {
    const now = nowMs();

    if (state.replyTimestamps.length >= this.client.config.REDDIT_REPLIES_PER_DAY) return false;

    const minInterval = this.client.config.REDDIT_REPLY_MIN_INTERVAL_SEC * 1000;
    if (state.lastReplyAt > 0 && now - state.lastReplyAt < minInterval) return false;

    const cooldownMinutes = this.client.config.REDDIT_USER_COOLDOWN_MINUTES;
    const userLast = state.userCooldownByAuthor[author.toLowerCase()] || 0;
    if (now - userLast < cooldownMinutes * 60 * 1000) return false;

    return true;
  }

  private trackReply(state: RedditInteractionState, author: string): void {
    const now = nowMs();
    state.lastReplyAt = now;
    state.replyTimestamps.push(now);
    state.userCooldownByAuthor[author.toLowerCase()] = now;
  }

  private isCandidateIgnored(candidate: RedditCandidate): boolean {
    if (!candidate.author || candidate.author === "[deleted]") return true;
    if (isLikelyBot(candidate.author)) return true;
    if (isLikelySpam(candidate.body || "")) return true;

    const me = this.client.profile?.name?.toLowerCase();
    if (me && candidate.author.toLowerCase() === me) return true;

    return false;
  }

  private maybeWarnOnce(state: RedditInteractionState, key: string, message: string): void {
    if (state.warnedFeatures[key]) return;
    state.warnedFeatures[key] = true;
    elizaLogger.warn(message);
  }

  private async collectInboxCandidates(state: RedditInteractionState): Promise<{ candidates: RedditCandidate[]; seenInboxIds: string[] }> {
    const candidates: RedditCandidate[] = [];
    const seenInboxIds: string[] = [];

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
        const parentThingId = item.name.startsWith("t1_") || item.name.startsWith("t3_")
          ? item.name
          : item.parent_id || item.link_id || item.name;

        candidates.push({
          thingId,
          parentThingId,
          triggerType: "inbox",
          author: item.author,
          subreddit: normalizeSubreddit(item.subreddit || ""),
          permalink: item.context || item.permalink,
          body: item.body || "",
          title: item.link_title,
          score: undefined,
          createdUtc: item.created_utc,
          threadId: item.link_id,
        });

        seenInboxIds.push(item.name);
      }

      if (inbox.items[0]?.name) {
        state.lastSeenInboxThingId = inbox.items[0].name;
      }
    } catch (error: any) {
      if (error?.status === 403) {
        this.maybeWarnOnce(state, "inbox-403", "[Reddit] inbox polling returned 403; disabling inbox feature");
        this.client.disableCapability("inbox", "403 from inbox endpoint");
      } else {
        elizaLogger.warn("[Reddit] inbox poll failed", error);
      }
    }

    return { candidates, seenInboxIds };
  }

  private mapInboxType(item: RedditInboxItem): "reply" | "mention" | null {
    const subject = (item.subject || "").toLowerCase();
    if (subject.includes("comment reply") || subject.includes("post reply")) return "reply";
    if (subject.includes("username mention") || subject.includes("mention")) return "mention";
    return null;
  }

  private async collectOwnThreadCandidates(state: RedditInteractionState): Promise<RedditCandidate[]> {
    const out: RedditCandidate[] = [];
    const username = this.client.profile?.name || this.client.config.REDDIT_USERNAME;

    let mySubmissions: RedditSubmission[] = [];
    let myComments: RedditComment[] = [];

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
          const created = Math.floor(c.created_utc * 1000);
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
            threadId: submission.name,
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
            title: undefined,
            score: c.score,
            createdUtc: c.created_utc,
            threadId: c.link_id,
          });
        }
      } catch {
        // ignore noisy failures on optional fallback scans
      }
    }

    // Optional watched subreddit scans.
    for (const subreddit of this.client.config.REDDIT_WATCHED_SUBREDDITS) {
      try {
        const listing = asListing<RedditComment>(
          await this.client.request(`/r/${encodeURIComponent(subreddit)}/comments`, {
            method: "GET",
            query: { limit: 20 },
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
            threadId: c.link_id,
          });
        }
      } catch (error) {
        elizaLogger.warn(`[Reddit] watched subreddit scan failed for r/${subreddit}`, error);
      }
    }

    return out;
  }

  private async buildContext(candidate: RedditCandidate): Promise<RedditContext> {
    if (!candidate.permalink) {
      return {
        currentPost: candidate.body,
        formattedConversation: candidate.body,
        parentPostTitle: candidate.title,
      };
    }

    try {
      const comments = await this.client.getCommentsByPermalink(candidate.permalink, 100);
      const byName = new Map<string, RedditComment>();
      for (const c of comments) byName.set(c.name, c);

      const current = byName.get(candidate.thingId) || comments.find((c) => c.name === candidate.thingId);
      const parent = current ? byName.get(current.parent_id) : undefined;
      const grandParent = parent ? byName.get(parent.parent_id) : undefined;

      const formattedConversation = [
        grandParent ? `Parent-2 (${grandParent.author}): ${grandParent.body}` : "",
        parent ? `Parent-1 (${parent.author}): ${parent.body}` : "",
        `Current (${candidate.author}): ${current?.body || candidate.body}`,
      ]
        .filter(Boolean)
        .join("\n\n");

      return {
        currentPost: current?.body || candidate.body,
        formattedConversation,
        parentPostTitle: candidate.title,
        permalink: candidate.permalink,
      };
    } catch {
      return {
        currentPost: candidate.body,
        formattedConversation: candidate.body,
        parentPostTitle: candidate.title,
        permalink: candidate.permalink,
      };
    }
  }

  private async ensureConnection(candidate: RedditCandidate): Promise<{ roomId: string; userId: string }> {
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

  private async generateReplyText(candidate: RedditCandidate, context: RedditContext): Promise<Content | null> {
    const { roomId, userId } = await this.ensureConnection(candidate);

    const incomingMemory: Memory = {
      id: stringToUuid(`reddit:incoming:${candidate.thingId}:${this.runtime.agentId}`),
      userId,
      roomId,
      agentId: this.runtime.agentId,
      content: {
        text: context.currentPost,
        source: "reddit",
        url: context.permalink,
      },
      embedding: getEmbeddingZeroVector(),
      createdAt: Math.floor(candidate.createdUtc * 1000),
    } as Memory;

    await this.runtime.messageManager.createMemory(incomingMemory);

    const state = await this.runtime.composeState(incomingMemory, {
      currentPost: context.currentPost,
      formattedConversation: context.formattedConversation,
      redditUserName: this.client.profile?.name || this.client.config.REDDIT_USERNAME,
    });

    const shouldContext = composeContext({
      state,
      template:
        this.runtime.character.templates?.redditShouldRespondTemplate ||
        redditShouldRespondTemplate,
    });

    const should = await generateShouldRespond({
      runtime: this.runtime,
      context: shouldContext,
      modelClass: ModelClass.SMALL,
    });

    if (should !== "RESPOND") return null;

    const messageContext = composeContext({
      state,
      template:
        this.runtime.character.templates?.redditMessageHandlerTemplate ||
        redditMessageHandlerTemplate,
    });

    const response = await generateMessageResponse({
      runtime: this.runtime,
      context: messageContext,
      modelClass: ModelClass.MEDIUM,
    });

    return response as Content;
  }

  private async maybeReply(state: RedditInteractionState, candidate: RedditCandidate): Promise<"replied" | "ignored" | "defer"> {
    if (!this.canReplyNow(state, candidate.author)) return "defer";

    const context = await this.buildContext(candidate);
    const content = await this.generateReplyText(candidate, context);
    const text = truncate((content?.text || "").trim(), 9500);

    if (!text) return "ignored";

    try {
      await this.client.commentReply(candidate.parentThingId, text);
      this.trackReply(state, candidate.author);

      if (
        this.client.config.REDDIT_ENABLE_UPVOTE &&
        typeof candidate.score === "number" &&
        candidate.score >= this.client.config.REDDIT_UPVOTE_MIN_SCORE
      ) {
        await this.client.upvote(candidate.thingId);
      }

      return "replied";
    } catch (error: any) {
      if (error instanceof RedditApiError && error.status === 403) {
        this.client.disableCapability("comment", "403 from /api/comment");
      }
      throw error;
    }
  }

  private uniqueCandidates(candidates: RedditCandidate[]): RedditCandidate[] {
    const map = new Map<string, RedditCandidate>();
    for (const candidate of candidates) {
      if (!candidate.thingId) continue;
      const prev = map.get(candidate.thingId);
      if (!prev || candidate.createdUtc > prev.createdUtc) {
        map.set(candidate.thingId, candidate);
      }
    }

    return [...map.values()].sort((a, b) => a.createdUtc - b.createdUtc);
  }

  private async tick(): Promise<void> {
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

  private async runLoop(): Promise<void> {
    const delayMs = this.client.config.REDDIT_INTERACTION_POLL_INTERVAL_SEC * 1000;

    while (this.running) {
      try {
        await this.tick();
      } catch (error) {
        elizaLogger.error("[Reddit] interactions loop error", error);
      }

      await sleep(delayMs);
    }
  }
}

function asListing<T>(value: any): RedditListing<T> {
  if (!value || value.kind !== "Listing") {
    throw new Error("Unexpected listing shape");
  }
  return value as RedditListing<T>;
}
