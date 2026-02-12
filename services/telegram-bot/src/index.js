import { Telegraf } from 'telegraf';

const token = process.env.TELEGRAM_BOT_TOKEN || '';
const apiBase = process.env.API_BASE_URL || 'http://api:3000';

function mainKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'NEXT', callback_data: 'cmd:next' },
          { text: 'STORY', callback_data: 'cmd:story' },
          { text: 'STATUS', callback_data: 'cmd:status' }
        ],
        [
          { text: 'REST', callback_data: 'cmd:rest' },
          { text: 'SOCIAL', callback_data: 'cmd:socialize' },
          { text: 'AUTO', callback_data: 'cmd:auto_day' }
        ]
      ]
    }
  };
}

function disabledSleep() {
  console.log('[telegram-bot] TELEGRAM_BOT_TOKEN is not set; bot is disabled (sleeping).');
  // Keep container healthy without spamming restarts.
  setInterval(() => {}, 60_000);
}

if (!token) disabledSleep();
else {
  const bot = new Telegraf(token);

  async function callChat(ctx, text) {
    const telegramUserId = String(ctx.from?.id || '');
    const username = (ctx.from?.username || ctx.from?.first_name || 'player').toString();
    const resp = await fetch(`${apiBase}/api/game/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ telegramUserId, username, text })
    }).catch((err) => ({ ok: false, status: 0, _err: err }));

    if (!resp || resp.ok === false) {
      const msg = resp?._err?.message ? String(resp._err.message) : 'network error';
      return { ok: false, reply: `네트워크 오류: ${msg}` };
    }
    const data = await resp.json().catch(() => null);
    if (!data?.ok) return { ok: false, reply: `실패: ${data?.error || 'unknown'}` };
    return { ok: true, reply: data.reply || '(ok)' };
  }

  bot.start(async (ctx) => {
    await ctx.reply(
      [
        '적벽 터미널(장수 시점) 봇입니다.',
        '명령 예시:',
        '- status',
        '- next',
        '- story',
        '- travel <도시>',
        '- spy <도시>',
        '- employ <장수>'
      ].join('\n'),
      mainKeyboard()
    );
  });

  bot.action(/^cmd:(.+)$/i, async (ctx) => {
    const cmd = String(ctx.match?.[1] || '').trim();
    if (!cmd) return;
    await ctx.answerCbQuery().catch(() => {});
    const r = await callChat(ctx, cmd);
    await ctx.reply(r.reply, mainKeyboard());
  });

  // MVP: forward text to API's command endpoint in the future.
  bot.on('text', async (ctx) => {
    const text = String(ctx.message?.text || '').trim();
    if (!text) return;

    // For now: echo and tell user to use web. (We will wire /api/game/chat next.)
    if (text === 'ping') {
      await ctx.reply('pong');
      return;
    }
    const r = await callChat(ctx, text);
    await ctx.reply(r.reply, mainKeyboard());
  });

  bot.launch().then(() => console.log('[telegram-bot] launched'));

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
