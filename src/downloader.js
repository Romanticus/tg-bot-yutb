import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ytdl from 'ytdl-core';
import { nanoid } from 'nanoid';
import { sanitizeFilename } from './utils.js';

const execFileAsync = promisify(execFile);
const TMP_DIR = path.join(process.cwd(), 'tmp');

function ensureTmp() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
}

function toMegSuffix(bytes) {
  const m = Math.max(1, Math.floor((bytes || 0) / (1024 * 1024)));
  return `${m}M`;
}

// Универсальный запуск yt-dlp: пробуем бинарь, затем модуль через Python
async function execYtDlp(args) {
  const candidates = [
    process.platform === 'win32' ? ['yt-dlp.exe'] : ['yt-dlp'],
    ['py', '-m', 'yt_dlp'],
    ['python', '-m', 'yt_dlp'],
    ['python3', '-m', 'yt_dlp']
  ];

  let lastErr = null;
  for (const cmdArr of candidates) {
    const [cmd, ...prefix] = cmdArr;
    try {
      const res = await execFileAsync(cmd, [...prefix, ...args], {
        windowsHide: true,
        maxBuffer: 1024 * 1024 * 10
      });
      return res;
    } catch (e) {
      lastErr = e;
      if (e.code === 'ENOENT') continue;
      throw e; // yt-dlp запустился, но вернул ошибку — дальше пробовать нет смысла
    }
  }
  const err = new Error('yt-dlp не найден. Установите его или добавьте в PATH (или используйте pip и py -m yt_dlp).');
  err.cause = lastErr;
  throw err;
}

async function downloadWithYtDlp({ url, maxBytes }) {
  ensureTmp();

  const args = [
    url,
    '--no-playlist',
    '--restrict-filenames',
    '--add-metadata',
    '-f', "bv*[ext=mp4]+ba/b[ext=mp4]/b",
    '--merge-output-format', 'mp4',
    '-o', path.join(TMP_DIR, '%(title).80s-%(id).6s.%(ext)s'),
    '--print', 'after_move:filepath',
    '--print', 'filename'
  ];
  if (maxBytes) args.push('--max-filesize', toMegSuffix(maxBytes));

  let stdout = '';
  try {
    const res = await execYtDlp(args);
    stdout = (res.stdout || '').trim();
  } catch (e) {
    const msg = (e.stderr || e.stdout || e.message || '').toString();
    return { ok: false, reason: `yt-dlp: ${msg.slice(0, 500)}` };
  }

  const lines = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  let filepath = lines.find(p => fs.existsSync(p) && p.toLowerCase().endsWith('.mp4'));

  if (!filepath) {
    const files = (fs.readdirSync(TMP_DIR) || [])
      .filter(f => f.toLowerCase().endsWith('.mp4'))
      .map(f => path.join(TMP_DIR, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    filepath = files[0];
  }

  if (!filepath || !fs.existsSync(filepath)) {
    return { ok: false, reason: 'yt-dlp: не удалось определить путь к файлу.' };
  }

  const stats = fs.statSync(filepath);
  if (maxBytes && stats.size > maxBytes) {
    try { fs.unlinkSync(filepath); } catch {}
    return { ok: false, reason: 'Файл превышает лимит Telegram после загрузки (yt-dlp).' };
  }

  const base = path.basename(filepath, path.extname(filepath));
  const title = sanitizeFilename(base.replace(/-[A-Za-z0-9_-]{6}$/, '')) || 'video';

  return {
    ok: true,
    filepath,
    filename: path.basename(filepath),
    size: stats.size,
    title
  };
}

// Базовый выбор формата для ytdl-core (прогрессивный mp4)
export async function chooseFormat(url, maxBytes) {
  const info = await ytdl.getInfo(url);
  const candidates = info.formats
    .filter(f => f.isHLS !== true && f.isDashMPD !== true)
    .filter(f => f.container === 'mp4' && f.hasVideo && f.hasAudio && f.qualityLabel)
    .sort((a, b) => {
      const qa = parseInt((a.qualityLabel || '').replace(/\D/g, '')) || 0;
      const qb = parseInt((b.qualityLabel || '').replace(/\D/g, '')) || 0;
      return qb - qa;
    });

  let picked = null;
  for (const f of candidates) {
    const clen = f.contentLength ? parseInt(f.contentLength, 10) : null;
    if (!maxBytes || !clen || clen <= maxBytes) {
      picked = f;
      break;
    }
  }

  if (!picked && candidates.length) {
    picked = candidates
      .slice()
      .sort((a, b) => (parseInt(a.contentLength || '0', 10) || Infinity) - (parseInt(b.contentLength || '0', 10) || Infinity))[0];
  }

  const title = sanitizeFilename(ytdl.getBasicInfo ? info.videoDetails.title : info.videoDetails?.title || 'video');
  return { info, format: picked, title };
}

export async function downloadVideo({ url, maxBytes }) {
  ensureTmp();

  // Пробуем быстрый путь через ytdl-core
  try {
    const { info, format, title } = await chooseFormat(url, maxBytes);

    if (!format) {
      // Нет прогрессивного mp4 — сразу yt-dlp
      return await downloadWithYtDlp({ url, maxBytes });
    }

    const estSize = format.contentLength ? parseInt(format.contentLength, 10) : null;
    if (maxBytes && estSize && estSize > maxBytes) {
      // Оценка выше лимита — пробуем yt-dlp (может подобрать другой вариант)
      return await downloadWithYtDlp({ url, maxBytes });
    }

    const filename = `${title}-${nanoid(6)}.mp4`;
    const filepath = path.join(TMP_DIR, filename);

    const stream = ytdl(url, { format });
    let aborted = false;

    const sizeLimit = maxBytes || Infinity;
    stream.on('progress', (_chunkLen, downloadedBytes) => {
      if (downloadedBytes > sizeLimit) {
        aborted = true;
        stream.destroy(new Error('Размер превысил лимит отправки.'));
      }
    });

    try {
      await pipeline(stream, fs.createWriteStream(filepath));
    } catch (e) {
      if (fs.existsSync(filepath)) {
        try { fs.unlinkSync(filepath); } catch {}
      }
      if (aborted || /лимит/i.test(e.message)) {
        return { ok: false, reason: 'Размер превысил лимит отправки.' };
      }
      // Любая ошибка ytdl-core (включая "Could not extract functions") — фолбэк на yt-dlp
      return await downloadWithYtDlp({ url, maxBytes });
    }

    const stats = fs.statSync(filepath);
    if (stats.size > sizeLimit) {
      try { fs.unlinkSync(filepath); } catch {}
      return { ok: false, reason: 'Итоговый файл превышает лимит отправки Telegram.' };
    }

    const thumb = info.videoDetails.thumbnails?.slice(-1)[0]?.url || null;
    return {
      ok: true,
      filepath,
      filename,
      size: stats.size,
      title,
      durationSec: parseInt(info.videoDetails.lengthSeconds || '0', 10) || undefined,
      thumb
    };
  } catch (_e) {
    // Сбой на стадии getInfo/chooseFormat — сразу yt-dlp
    return await downloadWithYtDlp({ url, maxBytes });
  }
}

export function cleanupFile(p) {
  if (!p) return;
  try { fs.unlinkSync(p); } catch {}
}