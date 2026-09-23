/**
 * Yoww 的服务端。两件事：图片上传，和把数据接口转给 Supabase。
 *
 * 静态文件（index.html 等）仍然由 assets 直接送，匹配不上的请求才会走到这里。
 *
 * 上传这一件：把登录用户传上来的图片存进 R2，换一个公开链接回去。
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

/* ===================== Supabase 反代 ===================== */
/**
 * 数据接口原先是浏览器直连 *.supabase.co 的。页面在自己的域名上打得开，
 * 数据却时通时不通 —— 微信那套内置浏览器尤其明显：它的网络栈和系统浏览器
 * 是两回事，地址栏里手动打开一切正常，页面里的请求却会莫名其妙地掐掉。
 *
 * 现在前端只认 /sb/…，由这里转给 Supabase。对浏览器来说，数据和 index.html
 * 走的是同一个域名、同一条路 —— 页面既然能打开，数据就没道理打不开。
 *
 * 这一层没有把私密的东西暴露出来：转过去的仍然是那个本来就人人可见的 anon
 * key（index.html 里就有一份），权限照旧由 RLS 决定，谁也没多拿到什么。
 * 反过来说，这里绝对不能替请求补上任何凭据 —— 一旦哪天在这儿加了
 * service_role，那就等于把整个数据库开给全世界，而且从外面看不出来。
 */
const SB_PREFIX = '/sb/';
// 只放行用到的这四组。多开一条路就多一分要操心的事，而这四组之外的一个都没用上。
// functions/v1 别漏：导出卡片时代取跨域图的那个 img-proxy 就在那儿，
// 漏了它不会报错，只会让导出的卡片上少几张图 —— 静默失败最难查。
const SB_ALLOW = ['rest/v1/', 'auth/v1/', 'storage/v1/', 'functions/v1/'];

// 跨域头：主站是同源访问，用不上这些；但 GitHub Pages 上那份备份、
// 以及套壳 App 里的页面，域名跟这里不一样，得让它们过。
// 给 `*` 而不是回显来源，是因为这里不认 cookie，认的是 Authorization 头 ——
// 凭据得由调用方自己带上，别处的网站拿不到，所以放开来源不会多让谁进来。
// Supabase 自己对外也正是这么回的。
function sbCorsHeaders(req) {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, HEAD, OPTIONS',
    'access-control-allow-headers':
      req.headers.get('access-control-request-headers') ||
      'authorization, apikey, content-type, prefer, x-client-info, range',
    'access-control-expose-headers': 'content-range, content-length, etag',
    'access-control-max-age': '86400',
  };
}

async function handleSupabase(req, env, url) {
  const rest = url.pathname.slice(SB_PREFIX.length);
  if (!SB_ALLOW.some(prefix => rest.startsWith(prefix))) {
    return json({ ok: false, error: '这个路径没开放' }, 404);
  }
  // 预检只问"能不能发"，不该真的转一趟给 Supabase
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: sbCorsHeaders(req) });

  const target = new URL(env.SUPABASE_URL);
  target.pathname = '/' + rest;
  target.search = url.search;

  // 只有公开图片才让 CDN 缓存：它们的地址带随机串或 ?v=，内容不会变。
  // 其余一概不缓存 —— 接口回的是每个人各自的数据，缓存一次就是串号，
  // 而且串的是登录后的内容，比出错还糟。
  const cacheable = req.method === 'GET' && rest.startsWith('storage/v1/object/public/');

  // 用原请求造一个新的：方法、头、body 原样带过去，host 按目标地址重算。
  // 凭据（apikey / authorization）是调用方自己带的，这里既不加也不改。
  const forwarded = new Request(target, req);

  const init = { redirect: 'manual' };
  if (cacheable) {
    init.cf = {
      cacheEverything: true,
      // 出错的响应也缓存的话，一次抽风能让所有人看好几分钟的坏图
      cacheTtlByStatus: { '200-299': 3600, '400-499': 5, '500-599': 0 },
    };
  }

  let res;
  try {
    res = await fetch(forwarded, init);
  } catch (e) {
    // 说清楚是哪一段断的。不然前端只会报一句"连不上"，
    // 分不清是用户到我们这里断了，还是我们到 Supabase 断了 —— 这两件事
    // 的处理方式完全不同
    return new Response(
      JSON.stringify({ ok: false, error: '转发到 Supabase 失败：' + ((e && e.message) || e) }),
      { status: 502, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...sbCorsHeaders(req) } },
    );
  }

  const out = new Response(res.body, res);
  // 跳转的目标还在 supabase.co 上。原样给浏览器，它就自己直连过去了 ——
  // 绕一圈又回到原来那条不通的路上，反代等于白做
  const loc = out.headers.get('location');
  if (loc && loc.startsWith(env.SUPABASE_URL)) {
    out.headers.set('location', url.origin + '/sb' + loc.slice(env.SUPABASE_URL.length));
  }
  for (const [k, v] of Object.entries(sbCorsHeaders(req))) out.headers.set(k, v);
  return out;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/api/upload') {
      if (req.method !== 'POST') return json({ ok: false, error: '只接受 POST' }, 405);
      return handleUpload(req, env);
    }
    if (url.pathname.startsWith(SB_PREFIX)) return handleSupabase(req, env, url);
    return new Response('Not found', { status: 404 });
  },
};
