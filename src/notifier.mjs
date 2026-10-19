/**
 * Multi-Channel Mobile Push Notifier
 * Supports ntfy.sh (instant, no sign-up), Telegram, and Discord webhooks.
 */

const NTFY_TOPIC = process.env.NTFY_TOPIC || "hcrhub-recon-merugu";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";

// Clean non-ASCII for HTTP headers
const asciiOnly = (str) => String(str || "").replace(/[^\x20-\x7E]/g, "").trim();

export async function sendMobileNotification({ title = "HCRHUB Swarm Alert", message, priority = "default" }) {
  const results = [];

  // 1. ntfy.sh (Instant: free, open-source, no sign-up required)
  if (NTFY_TOPIC) {
    try {
      const res = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
        method: "POST",
        headers: {
          "Title": asciiOnly(title) || "HCRHUB Alert",
          "Priority": priority === "high" ? "high" : "default",
          "Tags": "robot,hospital"
        },
        body: message
      });
      if (res.ok) {
        results.push({ channel: "ntfy", success: true, topic: NTFY_TOPIC });
      } else {
        results.push({ channel: "ntfy", success: false, status: res.status });
      }
    } catch (err) {
      results.push({ channel: "ntfy", success: false, error: err.message });
    }
  }

  // 2. Telegram Bot
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    try {
      const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: `*${title}*\n\n${message}`,
          parse_mode: "Markdown"
        })
      });
      if (res.ok) results.push({ channel: "telegram", success: true });
    } catch (err) {
      results.push({ channel: "telegram", success: false, error: err.message });
    }
  }

  // 3. Discord Webhook
  if (DISCORD_WEBHOOK_URL) {
    try {
      const res = await fetch(DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: `**${title}**\n${message}`
        })
      });
      if (res.ok) results.push({ channel: "discord", success: true });
    } catch (err) {
      results.push({ channel: "discord", success: false, error: err.message });
    }
  }

  return results;
}
