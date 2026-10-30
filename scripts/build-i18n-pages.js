#!/usr/bin/env node
/**
 * build-i18n-pages.js
 *
 * De site is vijftalig en elke taal heeft eigen URL's. Engels is de
 * standaardtaal: die staat in de hoofdmap, zodat alles wat geen JavaScript
 * uitvoert (linkvoorbeelden in GitHub, LinkedIn, WhatsApp en Slack, Google,
 * de crawlers van AI-assistenten) Engels ziet.
 *
 *     /nl/over-ons.html       → Nederlands — de BRON, met de hand geschreven
 *     /over-ons.html          → Engels   (gegenereerd)
 *     /fr/over-ons.html       → Frans    (gegenereerd)
 *     /tr/over-ons.html       → Turks    (gegenereerd)
 *     /es/over-ons.html       → Spaans   (gegenereerd)
 *     /en/over-ons.html       → doorverwijzing naar /over-ons.html (oude links)
 *
 * Waarom de bron in nl/ staat: de deploy zet de hele repo online. In nl/ is de
 * bron dus meteen de Nederlandse pagina, zonder derde kopie en zonder dat bron
 * en uitvoer in dezelfde map door elkaar lopen. De hoofdmap bevat alleen
 * uitvoer (plus de pagina's die niet vertaald worden, zoals 404.html, de
 * nieuwsartikelen en supercloud/).
 *
 * Elke versie krijgt:
 *  - de vertaalde tekst statisch in de HTML (geen JavaScript nodig)
 *  - <html lang="...">, een vertaalde <title>, description, og:* en twitter:*
 *  - een eigen canonical en og:locale
 *  - rel=alternate hreflang naar alle vijf de versies; x-default is de root
 *  - <meta name="i18n-static">, waardoor shared/i18n.js zijn handen thuishoudt
 *  - interne links die binnen dezelfde taal blijven
 *  - een taalschakelaar van echte <a href>-links. Dat is geen detail: Google
 *    negeert hreflang als de taalversies niet met gewone links naar elkaar
 *    wijzen.
 *
 * De Engelse pagina's in de root krijgen vooraan de <head> de lang-boot-
 * snippet: een eerste bezoeker met een nl/fr/tr/es-apparaat gaat met
 * location.replace naar zijn eigen taal. Een opgeslagen keuze (taalknop) wint
 * altijd, ook als die Engels is.
 *
 * In de bron mag een interne link naar /pagina/ of /nl/pagina/ wijzen; het
 * script zet hem in de bron op /nl/pagina/ en in elke taal op de eigen versie.
 *
 * Inputs:  nl/ (de Nederlandse bron), shared/translations/*.json
 * Outputs: de Engelse pagina's in de root, fr/, tr/, es/, de doorverwijzingen
 *          in en/, hreflang en taallinks in de bron, sitemap.xml
 *
 * Draaien: `node scripts/build-i18n-pages.js`
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ORIGIN = 'https://open-aec.com';
const SOURCE = 'nl';                       // taal van de bron, in nl/
const DEFAULT = 'en';                      // taal van de root
const LANGS = ['en', 'fr', 'tr', 'es'];    // gegenereerd uit de bron
const ALL = [SOURCE, ...LANGS];
const OG_LOCALE = { nl: 'nl_NL', en: 'en_US', fr: 'fr_FR', tr: 'tr_TR', es: 'es_ES' };
const SOURCE_DIR = path.join(ROOT, SOURCE);
// Oude adressen: tot oktober 2026 stond het Engels onder /en/.
const LEGACY_DIR = path.join(ROOT, DEFAULT);

/** Padvoorvoegsel van een taal: '' voor de root, '/fr' enz. voor de rest. */
const prefix = (lang) => (lang === DEFAULT ? '' : `/${lang}`);

// ── helpers ────────────────────────────────────────────────────────────────

function htmlFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) htmlFiles(p, out);
    else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function mergeInto(target, source) {
  for (const k of Object.keys(source)) {
    const v = source[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (!target[k] || typeof target[k] !== 'object') target[k] = {};
      mergeInto(target[k], v);
    } else target[k] = v;
  }
  return target;
}

