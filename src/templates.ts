import { messageCompletionFooter, shouldRespondFooter } from "@elizaos/core";

export const redditShouldRespondTemplate = `# INSTRUCTIONS: Determine if {{agentName}} should respond to the Reddit message.
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

export const redditMessageHandlerTemplate = `# About {{agentName}}
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

export const redditAutonomousPostTemplate = `You are creating a Reddit self-post for {{agentName}}.

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
