import { parseBooleanFromText, type IAgentRuntime } from "@elizaos/core";
import { z, ZodError } from "zod";
import { normalizeSubreddit } from "./utils";

const toBool = (v?: string | null, def = false) => parseBooleanFromText(v ?? "") ?? def;
const toInt = (v: string | undefined | null, def: number) => {
  if (!v) return def;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? def : n;
};
const toList = (v?: string | null) =>
  (v ?? "")
    .split(",")
    .map((x) => normalizeSubreddit(x))
    .filter(Boolean);

function getSetting(runtime: IAgentRuntime, key: string): string | undefined {
  return runtime.getSetting(key) || process.env[key];
}

export const redditEnvSchema = z.object({
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
  REDDIT_BACKOFF_BASE_MS: z.number().int().min(250).default(2000),
  REDDIT_BACKOFF_MAX_MS: z.number().int().min(1000).default(60000),

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
  REDDIT_MAX_PROCESSED_IDS: z.number().int().min(100).default(5000),
  REDDIT_MAX_QUEUE_SIZE: z.number().int().min(20).default(500),
  REDDIT_MAX_QUEUE_RETRIES: z.number().int().min(1).default(8),

  REDDIT_ENABLE_UPVOTE: z.boolean().default(false),
  REDDIT_UPVOTE_MIN_SCORE: z.number().int().default(5),

  REDDIT_REQUIRE_TRADE_APPROVAL: z.boolean().default(true),
  REDDIT_TRADE_AUTO_APPROVE: z.boolean().default(false),
  REDDIT_DEBUG_AUTH: z.boolean().default(false),
});

export type RedditConfig = z.infer<typeof redditEnvSchema> & {
  REDDIT_USER_AGENT_RESOLVED: string;
};

export async function validateRedditConfig(runtime: IAgentRuntime): Promise<RedditConfig> {
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
      REDDIT_BACKOFF_BASE_MS: toInt(getSetting(runtime, "REDDIT_BACKOFF_BASE_MS"), 2000),
      REDDIT_BACKOFF_MAX_MS: toInt(getSetting(runtime, "REDDIT_BACKOFF_MAX_MS"), 60000),

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
      REDDIT_MAX_PROCESSED_IDS: toInt(getSetting(runtime, "REDDIT_MAX_PROCESSED_IDS"), 5000),
      REDDIT_MAX_QUEUE_SIZE: toInt(getSetting(runtime, "REDDIT_MAX_QUEUE_SIZE"), 500),
      REDDIT_MAX_QUEUE_RETRIES: toInt(getSetting(runtime, "REDDIT_MAX_QUEUE_RETRIES"), 8),

      REDDIT_ENABLE_UPVOTE: toBool(getSetting(runtime, "REDDIT_ENABLE_UPVOTE"), false),
      REDDIT_UPVOTE_MIN_SCORE: toInt(getSetting(runtime, "REDDIT_UPVOTE_MIN_SCORE"), 5),

      REDDIT_REQUIRE_TRADE_APPROVAL: toBool(getSetting(runtime, "REDDIT_REQUIRE_TRADE_APPROVAL"), true),
      REDDIT_TRADE_AUTO_APPROVE: toBool(getSetting(runtime, "REDDIT_TRADE_AUTO_APPROVE"), false),
      REDDIT_DEBUG_AUTH: toBool(getSetting(runtime, "REDDIT_DEBUG_AUTH"), false),
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
      REDDIT_USER_AGENT_RESOLVED,
    };
  } catch (error) {
    if (error instanceof ZodError) {
      const details = error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("\n");
      throw new Error(`Reddit configuration validation failed:\n${details}`);
    }
    throw error;
  }
}
