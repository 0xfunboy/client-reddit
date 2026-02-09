import { type Client, type IAgentRuntime, elizaLogger } from "@elizaos/core";
import { RedditClient } from "./base";
import { validateRedditConfig } from "./environment";
import { RedditInteractionClient } from "./interactions";
import { RedditPostClient } from "./post";
import type { RedditQueueItem } from "./types";

class RedditManager {
  client: RedditClient;
  post: RedditPostClient;
  interaction: RedditInteractionClient;

  constructor(runtime: IAgentRuntime, config: Awaited<ReturnType<typeof validateRedditConfig>>) {
    this.client = new RedditClient(runtime, config);
    this.post = new RedditPostClient(this.client, runtime);
    this.interaction = new RedditInteractionClient(this.client, runtime);
  }

  enqueuePost(item: Omit<RedditQueueItem, "id" | "retries" | "createdAt">): void {
    this.post.enqueue(item);
  }

  async stop(): Promise<void> {
    await this.post.stop();
    await this.interaction.stop();
    this.client.stop();
  }
}

export const RedditClientInterface: Client = {
  async start(runtime: IAgentRuntime) {
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

  async stop(runtime: IAgentRuntime) {
    const client = runtime.clients?.reddit as RedditManager | undefined;
    if (client?.stop) await client.stop();
  },
};

export default RedditClientInterface;

export { validateRedditConfig } from "./environment";
export type { RedditQueueItem } from "./types";
