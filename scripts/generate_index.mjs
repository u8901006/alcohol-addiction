#!/usr/bin/env node
import { readdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DOCS_DIR = resolve(ROOT, 'docs');

const WEEKDAY_ZH = ['日', '一', '二', '三', '四', '五', '六'];

function getDateStr() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function main() {
  let files = [];
  try {
    files = readdirSync(DOCS_DIR)
      .filter(f => f.startsWith('alcohol-') && f.endsWith('.html') && f !== 'index.html')
      .sort()
      .reverse();
  } catch {
    // docs dir doesn't exist yet
  }

  const links = files.slice(0, 60).map(name => {
    const datePart = name.replace('alcohol-', '').replace('.html', '');
    let dateDisplay = datePart;
    let weekday = '';
    try {
      const d = new Date(datePart + 'T00:00:00+08:00');
      if (!isNaN(d.getTime())) {
        const y = d.getFullYear();
        const m = d.getMonth() + 1;
        const day = d.getDate();
        dateDisplay = `${y}年${m}月${day}日`;
        weekday = WEEKDAY_ZH[d.getDay()];
      }
    } catch {
      // keep raw date
    }
    return `<li><a href="${name}">📅 ${dateDisplay}（週${weekday}）</a></li>`;
  }).join('\n');

  const total = files.length;
  const today = getDateStr();

  const indexHtml = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Alcohol Addiction Research · 酒癮研究文獻日報</title>
<style>
  :root { --bg: #f6f1e8; --surface: #fffaf2; --line: #d8c5ab; --text: #2b2118; --muted: #766453; --accent: #8c4f2b; --accent-soft: #ead2bf; }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: radial-gradient(circle at top, #fff6ea 0, var(--bg) 55%, #ead8c6 100%); color: var(--text); font-family: "Noto Sans TC", "PingFang TC", "Helvetica Neue", Arial, sans-serif; min-height: 100vh; }
  .container { position: relative; z-index: 1; max-width: 640px; margin: 0 auto; padding: 80px 24px; }
  .logo { font-size: 48px; text-align: center; margin-bottom: 16px; }
  h1 { text-align: center; font-size: 24px; color: var(--text); margin-bottom: 8px; }
  .subtitle { text-align: center; color: var(--accent); font-size: 14px; margin-bottom: 48px; }
  .count { text-align: center; color: var(--muted); font-size: 13px; margin-bottom: 32px; }
  ul { list-style: none; }
  li { margin-bottom: 8px; }
  a { color: var(--text); text-decoration: none; display: block; padding: 14px 20px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; transition: all 0.2s; font-size: 15px; }
  a:hover { background: var(--accent-soft); border-color: var(--accent); transform: translateX(4px); }
  .clinic-banner { margin-top: 48px; }
  .clinic-link { display: flex; align-items: center; gap: 14px; padding: 18px 24px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; text-decoration: none; color: var(--text); transition: all 0.2s; }
  .clinic-link:hover { background: var(--accent-soft); border-color: var(--accent); transform: translateX(4px); }
  .clinic-icon { font-size: 28px; flex-shrink: 0; }
  .clinic-name { font-size: 15px; font-weight: 700; flex: 1; }
  .clinic-desc { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .clinic-arrow { font-size: 18px; color: var(--accent); font-weight: 700; }
  .links-grid { display: grid; grid-template-columns: 1fr; gap: 12px; margin-top: 48px; }
  footer { margin-top: 56px; text-align: center; font-size: 12px; color: var(--muted); }
  footer a { display: inline; padding: 0; background: none; border: none; color: var(--muted); }
  footer a:hover { color: var(--accent); }
</style>
</head>
<body>
<div class="container">
  <div class="logo">🍷</div>
  <h1>Alcohol Addiction Research</h1>
  <p class="subtitle">酒癮研究文獻日報 · 每日自動更新</p>
  <p class="count">共 ${total} 期日報</p>
  <ul>${links}</ul>
  <div class="links-grid">
    <a href="https://www.leepsyclinic.com/" class="clinic-link" target="_blank" rel="noopener noreferrer">
      <span class="clinic-icon">🏥</span>
      <div>
        <div class="clinic-name">李政洋身心診所首頁</div>
        <div class="clinic-desc">www.leepsyclinic.com</div>
      </div>
      <span class="clinic-arrow">→</span>
    </a>
    <a href="https://blog.leepsyclinic.com/" class="clinic-link" target="_blank" rel="noopener noreferrer">
      <span class="clinic-icon">📬</span>
      <div>
        <div class="clinic-name">訂閱電子報</div>
        <div class="clinic-desc">blog.leepsyclinic.com</div>
      </div>
      <span class="clinic-arrow">→</span>
    </a>
    <a href="https://buymeacoffee.com/CYlee" class="clinic-link" target="_blank" rel="noopener noreferrer">
      <span class="clinic-icon">☕</span>
      <div>
        <div class="clinic-name">Buy Me a Coffee</div>
        <div class="clinic-desc">buymeacoffee.com/CYlee</div>
      </div>
      <span class="clinic-arrow">→</span>
    </a>
  </div>
  <footer>
    <p>Powered by PubMed + NVIDIA AI · <a href="https://github.com/u8901006/alcohol-addiction">GitHub</a></p>
  </footer>
</div>
</body>
</html>`;

  writeFileSync(resolve(DOCS_DIR, 'index.html'), indexHtml, 'utf-8');
  console.error('[INFO] Index page generated');
}

main();
