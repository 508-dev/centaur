import { describe, expect, it } from "bun:test";
import { discordMentionRoutingDecision } from "../src/discord-mention-routing";

const CENTAUR_ID = "900000000000000001";
const OTHER_USER_ID = "100000000000000002";

describe("Discord mention routing", () => {
  it("treats canonical other-member mentions as an addressee boundary", () => {
    const actionable =
      `<@${OTHER_USER_ID}> great. Can you write a small summary of where the service is at?`;

    expect(
      discordMentionRoutingDecision(actionable, false, CENTAUR_ID),
    ).toBe("other_member");
    expect(
      discordMentionRoutingDecision(
        `Can you send the summary to <@!${OTHER_USER_ID}>?`,
        false,
        CENTAUR_ID,
      ),
    ).toBe("other_member");
    expect(
      discordMentionRoutingDecision(
        "@someone great. Can you write a small summary?",
        false,
        CENTAUR_ID,
      ),
    ).toBe("unaddressed");
  });

  it("keeps a direct Centaur mention authoritative when another member is named", () => {
    const content =
      `<@${CENTAUR_ID}> ask <@${OTHER_USER_ID}> for context, then write the summary`;

    expect(discordMentionRoutingDecision(content, true, CENTAUR_ID)).toBe(
      "centaur",
    );
    // Canonical raw content also preserves the direct trigger if an adapter's
    // rendered mention flag is unavailable downstream.
    expect(discordMentionRoutingDecision(content, false, CENTAUR_ID)).toBe(
      "centaur",
    );
  });
});