const dig = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
const attrEsc = (s) => s.replace(/"/g, '&quot;');

/**
 * Vervangt de inhoud van elk element met data-i18n="sleutel".
 * Regex kan dit niet: elementen bevatten andere elementen, soms van dezelfde
 * soort. We zoeken daarom de bijbehorende sluittag door mee te tellen hoe diep
 * we zitten in tags met dezelfde naam.
 */
function translateElements(html, translations) {
  const open = /<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*\bdata-i18n="([^"]+)"[^>]*)>/g;
  let out = '';
  let last = 0;
  let m;

  while ((m = open.exec(html)) !== null) {
    const [whole, tag, attrs, key] = m;
    const value = dig(translations, key);
    const bodyStart = m.index + whole.length;

    // Attribuutvertaling (placeholder, title, ...) heeft geen body nodig.
    const attrTarget = /\bdata-i18n-attr="([^"]+)"/.exec(attrs);
    if (attrTarget && typeof value === 'string') {
      const re = new RegExp(`\\b${attrTarget[1]}="[^"]*"`);
      const newOpen = re.test(whole)
        ? whole.replace(re, `${attrTarget[1]}="${attrEsc(value)}"`)
        : whole.replace(/>$/, ` ${attrTarget[1]}="${attrEsc(value)}">`);
      out += html.slice(last, m.index) + newOpen;
      last = bodyStart;
      continue;
    }

    if (typeof value !== 'string') continue; // geen vertaling: laten staan

    // Zoek de sluittag die bij deze opening hoort.
    const scan = new RegExp(`<${tag}\\b[^>]*>|</${tag}\\s*>`, 'g');
    scan.lastIndex = bodyStart;
    let depth = 1, close = -1, s;
    while ((s = scan.exec(html)) !== null) {
      if (s[0][1] === '/') { depth--; if (depth === 0) { close = s.index; break; } }
      else if (!s[0].endsWith('/>')) depth++;
    }
    if (close === -1) continue;

    out += html.slice(last, bodyStart) + value;
    last = close;
    open.lastIndex = close;
  }
  return out + html.slice(last);
}

/** Nav-links en knoppen gebruiken data-i18n-en/fr/tr in plaats van een sleutel. */
function translateInlineAttrs(html, lang) {
  return html.replace(
    /<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*\bdata-i18n-(?:en|fr|tr|es)="[^"]*"[^>]*)>([^<]*)<\/\1>/g,
    (whole, tag, attrs, body) => {
      const own = new RegExp(`\\bdata-i18n-${lang}="([^"]*)"`).exec(attrs);
      const en = /\bdata-i18n-en="([^"]*)"/.exec(attrs);
      const value = (own && own[1]) || (en && en[1]);
      return value ? `<${tag}${attrs}>${value}</${tag}>` : whole;
    }
  );
}

// ── pagina's verzamelen ────────────────────────────────────────────────────

/** URL-pad van een bestand: index.html wordt een map-URL. */
function urlFor(rel) {
  const p = '/' + rel.split(path.sep).join('/');
  return p.endsWith('/index.html') ? p.slice(0, -'index.html'.length) : p;
}

const pages = [];
for (const file of htmlFiles(SOURCE_DIR)) {
  const rel = path.relative(SOURCE_DIR, file);
  const html = fs.readFileSync(file, 'utf8');
  if (!/data-i18n="/.test(html)) continue;

  const idMatch = /<meta name="i18n-page" content="([^"]+)"/.exec(html);
  let source = null;

  if (idMatch) {
    source = { kind: 'files', id: idMatch[1] };
  } else if (html.includes('const translations = {')) {
    // De homepage draagt zijn vertalingen inline mee.
    source = { kind: 'inline' };
  }
  if (!source) continue;

  pages.push({ file, rel, url: urlFor(rel), html, source });
}

// Taalneutrale paden van alle vertaalde pagina's ('/', '/over-ons.html', ...).
const TRANSLATABLE = new Set(pages.map(p => p.url));

