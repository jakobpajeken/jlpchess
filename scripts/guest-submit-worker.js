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
 *  - Anti-spam: if the guest link (or GUEST_ACCESS_KEY) leaks, someone
 *    could otherwise flood blog.json with junk drafts. Two independent
 *    defenses: (1) MAX_PENDING_GUEST_DRAFTS below caps how many unreviewed
 *    guest drafts can pile up at once — once the cap is hit, new
 *    submissions are rejected until Jakob clears some out. (2) Rotating
 *    GUEST_ACCESS_KEY in the Worker's secrets is an instant kill switch –
 *    it invalidates every link built with the old key immediately, no
 *    redeploy of this file needed.
 *  - Games, links and images: guest-editor.html offers the same "Partien
 *    hinzufügen" / insert-link / insert-image tools as Jakob's own
 *    editor.html. Games are plain JSON embedded on the post entry itself
 *    (entry.games), no extra GitHub write involved. Images are the one
 *    place this Worker writes somewhere OTHER than blog.json – a cover
 *    photo or an inline image gets uploaded to images/blog/ via the same
 *    GITHUB_TOKEN, size- and type-checked first (see MAX_IMAGE_BYTES /
 *    ALLOWED_IMAGE_TYPES below) so this can't be used to dump arbitrary or
 *    oversized files into the repo.
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

/* Anti-spam ceiling: if someone gets hold of the guest link (or the access
   key leaks), this caps the damage to "at most this many junk drafts",
   never "unlimited". Once this many guest drafts are sitting unreviewed,
   the Worker refuses NEW submissions (existing guests can still update
   their own already-submitted draft) until Jakob publishes or deletes
   some via editor.html. No extra Cloudflare setup needed – it just counts
   what's already in blog.json on every request. */
var MAX_PENDING_GUEST_DRAFTS = 8;

/* Images: guests can attach a cover photo and/or images inline in the
   text, uploaded to images/blog/ via this Worker's own GITHUB_TOKEN
   (guests never touch GitHub directly). Bounded so a submission can't be
   used to dump huge or unlimited files into the repo. */
var MAX_IMAGE_BYTES = 4 * 1024 * 1024; /* 4 MB per image, decoded */
var MAX_INLINE_IMAGES = 4; /* per submission, in addition to one cover photo */
var ALLOWED_IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

/* Games: embedded directly on the post entry (entry.games), same shape
   editor.html itself writes – no separate GitHub write needed. */
var MAX_GAMES_PER_POST = 8;

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
    .normalize('NFKD').replace(/\p{Diacritic}/gu, '')
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

/* splits a "data:<mime>;base64,<data>" URL (what a browser's FileReader
   produces) into its parts; null if it doesn't look like one at all */
function parseDataUrl(dataUrl){
  var m = /^data:([^;]+);base64,([\s\S]*)$/.exec(dataUrl || '');
  if(!m) return null;
  return { mime: m[1], base64: m[2] };
}
function base64ByteLength(b64){
  var s = (b64 || '').replace(/[^A-Za-z0-9+/=]/g, '');
  var padding = s.slice(-2) === '==' ? 2 : (s.slice(-1) === '=' ? 1 : 0);
  return Math.floor(s.length * 3 / 4) - padding;
}
/* uploads one already-validated image to images/blog/ and returns its
   repo-relative path. Each filename is unique (timestamp + random), so
   this is always a fresh file – never overwrites an existing one, no
   need to look up a sha first the way updating blog.json does. */
async function uploadImage(env, base64Content, ext, slug, hint){
  var filename = (slug || 'gast') + '-' + (hint || 'bild') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6) + ext;
  var path = 'images/blog/' + filename;
  var putResp = await fetch(contentsUrl(path), {
    method: 'PUT',
    headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders(env)),
    body: JSON.stringify({
      message: 'Add image ' + filename + ' via guest-editor.html',
      content: base64Content,
      branch: REPO_BRANCH,
      committer: { name: 'Guest submission (jlpchess)', email: 'jakobpajeken@gmail.com' }
    })
  });
  if(!putResp.ok){
    var msg = 'HTTP ' + putResp.status;
    try{ var errJson = await putResp.json(); if(errJson.message) msg = errJson.message; }catch(e){}
    throw new Error(msg);
  }
  return path;
}
/* keeps only well-formed games, caps how many a single post can carry.
   Title/meta are stored as plain strings (not the bilingual {en,de}
   shape the rest of the post uses) – same as editor.html's own game
   entries, since pickLang()/previewLang() already accept a plain string
   anywhere on the site. */
