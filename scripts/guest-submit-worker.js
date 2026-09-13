/*
 * Cloudflare Worker — guest blog submission proxy for guest-editor.html
 * ==============================================================
 * Why this exists: guest-editor.html lets someone OTHER than Jakob write
 * a blog draft and submit it, without ever needing his GitHub account or
 * any write access to the repository themselves. This Worker is the only
 * thing that actually holds write credentials — it sits between the
 * public guest-editor.html page and GitHub's API, the same pattern as
 * deepl-worker.js already uses for translation.
 *
 * Trust model:
 *  - The real GITHUB_TOKEN (a fine-grained PAT scoped to ONLY this repo,
 *    Contents: Read and write) lives ONLY as a Worker secret. It is never
 *    sent to, or visible from, guest-editor.html or any guest's browser.
 *  - GUEST_ACCESS_KEY is a separate, much lower-stakes shared passphrase
 *    – it just gates who can submit a draft at all (baked into the link
 *    Jakob shares, e.g. guest-editor.html?key=...), so a stranger who
 *    stumbles on the Worker's bare URL can't spam submissions. It is NOT
 *    a GitHub credential and grants no access beyond "create/update one
 *    draft blog post".
 *  - Every submission is written with status "draft" – exactly the same
 *    status the site already treats as invisible to the public (see
 *    index.html's isBlogPostPubliclyVisible). Nothing a guest submits
 *    ever goes live on its own; Jakob still has to open it in the normal
 *    editor.html and explicitly publish it, same as anything he writes
 *    himself. This Worker cannot set status to anything but "draft".
 *  - A guest can only ever update THEIR OWN previous submission (matched
 *    by the slug the Worker itself generated and returned to them, never
 *    guessed), and only while it's still a draft – never an already
 *    published post, and never anything Jakob has since published.
 *
 * Setup (see chat for the full walkthrough):
 *   1. Create a SECOND Worker in the Cloudflare dashboard (separate from
 *      the DeepL one), paste this file in.
 *   2. Worker settings -> Variables -> add TWO SECRETS (not plain text):
 *        GITHUB_TOKEN       - a fine-grained GitHub personal access
 *                             token, repository access limited to ONLY
 *                             jakobpajeken/jlpchess, permission
 *                             "Contents: Read and write". Create it at
 *                             github.com/settings/personal-access-tokens
 *                             -- never paste this into chat, only into
 *                             Cloudflare's own secret field.
 *        GUEST_ACCESS_KEY   - any password-like string you make up
 *                             yourself (e.g. a long random word). This is
 *                             what goes in the link you send guests.
 *   3. Deploy. Copy the Worker's URL and give it to Claude so it can be
 *      wired into guest-editor.html.
 *   4. The link to send a guest is:
 *      https://jakobpajeken.github.io/jlpchess/guest-editor.html?key=<GUEST_ACCESS_KEY>
 */

var REPO_OWNER = 'jakobpajeken';
var REPO_NAME = 'jlpchess';
var REPO_BRANCH = 'main';
var BLOG_JSON_PATH = 'data/blog.json';

var ALLOWED_ORIGINS = [
  'https://jakobpajeken.github.io',
  'http://localhost:8722'
];

function corsHeaders(origin){
  var allowed = ALLOWED_ORIGINS.indexOf(origin) !== -1 ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
}

function jsonResponse(obj, status, origin){
  return new Response(JSON.stringify(obj), { status: status || 200, headers: corsHeaders(origin) });
}