/** Pad zonder #anker of ?query, en de rest erachter. */
function splitHref(href) {
  const pathPart = href.split(/[#?]/)[0];
  return [pathPart, href.slice(pathPart.length)];
}

/** Een gegenereerde pagina draagt de taal van zijn adres. */
const STATIC_META = /[ \t]*<meta name="i18n-static" content="([a-z]{2})">\n?/;
const isGenerated = (html, lang) => (STATIC_META.exec(html) || [])[1] === lang;

// ── vertalingen per pagina en taal ─────────────────────────────────────────

function inlineTranslations(html) {
  const i = html.indexOf('const translations = {');
  const start = html.indexOf('{', i);
  let depth = 0, j = start;
  for (; j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}') { depth--; if (depth === 0) { j++; break; } }
  }
  // eslint-disable-next-line no-eval
  return eval('(' + html.slice(start, j) + ')');
}

function translationsFor(page, lang) {
  if (page.source.kind === 'inline') {
    const all = inlineTranslations(page.html);
    return mergeInto(mergeInto({}, all.en || {}), all[lang] || {});
  }
  const dir = path.join(ROOT, 'shared', 'translations');
  const en = readJson(path.join(dir, `${page.source.id}.json`)) || {};
  const own = lang === 'en' ? {} : (readJson(path.join(dir, `${page.source.id}.${lang}.json`)) || {});
  return mergeInto(mergeInto({}, en), own);
}

// ── linkherschrijving ──────────────────────────────────────────────────────

/**
 * Relatieve verwijzingen absoluut maken. Een pagina in /statuten/ die naar
 * "oprichtingsakte.md" wijst, komt in /fr/statuten/ terecht — daar bestaat dat
 * bestand niet. Absoluut maken houdt de verwijzing heel. De bron staat in nl/,
 * maar de assets staan in de hoofdmap: daarom de taalneutrale URL als basis.
 */
function absolutise(html, pageUrl) {
  const dir = pageUrl.endsWith('/') ? pageUrl : pageUrl.slice(0, pageUrl.lastIndexOf('/') + 1);
  const fix = (chunk) => chunk.replace(/\b(href|src)="([^"]+)"/g, (whole, attr, u) => {
    if (/^(\/|https?:|#|mailto:|tel:|javascript:|data:|\/\/)/.test(u) || u.includes('${') || u.includes('$1')) return whole;
    return `${attr}="${dir}${u}"`;
  });

  // Alleen de opmaak aanpassen, niet de inhoud van <script> of <style>. Daar
  // staan href="..."-fragmenten in JavaScript-strings; die absoluut maken zou
  // de code stuk maken (een autolinker bouwde zo href="/pad/https://...").
  const parts = html.split(/(<(?:script|style)\b[\s\S]*?<\/(?:script|style)>)/i);
  return parts.map((part, i) => (i % 2 === 1 ? part : fix(part))).join('');
}

/**
 * Interne links naar een vertaalde pagina wijzen naar de versie in `lang`;
 * assets en externe links blijven staan. Een link in de bron mag al /nl/
 * dragen; die wordt eerst weer taalneutraal gemaakt.
 */
function rewriteLinks(html, lang) {
  return html.replace(/href="(\/[^"]*)"/g, (whole, href) => {
    let [pathPart, tail] = splitHref(href);
    const m = /^\/(nl|en|fr|tr|es)(\/.*)$/.exec(pathPart);
    if (m && TRANSLATABLE.has(m[2])) pathPart = m[2];
    else if (pathPart === `/${SOURCE}`) pathPart = '/';
    if (!TRANSLATABLE.has(pathPart)) return whole;
    return `href="${prefix(lang)}${pathPart}${tail}"`;
  });
}

// ── head-aanpassingen ──────────────────────────────────────────────────────

function alternates(url) {
  const lines = ALL.map(l => `  <link rel="alternate" hreflang="${l}" href="${ORIGIN}${prefix(l)}${url}">`);
  lines.push(`  <link rel="alternate" hreflang="x-default" href="${ORIGIN}${prefix(DEFAULT)}${url}">`);
  return lines.join('\n');
}

