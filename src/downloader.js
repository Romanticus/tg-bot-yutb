import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import ytdl from 'ytdl-core';
import ytdlFallback from '@distube/ytdl-core';
import { nanoid } from 'nanoid';
import { sanitizeFilename } from './utils.js';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import YTDlpWrapModule from 'yt-dlp-wrap';
// Resolve constructor across CJS/ESM export shapes
function getYtDlpCtor() {
  const candidate = (YTDlpWrapModule && (YTDlpWrapModule.default || YTDlpWrapModule.YTDlpWrap || YTDlpWrapModule));
  return typeof candidate === 'function' ? candidate : null;
}

const TMP_DIR = path.join(process.cwd(), 'tmp');

// Настраиваем путь к статическому ffmpeg
if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

const USER_AGENT = process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const ACCEPT_LANGUAGE = process.env.ACCEPT_LANGUAGE || 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7';
const YT_COOKIES = process.env.YT_COOKIES || '';
const YT_COOKIES_JSON = process.env.YT_COOKIES_JSON || '';

function ensureTmp() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
}

function buildHeaders() {
  const headers = { 'User-Agent': USER_AGENT, 'Accept-Language': ACCEPT_LANGUAGE };
  if (YT_COOKIES) headers['Cookie'] = YT_COOKIES;
  return headers;
}

function buildRequestOptions() {
  return { headers: buildHeaders() };
}

function buildDistubeRequestOptions() {
  const headers = buildHeaders();
  // New cookie format for @distube/ytdl-core: array of cookie objects
  let cookies;
  if (YT_COOKIES_JSON) {
    try {
      const parsed = JSON.parse(YT_COOKIES_JSON);
      if (Array.isArray(parsed)) {
        cookies = parsed;
      }
    } catch {}
  }
  return cookies ? { headers, cookies } : { headers };
}

function toNetscapeCookieLine(cookie) {
  const domain = cookie.domain?.startsWith('.') ? cookie.domain : `.${cookie.domain || 'youtube.com'}`;
  const includeSub = 'TRUE';
  const path = cookie.path || '/';
  const secure = cookie.secure ? 'TRUE' : 'FALSE';
  const expires = Math.floor(Date.now() / 1000) + 31536000; // +1 год
  const name = cookie.name;
  const value = cookie.value;
  return [domain, includeSub, path, secure, expires, name, value].join('\t');
}

function buildNetscapeCookiesFile() {
  // Prefer JSON array
  let cookiesArray = null;
  if (YT_COOKIES_JSON) {
    try {
      const parsed = JSON.parse(YT_COOKIES_JSON);
      if (Array.isArray(parsed)) cookiesArray = parsed.filter(c => (c.domain || '').includes('youtube.com'));
    } catch {}
  }
  if (!cookiesArray && YT_COOKIES) {
    // Parse simple header string "k=v; k2=v2"
    const pairs = YT_COOKIES.split(';').map(s => s.trim()).filter(Boolean);
    cookiesArray = pairs.map(p => {
      const eq = p.indexOf('=');
      const name = eq > -1 ? p.slice(0, eq).trim() : p.trim();
      const value = eq > -1 ? p.slice(eq + 1).trim() : '';
      return { name, value, domain: '.youtube.com', path: '/', secure: true };
    });
  }
  if (!cookiesArray || cookiesArray.length === 0) return null;

  const filePath = path.join(TMP_DIR, `cookies-${Date.now()}.txt`);
  const header = '# Netscape HTTP Cookie File\n';
  const body = cookiesArray.map(toNetscapeCookieLine).join('\n') + '\n';
  fs.writeFileSync(filePath, header + body, 'utf8');
  return filePath;
}

