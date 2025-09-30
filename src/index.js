import 'dotenv/config';
import { Telegraf } from 'telegraf';
import pLimit from 'p-limit';
import { extractUrls, isYouTubeUrl, formatBytes } from './utils.js';
import { downloadVideo, cleanupFile } from './downloader.js';
import fs from 'node:fs';

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('Укажите BOT_TOKEN в .env');
  process.exit(1);
}

const MAX_BYTES = Number(process.env.TELEGRAM_MAX_BYTES || 52428800);
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);

const bot = new Telegraf(BOT_TOKEN);
const limit = pLimit(CONCURRENCY);

bot.start(ctx => ctx.reply('Пришлите одну или несколько YouTube-ссылок в одном сообщении. Я скачаю и отправлю видео по мере готовности.'));

bot.on('text', async (ctx) => {
  const text = ctx.message.text || '';
  const urls = extractUrls(text).filter(isYouTubeUrl);

  if (urls.length === 0) {
    return ctx.reply('Не нашёл YouTube-ссылок. Пришлите ссылку вида https://youtu.be/... или https://youtube.com/watch?v=...');
  }

  await ctx.reply(`Принято ${urls.length} ссылок. Начинаю скачивание параллельно (до ${CONCURRENCY} одновременно). Буду присылать по мере готовности.`);

  const tasks = urls.map(u => limit(async () => {
    try {
      await ctx.sendChatAction('upload_video').catch(() => {});
      const res = await downloadVideo({ url: u, maxBytes: MAX_BYTES });

      if (!res.ok) {
        return ctx.reply(`❌ ${u}\n${res.reason}`);
      }

      const caption = `${res.title}\n(${formatBytes(res.size)})`;
      // Пытаемся отправить как видео; если не выйдет — как документ
      try {
        await ctx.replyWithVideo(
          { source: res.filepath, filename: res.filename },
          { caption, supports_streaming: true }
        );
      } catch (e) {
        await ctx.replyWithDocument(
          { source: res.filepath, filename: res.filename },
          { caption }
        );
      } finally {
        cleanupFile(res.filepath);
      }
    } catch (e) {
      return ctx.reply(`❌ ${u}\nОшибка: ${e.message || e}`);
    }
  }));

  // Запускаем все не дожидаясь каждого по очереди, но ждём завершения всех, чтобы не держать процесс
  await Promise.allSettled(tasks);
});

bot.catch(err => {
  console.error('Bot error:', err);
});

bot.launch().then(() => {
  console.log('Bot started');
});

// Корректное завершение
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));