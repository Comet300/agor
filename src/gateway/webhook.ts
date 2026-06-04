/**
 * Webhook update intake (production mode).
 *
 * Long-polling stays the default; when a webhook URL is configured the bot
 * serves updates from a small HTTP listener (grammY's built-in
 * {@link webhookCallback}, no extra dependency) and registers the URL with
 * Telegram. TLS is terminated upstream (e.g. a Cloudflare Tunnel), so the
 * listener speaks plain HTTP on a local port; a secret-token header rejects
 * forged requests.
 */
import { createServer, type Server } from 'node:http';
import { webhookCallback, type Bot } from 'grammy';
import type { AppConfig } from '../config';

/** Update mode is a pure function of configuration. */
export function selectMode(config: AppConfig): 'webhook' | 'long-polling' {
  return config.webhookUrl ? 'webhook' : 'long-polling';
}

export interface WebhookOptions {
  /** Public HTTPS URL registered with Telegram. */
  url: string;
  /** Local port to listen on. */
  port: number;
  /** Secret token enforced on incoming requests (recommended). */
  secret?: string;
  /** Bind address; default `0.0.0.0` so a co-located tunnel can reach it. */
  host?: string;
}

/**
 * Start the webhook listener and register the URL with Telegram.
 * Returns the HTTP {@link Server} (keeps the process alive while listening).
 */
export async function startWebhook(bot: Bot, opts: WebhookOptions): Promise<Server> {
  const handler = webhookCallback(bot, 'http', { secretToken: opts.secret });
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(opts.port, opts.host ?? '0.0.0.0', resolve));

  try {
    // init() fetches bot identity; setWebhook points Telegram at our public URL.
    await bot.init();
    await bot.api.setWebhook(opts.url, {
      secret_token: opts.secret,
      allowed_updates: ['message', 'callback_query'],
    });
  } catch (err) {
    // Registration failed: close the listener so the process can actually exit
    // (a bound server would otherwise keep the loop alive in a half-up state,
    // and PM2 only restarts on a real exit). setWebhook runs again on next boot.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw err;
  }
  return server;
}