async function downloadWithYtDlpWrap({ url, maxBytes, baseName }) {
  const Ctor = getYtDlpCtor();
  if (!Ctor) throw new Error('yt-dlp-wrap: конструктор не найден. Переустановите пакет: npm i yt-dlp-wrap@latest');

  // Ensure binary exists locally; download if missing
  const binName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const binPath = path.join(TMP_DIR, binName);
  if (!fs.existsSync(binPath)) {
    await Ctor.downloadFromGithub(binPath);
  }
  const ytDlp = new Ctor(binPath);
  ensureTmp();
  const outPath = path.join(TMP_DIR, `${baseName}.mp4`);
  const cookieFile = buildNetscapeCookiesFile();

  const args = [
    url,
    '--no-playlist',
    '--add-metadata',
    '-f', "bv*[ext=mp4]+ba/b[ext=mp4]/b",
    '--merge-output-format', 'mp4',
    '-o', outPath,
    '--user-agent', USER_AGENT,
    '--add-header', `Accept-Language: ${ACCEPT_LANGUAGE}`
  ];
  if (cookieFile) {
    args.push('--cookies', cookieFile);
  }
  if (maxBytes) {
    // ограничение перед загрузкой не всегда возможно, но оставим размерный контроль постфактум
  }

  await new Promise((resolve, reject) => {
    ytDlp.exec(args)
      .on('error', (err) => reject(err))
      .on('close', (code) => code === 0 ? resolve() : reject(new Error(`yt-dlp exited with code ${code}`)));
  });

  if (!fs.existsSync(outPath)) {
    throw new Error('yt-dlp: файл результата не найден');
  }
  const size = fs.statSync(outPath).size;
  if (maxBytes && size > maxBytes) {
    try { fs.unlinkSync(outPath); } catch {}
    throw new Error('Итоговый файл превышает лимит отправки Telegram.');
  }
  return { outPath, size };
}

async function getVideoInfo(url) {
  try {
    const info = await ytdl.getInfo(url, { requestOptions: buildRequestOptions() });
    const title = sanitizeFilename(info.videoDetails?.title || 'video');
    return { info, title, lib: 'ytdl' };
  } catch (e1) {
    // fallback to distube fork (supports cookies array)
    const info = await ytdlFallback.getInfo(url, { requestOptions: buildDistubeRequestOptions() });
    const title = sanitizeFilename(info.videoDetails?.title || 'video');
    return { info, title, lib: 'distube' };
  }
}

function pickProgressiveFormat(info, maxBytes) {
  const formats = info.formats
    .filter(f => f.hasVideo && f.hasAudio && f.isHLS !== true && f.isDashMPD !== true && f.container === 'mp4')
    .sort((a, b) => {
      const qa = parseInt((a.qualityLabel || '').replace(/\D/g, '')) || 0;
      const qb = parseInt((b.qualityLabel || '').replace(/\D/g, '')) || 0;
      return qb - qa;
    });

  for (const f of formats) {
    const clen = f.contentLength ? parseInt(f.contentLength, 10) : null;
    if (!maxBytes || !clen || clen <= maxBytes) return f;
  }
  return formats[formats.length - 1] || null;
}

function pickSeparateFormats(info) {
  const videos = info.formats
    .filter(f => f.hasVideo && !f.hasAudio && f.isHLS !== true)
    .sort((a, b) => (parseInt((b.qualityLabel || '').replace(/\D/g, '')) || 0) - (parseInt((a.qualityLabel || '').replace(/\D/g, '')) || 0));
  const audios = info.formats
    .filter(f => f.hasAudio && !f.hasVideo && f.isHLS !== true)
    .sort((a, b) => (parseInt(b.bitrate || '0', 10) || 0) - (parseInt(a.bitrate || '0', 10) || 0));
  return { video: videos[0] || null, audio: audios[0] || null };
}

async function downloadStreamToFile(url, format, outPath, maxBytes, preferLib) {
  return new Promise((resolve, reject) => {
    const reqOpts = { requestOptions: preferLib === 'distube' ? buildDistubeRequestOptions() : buildRequestOptions(), format };
    let stream;
    try {
      stream = (preferLib === 'distube' ? ytdlFallback : ytdl)(url, reqOpts);
    } catch (_e) {
      // fall back to the other lib
      try {
        const altOpts = { requestOptions: preferLib === 'distube' ? buildRequestOptions() : buildDistubeRequestOptions(), format };
        stream = (preferLib === 'distube' ? ytdl : ytdlFallback)(url, altOpts);
      } catch (e) {
        return reject(e);
      }
    }
    let written = 0;

    stream.on('progress', (_chunkLen, downloaded) => {
      written = downloaded;
      if (maxBytes && written > maxBytes) {
        stream.destroy(new Error('Размер превысил лимит отправки.'));
      }
    });

    const file = fs.createWriteStream(outPath);
    pipeline(stream, file)
      .then(() => resolve({ size: fs.statSync(outPath).size }))
      .catch(err => {
        try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {}
        reject(err);
      });
  });
}

async function muxToMp4(videoPath, audioPath, outPath) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions([
        '-c:v copy', // без перекодирования видео
        '-c:a aac',
        '-b:a 192k',
        '-movflags +faststart'
      ])
      .format('mp4')
      .save(outPath)
      .on('end', () => resolve())
      .on('error', (err) => {
        reject(err);
      });
  });
}

