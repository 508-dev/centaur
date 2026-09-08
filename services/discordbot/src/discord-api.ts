export const DEFAULT_DISCORD_API_URL = "https://discord.com/api/v10";

/** Resolve and validate the one Discord REST base before any bot token is sent. */
export function resolveDiscordApiBase(
  configured?: string,
  allowHttpLoopbackForTests = false,
): string {
  const raw = configured ?? DEFAULT_DISCORD_API_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("discord_api_url_invalid");
  }
  const testLoopback =
    allowHttpLoopbackForTests &&
    parsed.protocol === "http:" &&
    ["127.0.0.1", "::1", "localhost"].includes(parsed.hostname);
  if (
    (parsed.protocol !== "https:" && !testLoopback) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("discord_api_url_invalid");
  }
  let end = raw.length;
  while (end > 0 && raw[end - 1] === "/") end -= 1;
  return raw.slice(0, end);
}
