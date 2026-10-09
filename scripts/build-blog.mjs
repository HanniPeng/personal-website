// 把 Obsidian 的"每日笔记"生成网站上的 /blog 页面。
// 用法：NOTES_DIR=<笔记文件夹> node scripts/build-blog.mjs
// 不设 NOTES_DIR 时读取仓库里的 posts/ 文件夹。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import matter from 'gray-matter';
import { marked } from 'marked';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'blog.config.json'), 'utf8'));
const NOTES_DIR = path.resolve(ROOT, process.env.NOTES_DIR || 'posts');
const OUT = path.join(ROOT, 'blog');
const IMG_OUT = path.join(OUT, 'images');
const SITE = cfg.siteUrl.replace(/\/$/, '');

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif', '.heic']);
const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

// ---------- 工具函数 ----------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pad = (n) => String(n).padStart(2, '0');

function todayInTz() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return parts; // YYYY-MM-DD
}

function normDate(v) {
  if (!v) return null;
  if (v instanceof Date && !isNaN(v)) return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
  const m = String(v).trim().match(/^(\d{4})\s*[年\-\/.]\s*(\d{1,2})\s*[月\-\/.]\s*(\d{1,2})\s*日?/);
  return m ? `${m[1]}-${pad(m[2])}-${pad(m[3])}` : null;
}

function cnDate(d) {
  const [y, m, day] = d.split('-').map(Number);
  const wd = WEEKDAYS[new Date(Date.UTC(y, m - 1, day)).getUTCDay()];
  return `${y}年${m}月${day}日 · ${wd}`;
}