function sanitizeGames(rawGames){
  if(!Array.isArray(rawGames)) return [];
  var out = [];
  rawGames.slice(0, MAX_GAMES_PER_POST).forEach(function(g){
    if(!g || typeof g !== 'object') return;
    var pgn = (g.pgn || '').toString().trim();
    if(!pgn) return;
    out.push({
      id: (typeof g.id === 'string' && /^[a-z0-9]{1,40}$/i.test(g.id)) ? g.id : ('g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
      title: (g.title || '').toString().trim() || 'Untitled game',
      meta: (g.meta || '').toString().trim(),
      pgn: pgn
    });
  });
  return out;
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
      return jsonResponse({ error: 'Wrong or missing access key.' }, 403, origin);
    }

    var lang = body.lang === 'en' ? 'en' : 'de';
    var title = (body.title || '').toString().trim();
    var bodyParas = Array.isArray(body.body)
      ? body.body.map(function(p){ return (p || '').toString().trim(); }).filter(Boolean)
      : [];
    if(!title || !bodyParas.length){
      return jsonResponse({ error: 'Title and body text cannot be empty.' }, 400, origin);
    }

    var file;
    try{
      var getResp = await fetch(contentsUrl(BLOG_JSON_PATH) + '?ref=' + REPO_BRANCH, { headers: ghHeaders(env) });
      if(!getResp.ok) throw new Error('HTTP ' + getResp.status);
      file = await getResp.json();
    }catch(e){
      return jsonResponse({ error: 'Could not read blog.json: ' + e.message }, 502, origin);
    }

    var posts;
    try{ posts = JSON.parse(base64ToUtf8(file.content) || '[]'); }
    catch(e){ return jsonResponse({ error: 'blog.json is not valid JSON.' }, 502, origin); }
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
      var pendingCount = posts.filter(function(p){ return p.status === 'draft' && p.submittedBy; }).length;
      if(pendingCount >= MAX_PENDING_GUEST_DRAFTS){
        return jsonResponse({ error: 'There are already several submissions waiting for review. Please try again later, or contact Jakob directly.' }, 429, origin);
      }
      var existingSlugs = posts.map(function(p){ return p.slug; });
      entry = {
        slug: uniqueSlug(title, existingSlugs),
        status: 'draft',
        date: todayInBerlin(),
        author: (body.guestName || '').toString().trim() || 'Guest author',
        image: '', imageCaption: '', imageCredit: '',
        games: []
      };
      idx = posts.length;
      posts.push(entry);
    }

    /* ---- images: upload a cover photo and/or any inline images the
       guest inserted, then swap their "pending:<id>" placeholders in the
       body text for the real path GitHub just gave them. Validated here
       (never trust the client's own size/type check) before anything is
       written. ---- */
    var coverImagePath = null;
    var imageMap = {};
    if(body.coverImage && typeof body.coverImage === 'object' && body.coverImage.base64){
      var coverParsed = parseDataUrl(body.coverImage.base64);
      if(!coverParsed || !ALLOWED_IMAGE_TYPES[coverParsed.mime]){
        return jsonResponse({ error: 'Cover photo must be a JPG, PNG, WebP or GIF file.' }, 400, origin);
      }
      if(base64ByteLength(coverParsed.base64) > MAX_IMAGE_BYTES){
        return jsonResponse({ error: 'Cover photo is too large (max 4 MB).' }, 400, origin);
      }
      try{
        coverImagePath = await uploadImage(env, coverParsed.base64, ALLOWED_IMAGE_TYPES[coverParsed.mime], entry.slug, 'cover');
      }catch(e){
        return jsonResponse({ error: 'Cover photo upload failed: ' + e.message }, 502, origin);
      }
    }
    var inlineImages = Array.isArray(body.inlineImages) ? body.inlineImages.slice(0, MAX_INLINE_IMAGES) : [];
    for(var ii = 0; ii < inlineImages.length; ii++){
      var img = inlineImages[ii];
      if(!img || !img.id || !img.base64) continue;
      var imgParsed = parseDataUrl(img.base64);
      if(!imgParsed || !ALLOWED_IMAGE_TYPES[imgParsed.mime]){
        return jsonResponse({ error: 'One of the inserted images has an unsupported file type (use JPG, PNG, WebP or GIF).' }, 400, origin);
      }
      if(base64ByteLength(imgParsed.base64) > MAX_IMAGE_BYTES){
        return jsonResponse({ error: 'One of the inserted images is too large (max 4 MB each).' }, 400, origin);
      }
      try{
        imageMap[img.id] = await uploadImage(env, imgParsed.base64, ALLOWED_IMAGE_TYPES[imgParsed.mime], entry.slug, 'img');
      }catch(e){
        return jsonResponse({ error: 'Image upload failed: ' + e.message }, 502, origin);
      }
    }
    if(Object.keys(imageMap).length){
      bodyParas = bodyParas.map(function(para){
        Object.keys(imageMap).forEach(function(id){
          para = para.split('pending:' + id).join(imageMap[id]);
        });
        return para;
      });
    }

    entry.title = langField(entry.title, title);
    entry.category = langField(entry.category, body.category);
    entry.excerpt = langField(entry.excerpt, body.excerpt);
    entry.lead = langField(entry.lead, body.lead);
    entry.quote = langField(entry.quote, body.quote);
    entry.body = langBody(entry.body, bodyParas);
    if(coverImagePath) entry.image = coverImagePath; /* else: leave whatever it already was untouched */
    entry.imageCaption = langField(entry.imageCaption, body.imageCaption);
    entry.imageCredit = (body.imageCredit || '').toString().trim();
    entry.games = sanitizeGames(body.games);
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
          committer: { name: 'Guest submission (jlpchess)', email: 'jakobpajeken@gmail.com' }
        })
      });
      if(!putResp.ok){
        var errMsg = 'HTTP ' + putResp.status;
        try{ var errJson = await putResp.json(); if(errJson.message) errMsg = errJson.message; }catch(e){}
        return jsonResponse({ error: 'Saving failed: ' + errMsg }, 502, origin);
      }
    }catch(e){
      return jsonResponse({ error: 'Worker error: ' + e.message }, 500, origin);
    }

    return jsonResponse({ ok: true, slug: entry.slug, lang: lang, coverImagePath: coverImagePath, imageMap: imageMap }, 200, origin);
  }
};
