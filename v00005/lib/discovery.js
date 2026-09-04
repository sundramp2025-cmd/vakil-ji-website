const cheerio = require('cheerio');

function normalizeBase(input) {
  const url = new URL(input);
  if (!/^https?:$/.test(url.protocol)) throw new Error('Only http/https sources are supported');
  url.hash = '';
  url.search = '';
  return `${url.protocol}//${url.host}`;
}

async function fetchText(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'V00005-Private-Health-Monitor/2.0' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function locs(xml, base) {
  const out = [];
  const re = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml))) {
    try { out.push(new URL(m[1].trim(), base).href); } catch {}
  }
  return out;
}

function htmlLinks(html, base) {
  const $ = cheerio.load(html);
  const origin = new URL(base).origin;
  const out = [];
  $('a[href]').each((_, el) => {
    try {
      const u = new URL($(el).attr('href'), base);
      if (u.origin === origin) out.push(u.href);
    } catch {}
  });
  return out;
}

function staticAsset(url) {
  return /\.(?:css|js|mjs|png|jpe?g|gif|svg|webp|avif|ico|xml|txt|json|woff2?|ttf|map)(?:\?|$)/i.test(url);
}

function probableVideoPage(url) {
  const p = new URL(url).pathname.toLowerCase();
  return /\/(?:video|videos|watch|clip|post)\//.test(p) || /\/(?:video|watch)(?:\/|$)/.test(p);
}

async function discoverSite(inputUrl) {
  const base = normalizeBase(inputUrl);
  const origin = new URL(base).origin;
  const discovered = new Set();
  const visitedMaps = new Set();
  const queue = [
    `${base}/video-sitemap.xml`,
    `${base}/sitemap-video.xml`,
    `${base}/sitemap_index.xml`,
    `${base}/sitemap.xml`
  ];

  while (queue.length && visitedMaps.size < 300) {
    const sitemapUrl = queue.shift();
    if (visitedMaps.has(sitemapUrl)) continue;
    visitedMaps.add(sitemapUrl);
    try {
      const xml = await fetchText(sitemapUrl);
      for (const u of locs(xml, base)) {
        if (u.toLowerCase().includes('.xml')) queue.push(u);
        else {
          try { if (new URL(u).origin === origin) discovered.add(u); } catch {}
        }
      }
    } catch {}
  }

  if (!discovered.size) {
    try {
      const html = await fetchText(base);
      htmlLinks(html, base).forEach(u => discovered.add(u));
    } catch {}
  }

  const internal = [...discovered].filter(u => {
    try {
      const x = new URL(u);
      return x.origin === origin && x.pathname !== '/' && !staticAsset(u);
    } catch { return false; }
  });

  let videoUrls = internal.filter(probableVideoPage);
  if (!videoUrls.length) videoUrls = internal;

  return { base, videoUrls: [...new Set(videoUrls)] };
}

module.exports = { discoverSite };