function gitAddedDate(file) {
  try {
    const out = execFileSync('git', ['log', '--diff-filter=A', '--follow', '--format=%ct', '--', path.basename(file)], {
      cwd: path.dirname(file), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split('\n').filter(Boolean).pop();
    if (!out) return null;
    const d = new Date(Number(out) * 1000);
    return new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  } catch { return null; }
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function plainText(md) {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[#>*_`~=\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- 读取笔记 ----------
const files = walk(NOTES_DIR);
const byName = new Map(); // 文件名（含/不含扩展名）→ 路径，用于解析 Obsidian 的 [[ ]]
for (const f of files) {
  const base = path.basename(f);
  byName.set(base, f);
  byName.set(base.normalize('NFC'), f);
  if (base.endsWith('.md')) byName.set(base.slice(0, -3).normalize('NFC'), f);
}

const today = todayInTz();
const posts = [];
const skipped = [];

for (const file of files.filter((f) => f.endsWith('.md'))) {
  const name = path.basename(file, '.md').normalize('NFC');
  if (/^(未命名|Untitled)/i.test(name)) { skipped.push(`${name}（未命名）`); continue; }

  const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const { data, content } = matter(raw);
  if (data.draft === true || data.publish === false || data['草稿'] === true) { skipped.push(`${name}（草稿）`); continue; }

  let body = content.replace(/\r\n/g, '\n');
  const title = String(data.title || name).trim();

  // 正文第一行如果是日期（例如"2026年10月9日"），当作发布日期并从正文移除
  let date = normDate(data.date);
  const lines = body.split('\n');
  const firstIdx = lines.findIndex((l) => l.trim() !== '');
  if (firstIdx >= 0) {
    const first = lines[firstIdx].trim();
    // 第一行是和标题一样的 # 标题，去掉
    if (/^#\s+/.test(first) && first.replace(/^#\s+/, '').trim() === title) { lines.splice(firstIdx, 1); }
  }
  const dIdx = lines.findIndex((l) => l.trim() !== '');
  if (dIdx >= 0 && /^\s*\d{4}\s*[年\-\/.]\s*\d{1,2}\s*[月\-\/.]\s*\d{1,2}\s*日?\s*$/.test(lines[dIdx])) {
    date = date || normDate(lines[dIdx]);
    lines.splice(dIdx, 1);
  }
  body = lines.join('\n');
  date = date || gitAddedDate(file) || today;

  if (date > today) { skipped.push(`${name}（定时：${date} 发布）`); continue; }

  posts.push({ file, name, title, date, body, slug: data.slug ? String(data.slug) : null, mtime: fs.statSync(file).mtimeMs });
}

// 排序：新的在前；同一天按文件修改时间
posts.sort((a, b) => (a.date === b.date ? b.mtime - a.mtime : a.date < b.date ? 1 : -1));

// 网址：/blog/2026-10-09/，同一天多篇加 -2、-3
const used = new Set();
for (const p of [...posts].reverse()) {
  let s = (p.slug || p.date).replace(/[^\w\-]/g, '-');
  let i = 2;
  const baseSlug = s;
  while (used.has(s)) s = `${baseSlug}-${i++}`;
  used.add(s);
  p.slug = s;
}
const postByName = new Map(posts.map((p) => [p.name, p]));

// ---------- 图片 ----------
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(IMG_OUT, { recursive: true });
const imageJobs = new Map(); // 源路径 → 输出网址

function resolveImage(ref, fromFile) {
  const clean = decodeURIComponent(ref.split('#')[0].split('?')[0]).normalize('NFC');
  const rel = path.resolve(path.dirname(fromFile), clean);
  if (fs.existsSync(rel)) return rel;
  return byName.get(path.basename(clean)) || null;
}

function imageUrl(src) {
  if (imageJobs.has(src)) return imageJobs.get(src);
  const hash = crypto.createHash('sha1').update(fs.readFileSync(src)).digest('hex').slice(0, 12);
  const ext = path.extname(src).toLowerCase();
  const outExt = ['.gif', '.svg'].includes(ext) ? ext : '.webp';
  const url = `/blog/images/${hash}${outExt}`;
  imageJobs.set(src, url);
  return url;
}

async function processImages() {
  for (const [src, url] of imageJobs) {
    const dest = path.join(ROOT, url);
    const ext = path.extname(src).toLowerCase();
    if (['.gif', '.svg'].includes(ext)) { fs.copyFileSync(src, dest); continue; }
    try {
      await sharp(src).rotate().resize({ width: 1400, withoutEnlargement: true }).webp({ quality: 80 }).toFile(dest);
    } catch (e) {
      console.warn(`图片处理失败，原样复制：${src}`);
      fs.copyFileSync(src, dest.replace(/\.webp$/, ext));
      imageJobs.set(src, url.replace(/\.webp$/, ext));
    }
  }
}

// ---------- Obsidian 语法转换 ----------
function convertObsidian(md, p) {
  let s = md.replace(/%%[\s\S]*?%%/g, ''); // 注释
  // 代码块不处理
  const blocks = [];
  s = s.replace(/```[\s\S]*?```/g, (m) => { blocks.push(m); return `\u0000${blocks.length - 1}\u0000`; });

  // ![[图片.png|300]]
  s = s.replace(/!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (m, target, opt) => {
    const t = target.trim();
    if (!IMAGE_EXT.has(path.extname(t).toLowerCase())) return ''; // 嵌入其他笔记：不公开
    const src = resolveImage(t, p.file);
    if (!src) { console.warn(`找不到图片：${t}（${p.name}）`); return ''; }
    const sized = opt && /^\d+(x\d+)?$/.test(opt.trim());
    const alt = opt && !sized ? opt : '';
    if (sized) {
      // Obsidian 里调整过的图片宽度（![[图.png|462]]）在网页上保持一致
      const w = Number(opt.trim().split('x')[0]);
      return `\n\n<img src="${imageUrl(src)}" alt="" loading="lazy" decoding="async" style="width:${w}px">\n\n`;
    }
    return `\n\n![${alt}](${imageUrl(src)})\n\n`;
  });
  // ![说明](相对路径)
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, alt, ref) => {
    if (/^(https?:|\/|data:)/.test(ref)) return m;
    const src = resolveImage(ref, p.file);
    return src ? `![${alt}](${imageUrl(src)})` : '';
  });
  // [[笔记|显示文字]]：已发布的笔记变成链接，未发布的只保留文字（不暴露私人笔记）
  s = s.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (m, target, alias) => {
    const t = target.trim().normalize('NFC');
    const text = (alias || t).trim();
    const linked = postByName.get(t);
    return linked ? `[${text}](/blog/${linked.slug}/)` : text;
  });
  // ==高亮==
  s = s.replace(/==([^=\n]+)==/g, '<mark>$1</mark>');
  // > [!note] 标题 → 普通引用
  s = s.replace(/^(>\s*)\[![\w-]+\][+-]?\s*/gm, '$1');

  s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => blocks[Number(i)]);
  return s;
}

marked.setOptions({ gfm: true, breaks: true });
const renderer = new marked.Renderer();
renderer.image = (href, title, text) => `<img src="${href}" alt="${esc(text || '')}" loading="lazy" decoding="async">`;
renderer.link = (href, title, text) => {
  const ext = /^https?:/.test(href) && !href.startsWith(SITE);
  return `<a href="${href}"${ext ? ' target="_blank" rel="noopener"' : ''}>${text}</a>`;
};
marked.use({ renderer });

for (const p of posts) {
  p.md = convertObsidian(p.body, p);
  p.html = marked.parse(p.md);
  p.excerpt = plainText(p.md).slice(0, 110);
  p.url = `/blog/${p.slug}/`;
}

// ---------- 页面模板 ----------
const year = today.slice(0, 4);

function layout({ title, description, path: pagePath, body, type = 'website', extraHead = '' }) {
  const canonical = `${SITE}${pagePath}`;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="author" content="${esc(cfg.author)}">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="${type}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:site_name" content="Hanni Peng">
<link rel="alternate" type="application/rss+xml" title="${esc(cfg.author)} · ${esc(cfg.title)}" href="/blog/feed.xml">
<link rel="preload" href="/assets/fonts/dm-serif-display-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/blog.css">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<script src="/assets/wechat-qr.js" defer></script>
${extraHead}</head>
<body>
<header class="site-header">
  <a href="/" class="logo">Hanni Peng</a>
  <nav>
    <a href="/blog/"${pagePath === '/blog/' ? ' aria-current="page"' : ''}>文章</a>
    <a href="/blog/archive/"${pagePath === '/blog/archive/' ? ' aria-current="page"' : ''}>归档</a>
    <a href="/#about">关于</a>
  </nav>
</header>
<main>
${body}
</main>
<footer class="site-footer">
  <p>© ${(posts[0]?.date || today).slice(0, 4)} Hanni Peng · 品牌与 GTM 顾问</p>
  <p class="footer-links"><a href="#" data-wechat-qr>公众号 · ${esc(cfg.wechatName)}</a><a href="https://www.linkedin.com/in/hanni-peng-5364362b/" target="_blank" rel="noopener">LinkedIn</a><a href="/blog/feed.xml">RSS</a></p>
</footer>
</body>
</html>
`;
}

function postArticle(p, { linkTitle }) {
  const h = linkTitle ? `<a href="${p.url}">${esc(p.title)}</a>` : esc(p.title);
  return `<article class="post">
  <p class="post-date"><time datetime="${p.date}">${cnDate(p.date)}</time></p>
  <h${linkTitle ? 2 : 1} class="post-title">${h}</h${linkTitle ? 2 : 1}>
  <div class="post-body">
${p.html}
  </div>
</article>`;
}

function write(rel, html) {
  const f = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, html);
}

// 首页
{
  const recent = posts.slice(0, cfg.postsOnHome);
  const list = recent.length
    ? recent.map((p) => postArticle(p, { linkTitle: true })).join('\n<div class="divider" aria-hidden="true"></div>\n')
    : '<p class="empty">第一篇文章即将发布。</p>';
  const more = posts.length > recent.length
    ? `<p class="more"><a href="/blog/archive/">查看全部 ${posts.length} 篇文章 →</a></p>` : '';
  write('blog/index.html', layout({
    title: `${cfg.title} · Hanni Peng`,
    description: cfg.description,
    path: '/blog/',
    body: `<div class="page-head">
  <p class="eyebrow">${esc(cfg.titleEn)} · ${esc(cfg.title)}</p>
</div>
${list}
${more}`,
  }));
}

// 单篇
posts.forEach((p, i) => {
  const newer = posts[i - 1];
  const older = posts[i + 1];
  const pager = `<nav class="pager">
  ${older ? `<a class="older" href="${older.url}"><span>← 上一篇</span>${esc(older.title)}</a>` : '<span></span>'}
  ${newer ? `<a class="newer" href="${newer.url}"><span>下一篇 →</span>${esc(newer.title)}</a>` : '<span></span>'}
</nav>`;
  const ld = {
    '@context': 'https://schema.org', '@type': 'BlogPosting', headline: p.title, datePublished: p.date,
    author: { '@type': 'Person', name: cfg.author, url: SITE }, mainEntityOfPage: `${SITE}${p.url}`, inLanguage: 'zh-CN',
  };
  write(`blog/${p.slug}/index.html`, layout({
    title: `${p.title} · Hanni Peng`,
    description: p.excerpt,
    path: p.url,
    type: 'article',
    extraHead: `<meta property="article:published_time" content="${p.date}">\n<script type="application/ld+json">${JSON.stringify(ld)}</script>\n`,
    body: `${postArticle(p, { linkTitle: false })}\n${pager}`,
  }));
});

// 归档
{
  const groups = new Map();
  for (const p of posts) {
    const k = p.date.slice(0, 7);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  const html = [...groups].map(([k, ps]) => {
    const [y, m] = k.split('-');
    return `<section class="archive-month">
  <h2>${y}年${Number(m)}月</h2>
  <ul>
${ps.map((p) => `    <li><time datetime="${p.date}">${p.date.slice(5).replace('-', '/')}</time><a href="${p.url}">${esc(p.title)}</a></li>`).join('\n')}
  </ul>
</section>`;
  }).join('\n');
  write('blog/archive/index.html', layout({
    title: `全部文章 · Hanni Peng`,
    description: cfg.description,
    path: '/blog/archive/',
    body: `<div class="page-head">
  <p class="eyebrow">Archive · 归档</p>
  <h1 class="page-title">全部文章</h1>
  <p class="page-sub">共 ${posts.length} 篇</p>
</div>
${html || '<p class="empty">还没有文章。</p>'}`,
  }));
}

// RSS
{
  const items = posts.slice(0, 30).map((p) => `<item>
<title>${esc(p.title)}</title>
<link>${SITE}${p.url}</link>
<guid>${SITE}${p.url}</guid>
<pubDate>${new Date(`${p.date}T08:00:00+08:00`).toUTCString()}</pubDate>
<description><![CDATA[${p.html.replace(/src="\//g, `src="${SITE}/`)}]]></description>
</item>`).join('\n');
  write('blog/feed.xml', `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>${esc(cfg.author)} · ${esc(cfg.title)}</title>
<link>${SITE}/blog/</link>
<description>${esc(cfg.description)}</description>
<language>zh-CN</language>
${items}
</channel>
</rss>
`);
}

// 站点地图（包含网站首页）
{
  const urls = [
    { loc: `${SITE}/` },
    { loc: `${SITE}/blog/`, lastmod: posts[0]?.date || today },
    { loc: `${SITE}/blog/archive/`, lastmod: posts[0]?.date || today },
    ...posts.map((p) => ({ loc: `${SITE}${p.url}`, lastmod: p.date })),
  ];
  write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `<url><loc>${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`).join('\n')}
</urlset>
`);
  if (!fs.existsSync(path.join(ROOT, 'robots.txt'))) {
    write('robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
  }
}

// 网站首页的"文章"区域：自动放最新 3 篇
{
  const home = path.join(ROOT, 'index.html');
  if (fs.existsSync(home)) {
    const src = fs.readFileSync(home, 'utf8');
    const re = /(<!-- LATEST_POSTS_START[^>]*-->)[\s\S]*?(\s*<!-- LATEST_POSTS_END -->)/;
    if (re.test(src)) {
      const cards = posts.slice(0, 3).map((p) => {
        const [y, m, d] = p.date.split('-').map(Number);
        const ex = p.excerpt.length >= 110 ? `${p.excerpt}……` : p.excerpt;
        return `
      <a class="blog-card fade-in" href="${p.url}">
        <div class="blog-cat">${y}年${m}月${d}日</div>
        <div class="blog-title">${esc(p.title)}</div>
        <div class="blog-excerpt">${esc(ex)}</div>
      </a>`;
      }).join('');
      const out = src.replace(re, (m0, a, b) => `${a}${cards}${b}`);
      if (out !== src) fs.writeFileSync(home, out);
    }
  }
}

await processImages();

console.log(`笔记来源：${NOTES_DIR}`);
console.log(`已发布 ${posts.length} 篇${posts.length ? `，最新：${posts[0].date}《${posts[0].title}》` : ''}`);
if (skipped.length) console.log(`未发布：\n  ${skipped.join('\n  ')}`);
