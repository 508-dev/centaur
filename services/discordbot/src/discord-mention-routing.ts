const DISCORD_MEMBER_MENTION_PATTERN = /<@!?(\d{16,22})>/g;

export type DiscordMentionRoutingDecision =
  | "centaur"
  | "other_member"
  | "unaddressed";

/**
 * Resolve the addressee boundary from Discord's canonical Gateway content.
 *
 * `isCentaurMention` is derived by the adapter from Discord's structured
 * mention collections. Raw `content` is also inspected because downstream
 * adapters may remove mention tokens from their rendered message text. A
 * direct Centaur trigger wins when another member is named in the same
 * message; otherwise an explicit member mention belongs to that member, not
 * to an unmentioned Centaur continuation.
 */
export function discordMentionRoutingDecision(
  content: string,
  isCentaurMention: boolean,
  centaurUserId: string,
): DiscordMentionRoutingDecision {
  const mentionedUserIds = new Set(
    [...content.matchAll(DISCORD_MEMBER_MENTION_PATTERN)]
      .map((match) => match[1])
      .filter((userId): userId is string => userId !== undefined),
  );

  if (isCentaurMention || mentionedUserIds.has(centaurUserId)) {
    return "centaur";
  }
  return mentionedUserIds.size > 0 ? "other_member" : "unaddressed";
}
