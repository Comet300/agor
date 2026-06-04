import { describe, it, expect, vi } from 'vitest';
import type { Bot } from 'grammy';
import { makeNotifier } from '../src/gateway/bot';
import type { EnrichedItem, Notification } from '../src/contracts';
import { openStore, type Store } from '../src/persistence';
import { tr } from '../src/gateway/strings';

function item(over: Partial<EnrichedItem> = {}): EnrichedItem {
  return {
    id: 'I1',
    title: 'Same Phone',
    price: 1000,
    currency: 'RON',
    url: 'https://v/I1',
    isPrivateOwner: true,
    inStock: true,
    vendor: 'V1',
    ...over,
  };
}

/** A minimal fake grammY Bot exposing just the api methods makeNotifier uses. */
function fakeBot() {
  const sendMessage = vi.fn(
    async (_chatId: number, _text: string, _opts?: unknown) => ({ message_id: 555 }),
  );
  const editMessageText = vi.fn(
    async (_chatId: number, _messageId: number, _text: string) => ({}) as unknown,
  );
  const bot = { api: { sendMessage, editMessageText } } as unknown as Bot;
  return { bot, sendMessage, editMessageText };
}

/** A throwaway in-memory store for the notifier's language lookup. */
function memStore(): Store {
  return openStore(':memory:');
}

describe('makeNotifier production contract', () => {
  it('returns the sent message ref for a new_listing (so cross-posts can edit it)', async () => {
    const { bot, sendMessage } = fakeBot();
    const notify = makeNotifier(bot, memStore());

    const n: Notification = { kind: 'new_listing', chatId: 7, item: item() };
    const ref = await notify(n);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(ref).toEqual({ chatId: 7, messageId: 555 });
  });

  it('edits the original message for a cross_post and returns void', async () => {
    const { bot, sendMessage, editMessageText } = fakeBot();
    const notify = makeNotifier(bot, memStore());

    const n: Notification = {
      kind: 'cross_post',
      chatId: 7,
      messageRef: { chatId: 7, messageId: 555 },
      item: item({ alternativeSources: [{ vendor: 'V2', url: 'https://v2/Y1' }] }),
    };
    const ref = await notify(n);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(editMessageText).toHaveBeenCalledTimes(1);
    // (chatId, messageId, text, opts)
    const [chatId, messageId, text] = editMessageText.mock.calls[0]!;
    expect(chatId).toBe(7);
    expect(messageId).toBe(555);
    // No stored preference -> RO default; the "also on" line uses RO copy.
    expect(String(text)).toContain(tr('ro').also_on('V2 (https://v2/Y1)'));
    expect(ref).toBeUndefined();
  });
});

describe('makeNotifier language resolution', () => {
  it('renders background alerts in the recipient chat stored language (en)', async () => {
    const { bot, sendMessage } = fakeBot();
    const store = memStore();
    store.chatPrefs.setLang(7, 'en');
    const notify = makeNotifier(bot, store);

    await notify({ kind: 'back_in_stock', chatId: 7, item: item() });

    const [, text] = sendMessage.mock.calls[0]!;
    expect(String(text)).toContain(tr('en').back_in_stock_title);
  });

  it('defaults to Romanian when the chat has no stored preference', async () => {
    const { bot, sendMessage } = fakeBot();
    const notify = makeNotifier(bot, memStore());

    await notify({ kind: 'back_in_stock', chatId: 7, item: item() });

    const [, text] = sendMessage.mock.calls[0]!;
    expect(String(text)).toContain(tr('ro').back_in_stock_title);
  });
});
