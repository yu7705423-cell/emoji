/**
 * Yoww 图片上传接口。
 *
 * 这个 Worker 只管一件事：把登录用户传上来的图片存进 R2，换一个公开链接回去。
 * 静态文件（index.html 等）仍然由 assets 直接送，匹配不上的请求才会走到这里。
 *
 * 为什么要有这一层、不让浏览器直接写 R2：
 * 桶要是能被前端直接写，那就等于全世界都能往里塞东西 —— 匿名的人、脚本、
 * 别的站，谁都可以。把写入收在这里，才有地方问一句"你是谁"。
 */

const MAX_BYTES = 12 * 1024 * 1024;   // 单张上限。动图不压缩，原图可能不小，留够余量
const ALLOWED = {
  'image/png':  'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif':  'gif',
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

/**
 * 问 Supabase「这个 token 是谁」。
 *
 * 也可以拿 JWT 密钥在本地验签，快一点，但那要求把密钥存进 Worker，
 * 而且新老项目的签名算法不一样（对称/非对称），换一次就得跟着改。
 * 多一次服务端到服务端的往返换来的是：没有密钥要保管，也不用关心签名方式。
 * 上传本来就要几秒，这几十毫秒无所谓。
 */
async function whoami(req, env) {
  const auth = req.headers.get('authorization') || '';
  if (!/^Bearer\s+\S+/i.test(auth)) return null;
  try {
    const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { authorization: auth, apikey: env.SUPABASE_ANON_KEY },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user && user.id ? user.id : null;
  } catch (e) {
    return null;
  }
}

async function handleUpload(req, env) {
  const userId = await whoami(req, env);
  if (!userId) return json({ ok: false, error: '请先登录' }, 401);

  const type = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const ext = ALLOWED[type];
  if (!ext) return json({ ok: false, error: '只收 png / jpg / webp / gif' }, 415);

  // Content-Length 能挡掉绝大多数超大请求，省得把整个 body 读进内存才发现太大。
  // 但它是客户端自己报的，不能全信，所以下面读完还要再量一次。
  const claimed = Number(req.headers.get('content-length') || 0);
  if (claimed > MAX_BYTES) return json({ ok: false, error: '图片太大（上限 12 MB）' }, 413);

  const buf = await req.arrayBuffer();
  if (!buf.byteLength) return json({ ok: false, error: '没有收到图片' }, 400);
  if (buf.byteLength > MAX_BYTES) return json({ ok: false, error: '图片太大（上限 12 MB）' }, 413);

  // 路径带上传的人：将来要查某张图是谁传的、或者要清掉某个人传的东西，
  // 不用另外记一张表
  const key = `${userId}/${crypto.randomUUID()}.${ext}`;
  await env.IMG.put(key, buf, {
    httpMetadata: {
      contentType: type,
      // 文件名里有随机串，内容永远不会变，所以可以放心让 CDN 和浏览器一直缓存。
      // 这是图片流量能降下来的关键：同一张图第二个人看时根本不会回源。
      cacheControl: 'public, max-age=31536000, immutable',
    },
    customMetadata: { uploader: userId, at: new Date().toISOString() },
  });

  return json({ ok: true, url: `${env.IMG_BASE}/${key}` });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/api/upload') {
      if (req.method !== 'POST') return json({ ok: false, error: '只接受 POST' }, 405);
      return handleUpload(req, env);
    }
    return new Response('Not found', { status: 404 });
  },
};