/** Platte tekst uit een vertaalwaarde, afgekapt op een woordgrens. */
function plain(value, max = 155) {
  if (typeof value !== 'string') return null;
  const txt = value.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
  if (!txt) return null;
  if (txt.length <= max) return txt;
  return txt.slice(0, txt.lastIndexOf(' ', max)).replace(/[,;:]$/, '') + '…';
}

// De Engelse pagina in de root is wat iedereen zonder taalvoorkeur krijgt.
// Deze snippet staat vooraan in de <head> en kiest synchroon dezelfde taal als
// shared/i18n.js: opgeslagen keuze, dan de browsertalen, dan Engels. Is dat
// Nederlands, Frans, Turks of Spaans, dan gaat de bezoeker met
// location.replace naar die versie (de terugknop slaat de root dan over). De
// pagina is zolang verborgen; na 3 seconden toont hij toch, als vangrail.
const LANG_BOOT = [
  '<!-- lang-boot:start -->',
  '<style>html.lang-pending body{visibility:hidden}</style>',
  '<script>(function(){try{var o="nl fr tr es".split(" "),l=null;try{l=localStorage.getItem("openaec-lang")}catch(e){}if(!l){var a=navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language||"en"];for(var i=0;i<a.length;i++){var c=String(a[i]||"").toLowerCase().split("-")[0];if(c==="en"||o.indexOf(c)>-1){l=c;break}}}if(o.indexOf(l)>-1){var d=document.documentElement;d.classList.add("lang-pending");setTimeout(function(){d.classList.remove("lang-pending")},3000);location.replace("/"+l+location.pathname+location.search+location.hash)}}catch(e){}})()</script>',
  '<!-- lang-boot:end -->',
].join('\n  ');
const LANG_BOOT_RE = /[ \t]*<!-- lang-boot:start -->[\s\S]*?<!-- lang-boot:end -->\n?/g;

function setHead(html, { lang, url, title, description }) {
  // Alleen de root krijgt de snippet; de taalversies horen bij hun adres.
  html = html.replace(LANG_BOOT_RE, '');
  if (lang === DEFAULT) {
    html = html.replace(/(<head[^>]*>\s*)/, `$1${LANG_BOOT}\n  `);
  }

  // Bestaand hreflang-blok van een vorige run weghalen.
  html = html.replace(/\n?[ \t]*<!-- hreflang:start -->[\s\S]*?<!-- hreflang:end -->/g, '');

  html = html.replace(/<html([^>]*)\blang="[^"]*"/, `<html$1lang="${lang}"`);

  if (title) {
    const esc = attrEsc(title);
    html = html.replace(/<title([^>]*)>[\s\S]*?<\/title>/, (w, a) => `<title${a}>${title}</title>`);
    html = html.replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${esc}$2`);
    html = html.replace(/(<meta name="twitter:title" content=")[^"]*(")/, `$1${esc}$2`);
  }

  // De beschrijving is wat in de zoekresultaten staat; die in het Nederlands
  // laten staan op een Engelse pagina kost meteen kliks. Waar geen eigen
  // meta.description bestaat, gebruiken we de hero-tekst van de pagina.
  if (description) {
    const esc = attrEsc(description);
    html = html.replace(/(<meta name="description" content=")[^"]*(")/, `$1${esc}$2`);
    html = html.replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${esc}$2`);
    html = html.replace(/(<meta name="twitter:description" content=")[^"]*(")/, `$1${esc}$2`);
  }

  const canonical = ORIGIN + prefix(lang) + url;
  html = html.replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${canonical}$2`);
  html = html.replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${canonical}$2`);

  // og:locale is de taal van deze versie; de andere talen zijn alternates.
  html = html.replace(/[ \t]*<meta property="og:locale:alternate" content="[^"]*">\n?/g, '');
  html = html.replace(/([ \t]*)(<meta property="og:locale" content=")[^"]*(">)/, (w, indent, a, b) =>
    indent + a + OG_LOCALE[lang] + b +
    ALL.filter(l => l !== lang).map(l => `\n${indent}<meta property="og:locale:alternate" content="${OG_LOCALE[l]}">`).join(''));

  const block = `\n  <!-- hreflang:start -->\n${alternates(url)}\n  <!-- hreflang:end -->`;
  if (/<link rel="canonical"[^>]*>/.test(html)) {
    html = html.replace(/(<link rel="canonical"[^>]*>)/, `$1${block}`);
  } else {
    html = html.replace(/(<\/head>)/, `${block}\n$1`);
  }

  // Elke versie, ook de Nederlandse bron, hoort bij zijn adres: i18n.js mag
  // hem niet naar een opgeslagen voorkeur omzetten. Op de echte tag testen,
  // niet op de losse tekst: pagina's die meta[name="i18n-static"] opvragen in
  // JavaScript bevatten die string ook.
  html = html.replace(STATIC_META, '');
  html = html.replace(/(<\/head>)/, `  <meta name="i18n-static" content="${lang}">\n$1`);
  return html;
}

/**
 * Taalknoppen worden echte links — anders honoreert Google de hreflang niet.
 * Ook al gelinkte knoppen (<a>) opnieuw opbouwen: rewriteLinks heeft de
 * link dan al naar de huidige taal omgezet, en de actieve markering hoort
 * bij de taal van deze versie, niet bij die van de bron.
 */
function linkifySwitcher(html, url, current) {
  return html.replace(
    /<(button|a) class="lang-btn([^"]*)" data-lang="([a-z]{2})"[^>]*>([^<]*)<\/\1>/g,
    (whole, tag, cls, l, label) => {
      const href = prefix(l) + url;
      const active = l === current ? ' active' : '';
      const base = cls.replace(/\s*active\s*/, '');
      return `<a class="lang-btn${base}${active}" data-lang="${l}" href="${href}" hreflang="${l}">${label}</a>`;
    }
  );
}

