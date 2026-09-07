/**
 * Push notification for a cycle that needs a human.
 *
 * GitHub emails on a *failed* run, which covers failures and nothing else — a
 * warning like "balance nearly out" lands in a summary nobody opens, a week
 * before it matters. So warnings are notifiable here too, independently of the
 * exit code.
 *
 * Living in TypeScript rather than a `run:` step means it fires on the
 * conditions the keeper knows about rather than on the job's exit status, and
 * it can be tested. It is best-effort by construction: a notifier that throws
 * would turn a warning into a failed run, which is precisely backwards.
 */
export interface NotifyConfig {
  telegramBotToken?: string;
  telegramChatId?: string;
}

export interface Notification {
  severity: "failure" | "warning";
  /** One-line headline. */
  title: string;
  /** Bullet lines under the headline. */
  details: string[];
}

export function readNotifyConfig(env: NodeJS.ProcessEnv): NotifyConfig {
  return {
    telegramBotToken: env.TELEGRAM_BOT_TOKEN?.trim() || undefined,
    telegramChatId: env.TELEGRAM_CHAT_ID?.trim() || undefined,
  };
}

/** The Actions run this process belongs to, when there is one. */
export function runUrl(env: NodeJS.ProcessEnv): string | undefined {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = env;
  if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return undefined;
  return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
}

export function formatMessage(n: Notification, url?: string): string {
  const icon = n.severity === "failure" ? "🔴" : "🟡";
  const lines = [`${icon} ${n.title}`, ...n.details.map((d) => `• ${d}`)];
  if (url) lines.push(url);
  return lines.join("\n");
}

/**
 * Send `notification`, if a channel is configured. Returns what happened, so
 * the caller can say so in the log rather than leaving "did it page anyone?"
 * unanswered.
 *
 * Never throws.
 */
export async function notify(
  config: NotifyConfig,
  notification: Notification,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 15_000,
): Promise<{ sent: boolean; reason?: string }> {
  const { telegramBotToken, telegramChatId } = config;
  if (!telegramBotToken || !telegramChatId) {
    return { sent: false, reason: "no notification channel configured" };
  }

  const text = formatMessage(notification, runUrl(env));
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${telegramBotToken}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: telegramChatId,
          text,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!response.ok) {
      // Telegram puts the reason in the body; the status alone is rarely enough
      // to tell a bad token from a bad chat id.
      const body = await response.text().catch(() => "");
      return {
        sent: false,
        reason: `telegram returned ${response.status}: ${body.slice(0, 200)}`,
      };
    }
    return { sent: true };
  } catch (err) {
    return {
      sent: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