export async function downloadVideo({ url, maxBytes }) {
  ensureTmp();

  let info, title, lib;
  try {
    const meta = await getVideoInfo(url);
    info = meta.info;
    title = meta.title;
    lib = meta.lib;
  } catch (e) {
    return { ok: false, reason: `Ошибка получения информации о видео: ${e.message}` };
  }

  // 1) Пытаемся взять прогрессивный mp4
  const prog = pickProgressiveFormat(info, maxBytes);
  const baseName = `${title}-${nanoid(6)}`;

  if (prog) {
    const outFile = path.join(TMP_DIR, `${baseName}.mp4`);
    try {
      await downloadStreamToFile(url, prog, outFile, maxBytes, lib);
      const size = fs.statSync(outFile).size;
      if (maxBytes && size > maxBytes) {
        try { fs.unlinkSync(outFile); } catch {}
        // Падём в путь с раздельными дорожками, возможно там получится меньше размер
      } else {
        const thumb = info.videoDetails.thumbnails?.slice(-1)[0]?.url || null;
        return { ok: true, filepath: outFile, filename: path.basename(outFile), size, title, durationSec: parseInt(info.videoDetails.lengthSeconds || '0', 10) || undefined, thumb };
      }
    } catch (e) {
      // продолжим к раздельным потокам
    }
  }

  // 2) Отдельные дорожки + слияние через ffmpeg
  const { video, audio } = pickSeparateFormats(info);
  if (!video || !audio) {
    // Фолбэк: пробуем yt-dlp-wrap, когда расшифровка сломана или форматы недоступны
    try {
      const { outPath, size } = await downloadWithYtDlpWrap({ url, maxBytes, baseName });
      const thumb = info.videoDetails.thumbnails?.slice(-1)[0]?.url || null;
      return { ok: true, filepath: outPath, filename: path.basename(outPath), size, title, durationSec: parseInt(info.videoDetails.lengthSeconds || '0', 10) || undefined, thumb };
    } catch (e) {
      return { ok: false, reason: `Не найден подходящий формат и не удалось через yt-dlp: ${e.message}` };
    }
  }

  const vPath = path.join(TMP_DIR, `${baseName}.video`);
  const aPath = path.join(TMP_DIR, `${baseName}.audio`);
  const outPath = path.join(TMP_DIR, `${baseName}.mp4`);

  try {
    await downloadStreamToFile(url, video, vPath, maxBytes ? Math.floor(maxBytes * 0.85) : undefined, lib);
    await downloadStreamToFile(url, audio, aPath, maxBytes ? Math.floor(maxBytes * 0.25) : undefined, lib);
  } catch (e) {
    try { if (fs.existsSync(vPath)) fs.unlinkSync(vPath); } catch {}
    try { if (fs.existsSync(aPath)) fs.unlinkSync(aPath); } catch {}
    // Фолбэк на yt-dlp-wrap при 403/decipher
    try {
      const { outPath, size } = await downloadWithYtDlpWrap({ url, maxBytes, baseName });
      const thumb = info.videoDetails.thumbnails?.slice(-1)[0]?.url || null;
      return { ok: true, filepath: outPath, filename: path.basename(outPath), size, title, durationSec: parseInt(info.videoDetails.lengthSeconds || '0', 10) || undefined, thumb };
    } catch (e2) {
      return { ok: false, reason: `Ошибка загрузки потоков: ${e.message}. Фолбэк yt-dlp тоже не помог: ${e2.message}` };
    }
  }

  try {
    await muxToMp4(vPath, aPath, outPath);
  } catch (e) {
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {}
    try { if (fs.existsSync(vPath)) fs.unlinkSync(vPath); } catch {}
    try { if (fs.existsSync(aPath)) fs.unlinkSync(aPath); } catch {}
    return { ok: false, reason: `Ошибка объединения дорожек: ${e.message}` };
  } finally {
    try { if (fs.existsSync(vPath)) fs.unlinkSync(vPath); } catch {}
    try { if (fs.existsSync(aPath)) fs.unlinkSync(aPath); } catch {}
  }

  const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
  if (maxBytes && size > maxBytes) {
    try { fs.unlinkSync(outPath); } catch {}
    return { ok: false, reason: 'Итоговый файл превышает лимит отправки Telegram.' };
  }

  const thumb = info.videoDetails.thumbnails?.slice(-1)[0]?.url || null;
  return {
    ok: true,
    filepath: outPath,
    filename: path.basename(outPath),
    size,
    title,
    durationSec: parseInt(info.videoDetails.lengthSeconds || '0', 10) || undefined,
    thumb
  };
}

export function cleanupFile(p) {
  if (!p) return;
  try { fs.unlinkSync(p); } catch {}
}