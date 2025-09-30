import { URL } from 'node:url';

const YT_HOSTS = new Set([
  'www.youtube.com',
  'youtube.com',
  'm.youtube.com',
  'youtu.be',
  'music.youtube.com'
]);

export function extractUrls(text) {
  if (!text) return [];
  const raw = text.match(/https?:\/\/\S+/g) || [];
  // Чистим от завершающей пунктуации
  return raw.map(u => u.replace(/[),.;!?]+$/, '')).filter(Boolean);
}

export function isYouTubeUrl(u) {
  try {
    const url = new URL(u);
    return YT_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

export function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 150).trim() || 'video';
}