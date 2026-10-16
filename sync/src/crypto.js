// ============================================================
//  加密工具：全部基于 WebCrypto，运行在 Cloudflare Workers 里
//  原则：口令 / 令牌 / 备用码 一律只存哈希，明文永不落库
// ============================================================

const enc = new TextEncoder();

/** 生成随机字节并转 hex（用于盐、令牌、备用码） */
export function randomHex(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 -> hex（用于令牌、备用码这类本身已高熵的值） */
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** PBKDF2-SHA256 派生口令密钥（用于人类可读的口令，需要慢哈希） */
export async function pbkdf2Hex(password, saltHex, iterations = 150000) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const salt = hexToBytes(saltHex);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

/**
 * 定时安全比较：避免通过响应时间猜出哈希前缀。
 * 两个字符串长度不同直接返回 false（长度本身不是秘密）。
 */
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * 生成一个便于手输的备用码：8 组 4 字符，只含无歧义字符。
 * 例如：K7M2-9QXF-3RTB-...
 */
export function makeBackupCode(groups = 4, groupLen = 4) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉 I O 0 1 易混字符
  const bytes = new Uint8Array(groups * groupLen);
  crypto.getRandomValues(bytes);
  const parts = [];
  for (let g = 0; g < groups; g++) {
    let s = '';
    for (let i = 0; i < groupLen; i++) {
      s += alphabet[bytes[g * groupLen + i] % alphabet.length];
    }
    parts.push(s);
  }
  return parts.join('-');
}

/** 生成一个高熵登录口令：便于抄写、约 20 位 */
export function makePassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => alphabet[b % alphabet.length]).join('');
}

/** 统一备用码比对格式：去掉分隔符与空格、转大写 */
export function normalizeCode(input) {
  return String(input || '').replace(/[\s-]/g, '').toUpperCase();
}
