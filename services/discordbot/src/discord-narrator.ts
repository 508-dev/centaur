import type { ChatSDKStreamChunk } from "@centaur/rendering";
import type { Logger, Thread } from "chat";
import { parseDiscordThreadKey } from "./discord-allowlist";
import { DEFAULT_DISCORD_API_URL } from "./discord-threading";
import type { DiscordbotApiMessage, DiscordbotOptions } from "./types";
import { errorMessage } from "./utils";

export type DiscordNarratorChunk = Exclude<
  ChatSDKStreamChunk,
  { type: "markdown_text" }
>;
/** Terminal state the run's reaction settles into. */
export type DiscordNarratorOutcome = "done" | "failed" | "retrying";

const REACTION_WORKING = "👀";
const REACTION_DONE = "✅";
const REACTION_FAILED = "❌";

export type DiscordNarratorOptions = {
  logger: Logger;
};

/**
 * Public Discord run-state indicator. The triggering message gets an instant
 * 👀 reaction while the agent works and settles to ✅ or ❌. Reasoning,
 * commentary, activity summaries, task details, commands, tools, plans, and
 * transcripts are intentionally never posted; the separately rendered final
 * answer is the only message content exposed by a run.
 *
 * Reactions go through the raw Discord REST API rather than the adapter: a
 * thread-starter message lives in the PARENT channel (same delta that
 * motivates discord-starter.ts), while the adapter always routes reactions to
 * the thread.
 */
export class DiscordNarrator {
  private readonly botOptions: DiscordbotOptions;
  private readonly logger: Logger;
  private readonly reactionChannelId: string | undefined;
  private readonly reactionMessageId: string;
  private sawError = false;
  private chain: Promise<void> = Promise.resolve();
  private finished = false;

  private constructor(
    thread: Thread,
    message: DiscordbotApiMessage,
    botOptions: DiscordbotOptions,
    options: DiscordNarratorOptions,
  ) {
    this.botOptions = botOptions;
    this.logger = options.logger;
    const { channelId, threadId } = parseDiscordThreadKey(thread.id);
    // A thread-starter message (id == thread id) lives in the parent channel;
    // anything else lives in the thread itself.
    this.reactionChannelId =
      message.id === threadId ? channelId : (threadId ?? channelId);
    this.reactionMessageId = message.id;
  }

  /** Adds the 👀 working reaction (best-effort) and returns the narrator. */
  static start(
    thread: Thread,
    message: DiscordbotApiMessage,
    botOptions: DiscordbotOptions,
    options: DiscordNarratorOptions,
  ): DiscordNarrator {
    const narrator = new DiscordNarrator(thread, message, botOptions, options);
    narrator.enqueueReaction("PUT", REACTION_WORKING);
    return narrator;
  }

  update(chunk: DiscordNarratorChunk): void {
    if (this.finished) return;
    if (chunk.type !== "task_update") return;
    if (chunk.status === "error") this.sawError = true;
  }

  /**
   * Settles the reaction: ✅ on success, ❌ on failure, and 👀 stays put for
   * "retrying" (the retry attempt re-adds it; the PUT is idempotent). Never
   * throws — narration is cosmetic. A "done" outcome downgrades to "failed"
   * when an error task was seen.
   */
  async finish(outcome: DiscordNarratorOutcome): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const failed =
      outcome === "failed" || (outcome === "done" && this.sawError);
    if (outcome !== "retrying") {
      // Add the settled reaction before clearing 👀 so the message always
      // carries an indicator.
      this.enqueueReaction("PUT", failed ? REACTION_FAILED : REACTION_DONE);
      this.enqueueReaction("DELETE", REACTION_WORKING);
    }
    await this.chain;
  }

  private enqueueReaction(method: "PUT" | "DELETE", emoji: string): void {
    const channelId = this.reactionChannelId;
    if (!channelId) return;
    this.chain = this.chain.then(() =>
      discordReactionRequest(
        this.botOptions,
        channelId,
        { emoji, messageId: this.reactionMessageId, method },
        this.logger,
      ),
    );
  }
}

/**
 * Discord delta (no slackbotv2 analog, shared by the narrator and the ingress
 * guards): best-effort reaction via the raw Discord REST API, parent-channel
 * aware — a thread-starter message (id == thread segment) lives in the parent
 * channel, while the adapter always routes reactions to the thread.
 */
export async function reactToDiscordMessage(
  botOptions: DiscordbotOptions,
  input: {
    emoji: string;
    messageId: string;
    method?: "PUT" | "DELETE";
    threadKey: string;
  },
  logger: Logger,
): Promise<void> {
  const { channelId, threadId } = parseDiscordThreadKey(input.threadKey);
  const targetChannelId =
    input.messageId === threadId ? channelId : (threadId ?? channelId);
  if (!targetChannelId) return;
  await discordReactionRequest(
    botOptions,
    targetChannelId,
    {
      emoji: input.emoji,
      messageId: input.messageId,
      method: input.method ?? "PUT",
    },
    logger,
  );
}

/** Raw REST reaction request; never throws (reactions are cosmetic). */
async function discordReactionRequest(
  botOptions: DiscordbotOptions,
  channelId: string,
  input: { emoji: string; messageId: string; method: "PUT" | "DELETE" },
  logger: Logger,
): Promise<void> {
  const { emoji, messageId, method } = input;
  try {
    const fetchFn = botOptions.fetch ?? fetch;
    const apiBase = (
      botOptions.discordApiUrl ?? DEFAULT_DISCORD_API_URL
    ).replace(/\/$/, "");
    const response = await fetchFn(
      `${apiBase}/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
      {
        method,
        headers: { authorization: `Bot ${botOptions.botToken}` },
      },
    );
    if (!response.ok) {
      logger.warn("discordbot_narrator_reaction_failed", {
        emoji,
        method,
        status: response.status,
      });
    }
  } catch (error) {
    logger.warn("discordbot_narrator_reaction_error", {
      emoji,
      method,
      error: errorMessage(error),
    });
  }
}
