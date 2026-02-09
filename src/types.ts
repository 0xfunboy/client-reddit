import type { UUID } from "@elizaos/core";

export type RedditQueueKind = "news" | "trade";

export type RedditQueueItem = {
  id: string;
  type: RedditQueueKind;
  target?: string;
  content: {
    title: string;
    body: string;
    imageUrl?: string;
  };
  approved?: boolean;
  priority?: number;
  retries: number;
  createdAt: number;
  sourceId?: string;
};

export type RedditQueueState = {
  version: 1;
  items: RedditQueueItem[];
};

export type RedditDeadLetterItem = RedditQueueItem & {
  reason: string;
  failedAt: number;
};

export type RedditDeadLetterState = {
  version: 1;
  items: RedditDeadLetterItem[];
};

export type RedditPostedState = {
  version: 1;
  lastPostTime: number;
  lastPostedHash: string;
  recentHashes: string[];
  postTimestampsByKind: {
    news: number[];
    trade: number[];
  };
  postedThingIds: string[];
};

export type RedditInteractionState = {
  version: 1;
  lastSeenInboxThingId?: string;
  lastSeenCommentTimestampByThread: Record<string, number>;
  processedThingIds: string[];
  processedAtByThingId: Record<string, number>;
  userCooldownByAuthor: Record<string, number>;
  replyTimestamps: number[];
  lastReplyAt: number;
  watchedThreadPermalinks: string[];
  warnedFeatures: Record<string, boolean>;
};

export type RedditListingChild<T> = {
  kind: string;
  data: T;
};

export type RedditListing<T> = {
  kind: "Listing";
  data: {
    after: string | null;
    before: string | null;
    children: RedditListingChild<T>[];
  };
};

export type RedditMe = {
  id: string;
  name: string;
};

export type RedditSubmission = {
  id: string;
  name: string;
  title: string;
  selftext: string;
  subreddit: string;
  permalink: string;
  author: string;
  created_utc: number;
  num_comments?: number;
  score?: number;
};

export type RedditComment = {
  id: string;
  name: string;
  parent_id: string;
  link_id: string;
  body: string;
  author: string;
  subreddit: string;
  permalink: string;
  created_utc: number;
  score?: number;
};

export type RedditInboxItem = {
  id: string;
  name: string;
  author: string;
  subreddit?: string;
  subject?: string;
  body?: string;
  context?: string;
  permalink?: string;
  link_title?: string;
  link_id?: string;
  parent_id?: string;
  created_utc: number;
};

export type RedditCandidate = {
  thingId: string;
  parentThingId: string;
  triggerType: "inbox" | "thread" | "fallback";
  author: string;
  subreddit: string;
  permalink?: string;
  body: string;
  title?: string;
  score?: number;
  createdUtc: number;
  threadId?: string;
};

export type RedditContext = {
  currentPost: string;
  formattedConversation: string;
  parentPostTitle?: string;
  parentPostBody?: string;
  permalink?: string;
};

export type RedditMemoryContext = {
  roomId: UUID;
  userId: UUID;
};