/** Pagina voor een oud /en/-adres: meteen door naar de Engelse root. */
function legacyRedirect(url, title) {
  const target = ORIGIN + url;
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="UTF-8">',
    `  <title>${title}</title>`,
    '  <meta name="robots" content="noindex, follow">',
    `  <link rel="canonical" href="${target}">`,
    `  <meta http-equiv="refresh" content="0; url=${url}">`,
    `  <script>location.replace(${JSON.stringify(url)}+location.search+location.hash)</script>`,
    '</head>',
    '<body>',
    `  <p>This page has moved to <a href="${url}">${target}</a>.</p>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

const LEGACY_MARK = /<meta http-equiv="refresh" content="0; url=\//;

/**
 * Schrijft alleen over gegenereerde bestanden. Staat er in de root een
 * handgeschreven pagina op dezelfde plek als een bronpagina, dan stoppen we
 * liever dan dat we hem stilletjes vervangen.
 */
function writeGenerated(out, html, ownedBy) {
  if (fs.existsSync(out)) {
    const existing = fs.readFileSync(out, 'utf8');
    if (!ownedBy(existing)) {
      console.error(`  ✗ ${path.relative(ROOT, out)} is niet gegenereerd; niet overschreven.\n` +
        `    De Nederlandse bron hoort in ${SOURCE}/. Verplaats de wijzigingen daarheen en verwijder dit bestand.`);
      process.exitCode = 1;
      return false;
    }
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html.replace(/\r\n?/g, '\n'));
  return true;
}

// ── uitvoeren ──────────────────────────────────────────────────────────────

let written = 0;
let redirects = 0;
const generated = [];

for (const page of pages) {
  for (const lang of LANGS) {
    const tr = translationsFor(page, lang);
    let html = page.html;

    html = absolutise(html, page.url);
    html = translateElements(html, tr);
    html = translateInlineAttrs(html, lang);
    html = setHead(html, {
      lang,
      url: page.url,
      title: dig(tr, 'meta.title'),
      description: plain(dig(tr, 'meta.description')) || plain(dig(tr, 'header.desc')),
    });
    html = rewriteLinks(html, lang);
    html = linkifySwitcher(html, page.url, lang);

    const out = path.join(ROOT, lang === DEFAULT ? '' : lang, page.rel);
    if (writeGenerated(out, html, (h) => isGenerated(h, lang))) {
      written++;
      generated.push(prefix(lang) + page.url);
    }

    if (lang === DEFAULT) {
      const legacy = path.join(LEGACY_DIR, page.rel);
      const title = plain(dig(tr, 'meta.title')) || 'OpenAEC Foundation';
      if (writeGenerated(legacy, legacyRedirect(page.url, title), (h) => LEGACY_MARK.test(h) || isGenerated(h, DEFAULT))) {
        redirects++;
      }
    }
  }

  // De Nederlandse bron krijgt dezelfde hreflang-verwijzingen, /nl/-links en
  // een linkbare taalschakelaar terug.
  let nl = setHead(page.html, { lang: SOURCE, url: page.url, title: null, description: null });
  nl = rewriteLinks(nl, SOURCE);
  nl = linkifySwitcher(nl, page.url, SOURCE);
  fs.writeFileSync(page.file, nl.replace(/\r\n?/g, '\n'));
  generated.push(prefix(SOURCE) + page.url);
}

console.log(`  ${pages.length} pagina's in ${SOURCE}/ × ${LANGS.length} talen → ${written} bestanden geschreven (Engels in de root)`);
console.log(`  ${redirects} doorverwijzingen in ${DEFAULT}/ naar de root`);
console.log(`  Nederlandse bron voorzien van hreflang, /${SOURCE}/-links en linkbare taalschakelaar`);

// Een Nederlandse pagina die nog in de hoofdmap staat (oude gewoonte, of een
// tak van vóór de verhuizing) wordt niet vertaald en zou de Engelse versie
// in de weg zitten. Melden, niet stilletjes laten staan.
for (const file of htmlFiles(ROOT)) {
  const rel = path.relative(ROOT, file);
  if (/^(nl|en|fr|tr|es|old|supercloud|nijmegen|presentation foundation|node_modules)\//.test(rel.split(path.sep).join('/'))) continue;
  const html = fs.readFileSync(file, 'utf8');
  if (/<meta name="i18n-page"/.test(html) && !STATIC_META.test(html)) {
    console.warn(`  ! ${rel}: vertaalbare pagina in de hoofdmap. De Nederlandse bron hoort in ${SOURCE}/${rel}.`);
  }
}

// ── sitemap bijwerken ──────────────────────────────────────────────────────

const smPath = path.join(ROOT, 'sitemap.xml');
if (fs.existsSync(smPath)) {
  let sm = fs.readFileSync(smPath, 'utf8');
  sm = sm.replace(/\n?[ \t]*<!-- i18n:start -->[\s\S]*?<!-- i18n:end -->/g, '');
  // De handgeschreven regels zijn de root-URL's, dus de Engelse versies. Alleen
  // de andere taalversies van pagina's die daar staan komen erbij. Een pagina
  // die lokaal klaarstaat maar nog niet gepubliceerd is, krijgt zo geen
  // taal-URL's die op de live site een 404 geven.
  const listed = new Set([...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].replace(ORIGIN, '')));
  const others = generated.filter(u => !listed.has(u));
  const published = others.filter(u => listed.has(u.replace(/^\/[a-z]{2}(?=\/)/, '')));
  const rows = published
    .map(u => `  <url><loc>${ORIGIN}${u}</loc><changefreq>monthly</changefreq><priority>0.5</priority></url>`)
    .join('\n');
  sm = sm.replace(/(\n)?<\/urlset>/, `\n  <!-- i18n:start -->\n${rows}\n  <!-- i18n:end -->\n</urlset>`);
  fs.writeFileSync(smPath, sm.replace(/\r\n?/g, '\n'));
  const skipped = others.length - published.length;
  console.log(`  sitemap.xml: ${published.length} taal-URL's toegevoegd` +
    (skipped ? `, ${skipped} overgeslagen (de pagina staat niet in de sitemap)` : ''));
}
