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

/**
 * 起一个没被占用的文件名。
 *
 * 形如 2026/09/k3x9q2mf7p1a.webp。
 *
 * 三条约束决定了它只能长这样：
 *   一、必须唯一 —— 撞名就是把别人的图覆盖掉。
 *   二、同一个地址的内容永远不能变 —— 图是按一年的强缓存发出去的，
 *       地址一旦复用，缓存会一直发旧的那张，而且没法让它失效。
 *   三、不能用中文或原文件名 —— 中文在 URL 里会变成 %E8%A1%A8%E6%83%85 那种
 *       更难看的东西，原文件名还可能带上传者不想公开的信息。
 *
 * 所以做不到"看名字知道是什么图"，只能做到短和整齐。年月分目录纯粹是为了
 * 人看着舒服、将来清理时好下手 —— R2 本身没有目录这回事。
 *
 * 随机段 12 位 36 进制约等于 62 位熵，百万张图撞一次的概率在千万分之一量级。
 * 但撞上的后果是有人的图被悄悄覆盖，所以还是查一下再用 —— 一次 head 而已。
 */
// 36 进制的随机串。256 不是 36 的整数倍，直接取模的话开头几个字符会偏多，
// 所以把 252 以上的字节丢掉重取 —— 252 正好是 36 的 7 倍，剩下的就是均匀的。
// 这点偏差其实无伤大雅，但"随机"这种地方一旦将就，以后没人会回来复查。
function randomId(n) {
  const A = '0123456789abcdefghijklmnopqrstuvwxyz';
  let out = '';
  while (out.length < n) {
    for (const b of crypto.getRandomValues(new Uint8Array(n))) {
      if (b < 252 && out.length < n) out += A[b % 36];
    }
  }
  return out;
}

async function freshKey(env, ext) {
  const now = new Date();
  const dir = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  for (let i = 0; i < 5; i++) {
    const key = `${dir}/${randomId(12)}.${ext}`;
    if (!(await env.IMG.head(key))) return key;
  }
  // 连撞五次实际上不会发生。真到了这一步，宁可用一个丑但绝不会撞的名字，
  // 也不能返回失败让用户白传一次
  return `${dir}/${crypto.randomUUID()}.${ext}`;
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

  const key = await freshKey(env, ext);
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