function ghHeaders(env){
  return {
    'Authorization': 'Bearer ' + env.GITHUB_TOKEN,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'jlpchess-guest-submit-worker'
  };
}
function contentsUrl(path){
  return 'https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME + '/contents/' + path;
}
function utf8ToBase64(str){
  var bytes = new TextEncoder().encode(str);
  var binary = '';
  for(var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
function base64ToUtf8(b64){
  var binary = atob((b64 || '').replace(/\s/g, ''));
  var bytes = new Uint8Array(binary.length);
  for(var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function slugify(s){
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
function uniqueSlug(base, existingSlugs){
  var slug = slugify(base) || 'gastbeitrag';
  var i = 2;
  while(existingSlugs.indexOf(slug) !== -1){
    slug = slugify(base) + '-' + i;
    i++;
  }
  return slug;
}
function todayInBerlin(){
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());
}
/* same house style as editor.html's own normalizeDashes – applied here
   too since a guest's browser goes through none of the site's own JS */
function normalizeDashes(value){
  if(typeof value === 'string') return value.replace(/—/g, '–');
  if(Array.isArray(value)) return value.map(normalizeDashes);
  if(value && typeof value === 'object'){
    var out = {};
    Object.keys(value).forEach(function(k){ out[k] = normalizeDashes(value[k]); });
    return out;
  }
  return value;
}

export default {
  async fetch(request, env){
    var origin = request.headers.get('Origin') || '';

    if(request.method === 'OPTIONS'){
      return new Response(null, { headers: corsHeaders(origin) });
    }
    if(request.method !== 'POST'){
      return jsonResponse({ error: 'Method not allowed' }, 405, origin);
    }
    if(!env.GITHUB_TOKEN || !env.GUEST_ACCESS_KEY){
      return jsonResponse({ error: 'Worker is not fully configured (missing secret).' }, 500, origin);
    }

    var body;
    try{ body = await request.json(); }
    catch(e){ return jsonResponse({ error: 'Invalid JSON body' }, 400, origin); }

    if(body.accessKey !== env.GUEST_ACCESS_KEY){
      return jsonResponse({ error: 'Falscher oder fehlender Zugangsschlüssel.' }, 403, origin);
    }

    var lang = body.lang === 'en' ? 'en' : 'de';
    var title = (body.title || '').toString().trim();
    var bodyParas = Array.isArray(body.body)
      ? body.body.map(function(p){ return (p || '').toString().trim(); }).filter(Boolean)
      : [];
    if(!title || !bodyParas.length){
      return jsonResponse({ error: 'Titel und Haupttext dürfen nicht leer sein.' }, 400, origin);
    }

    var file;
    try{
      var getResp = await fetch(contentsUrl(BLOG_JSON_PATH) + '?ref=' + REPO_BRANCH, { headers: ghHeaders(env) });
      if(!getResp.ok) throw new Error('HTTP ' + getResp.status);
      file = await getResp.json();
    }catch(e){
      return jsonResponse({ error: 'Konnte blog.json nicht lesen: ' + e.message }, 502, origin);
    }

    var posts;
    try{ posts = JSON.parse(base64ToUtf8(file.content) || '[]'); }
    catch(e){ return jsonResponse({ error: 'blog.json ist kein gültiges JSON.' }, 502, origin); }
    if(!Array.isArray(posts)) posts = [];

    function langField(existing, text){
      var obj = (existing && typeof existing === 'object') ? { en: existing.en || '', de: existing.de || '' } : { en: '', de: '' };
      obj[lang] = (text || '').toString().trim();
      return obj;
    }
    function langBody(existing, paras){
      var obj = (existing && typeof existing === 'object' && !Array.isArray(existing))
        ? { en: existing.en || [], de: existing.de || [] } : { en: [], de: [] };
      obj[lang] = paras;
      return obj;
    }

    var idx = -1;
    if(body.slug){
      idx = posts.findIndex(function(p){ return p.slug === body.slug && p.status === 'draft' && p.submittedBy; });
    }

    var entry;
    if(idx !== -1){
      /* updating the guest's own earlier submission, still a draft */
      entry = posts[idx];
    } else {
      var existingSlugs = posts.map(function(p){ return p.slug; });
      entry = {
        slug: uniqueSlug(title, existingSlugs),
        status: 'draft',
        date: todayInBerlin(),
        author: (body.guestName || '').toString().trim() || 'Gastbeitrag',
        image: '', imageCaption: '', imageCredit: '',
        games: []
      };
      idx = posts.length;
      posts.push(entry);
    }

    entry.title = langField(entry.title, title);
    entry.category = langField(entry.category, body.category);
    entry.excerpt = langField(entry.excerpt, body.excerpt);
    entry.lead = langField(entry.lead, body.lead);
    entry.quote = langField(entry.quote, body.quote);
    entry.body = langBody(entry.body, bodyParas);
    entry.status = 'draft'; /* never anything else, no matter what a submission claims */
    /* not part of the public schema – purely so the editor's blog list
       (and this Worker's own idx lookup above) can tell a guest draft
       apart from one of Jakob's own, and so he knows who to credit /
       write back to */
    entry.submittedBy = {
      name: (body.guestName || '').toString().trim(),
      contact: (body.guestContact || '').toString().trim(),
      submittedAt: new Date().toISOString()
    };
    posts[idx] = entry;

    try{
      var putResp = await fetch(contentsUrl(BLOG_JSON_PATH), {
        method: 'PUT',
        headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders(env)),
        body: JSON.stringify({
          message: 'Add guest blog draft via guest-editor.html (' + (entry.submittedBy.name || 'anonymous') + ')',
          content: utf8ToBase64(JSON.stringify(normalizeDashes(posts), null, 2) + '\n'),
          branch: REPO_BRANCH,
          sha: file.sha,
          committer: { name: 'Gastbeitrag (jlpchess)', email: 'jakobpajeken@gmail.com' }
        })
      });
      if(!putResp.ok){
        var errMsg = 'HTTP ' + putResp.status;
        try{ var errJson = await putResp.json(); if(errJson.message) errMsg = errJson.message; }catch(e){}
        return jsonResponse({ error: 'Speichern fehlgeschlagen: ' + errMsg }, 502, origin);
      }
    }catch(e){
      return jsonResponse({ error: 'Worker error: ' + e.message }, 500, origin);
    }

    return jsonResponse({ ok: true, slug: entry.slug, lang: lang }, 200, origin);
  }
};
