var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// guest-submit-worker.js
var REPO_OWNER = "jakobpajeken";
var REPO_NAME = "jlpchess";
var REPO_BRANCH = "main";
var BLOG_JSON_PATH = "data/blog.json";
var MAX_PENDING_GUEST_DRAFTS = 8;
var MAX_IMAGE_BYTES = 4 * 1024 * 1024;
var MAX_INLINE_IMAGES = 4;
var ALLOWED_IMAGE_TYPES = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" };
var MAX_GAMES_PER_POST = 8;
var ALLOWED_ORIGINS = [
  "https://jakobpajeken.github.io",
  "http://localhost:8722"
];
function corsHeaders(origin) {
  var allowed = ALLOWED_ORIGINS.indexOf(origin) !== -1 ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };
}
__name(corsHeaders, "corsHeaders");
function jsonResponse(obj, status, origin) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: corsHeaders(origin) });
}
__name(jsonResponse, "jsonResponse");
function ghHeaders(env) {
  return {
    "Authorization": "Bearer " + env.GITHUB_TOKEN,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "jlpchess-guest-submit-worker"
  };
}
__name(ghHeaders, "ghHeaders");
function contentsUrl(path) {
  return "https://api.github.com/repos/" + REPO_OWNER + "/" + REPO_NAME + "/contents/" + path;
}
__name(contentsUrl, "contentsUrl");
function utf8ToBase64(str) {
  var bytes = new TextEncoder().encode(str);
  var binary = "";
  for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
__name(utf8ToBase64, "utf8ToBase64");
function base64ToUtf8(b64) {
  var binary = atob((b64 || "").replace(/\s/g, ""));
  var bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
__name(base64ToUtf8, "base64ToUtf8");
function slugify(s) {
  return String(s || "").toLowerCase().normalize("NFKD").replace(/\p{Diacritic}/gu, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}
__name(slugify, "slugify");
function uniqueSlug(base, existingSlugs) {
  var slug = slugify(base) || "gastbeitrag";
  var i = 2;
  while (existingSlugs.indexOf(slug) !== -1) {
    slug = slugify(base) + "-" + i;
    i++;
  }
  return slug;
}
__name(uniqueSlug, "uniqueSlug");
function todayInBerlin() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(/* @__PURE__ */ new Date());
}
__name(todayInBerlin, "todayInBerlin");
function parseDataUrl(dataUrl) {
  var m = /^data:([^;]+);base64,([\s\S]*)$/.exec(dataUrl || "");
  if (!m) return null;
  return { mime: m[1], base64: m[2] };
}
__name(parseDataUrl, "parseDataUrl");
function base64ByteLength(b64) {
  var s = (b64 || "").replace(/[^A-Za-z0-9+/=]/g, "");
  var padding = s.slice(-2) === "==" ? 2 : s.slice(-1) === "=" ? 1 : 0;
  return Math.floor(s.length * 3 / 4) - padding;
}
__name(base64ByteLength, "base64ByteLength");
async function uploadImage(env, base64Content, ext, slug, hint) {
  var filename = (slug || "gast") + "-" + (hint || "bild") + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6) + ext;
  var path = "images/blog/" + filename;
  var putResp = await fetch(contentsUrl(path), {
    method: "PUT",
    headers: Object.assign({ "Content-Type": "application/json" }, ghHeaders(env)),
    body: JSON.stringify({
      message: "Add image " + filename + " via guest-editor.html",
      content: base64Content,
      branch: REPO_BRANCH,
      committer: { name: "Guest submission (jlpchess)", email: "jakobpajeken@gmail.com" }
    })
  });
  if (!putResp.ok) {
    var msg = "HTTP " + putResp.status;
    try {
      var errJson = await putResp.json();
      if (errJson.message) msg = errJson.message;
    } catch (e) {
    }
    throw new Error(msg);
  }
  return path;
}
__name(uploadImage, "uploadImage");
function sanitizeGames(rawGames) {
  if (!Array.isArray(rawGames)) return [];
  var out = [];
  rawGames.slice(0, MAX_GAMES_PER_POST).forEach(function(g) {
    if (!g || typeof g !== "object") return;
    var pgn = (g.pgn || "").toString().trim();
    if (!pgn) return;
    out.push({
      id: typeof g.id === "string" && /^[a-z0-9]{1,40}$/i.test(g.id) ? g.id : "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: (g.title || "").toString().trim() || "Untitled game",
      meta: (g.meta || "").toString().trim(),
      pgn
    });
  });
  return out;
}
__name(sanitizeGames, "sanitizeGames");
function normalizeDashes(value) {
  if (typeof value === "string") return value.replace(/—/g, "\u2013");
  if (Array.isArray(value)) return value.map(normalizeDashes);
  if (value && typeof value === "object") {
    var out = {};
    Object.keys(value).forEach(function(k) {
      out[k] = normalizeDashes(value[k]);
    });
    return out;
  }
  return value;
}
__name(normalizeDashes, "normalizeDashes");
var guest_submit_worker_default = {
  async fetch(request, env) {
    var origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405, origin);
    }
    if (!env.GITHUB_TOKEN || !env.GUEST_ACCESS_KEY) {
      return jsonResponse({ error: "Worker is not fully configured (missing secret)." }, 500, origin);
    }
    var body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ error: "Invalid JSON body" }, 400, origin);
    }
    if (body.accessKey !== env.GUEST_ACCESS_KEY) {
      return jsonResponse({ error: "Wrong or missing access key." }, 403, origin);
    }
    var lang = body.lang === "en" ? "en" : "de";
    var title = (body.title || "").toString().trim();
    var bodyParas = Array.isArray(body.body) ? body.body.map(function(p) {
      return (p || "").toString().trim();
    }).filter(Boolean) : [];
    if (!title || !bodyParas.length) {
      return jsonResponse({ error: "Title and body text cannot be empty." }, 400, origin);
    }
    var file;
    try {
      var getResp = await fetch(contentsUrl(BLOG_JSON_PATH) + "?ref=" + REPO_BRANCH, { headers: ghHeaders(env) });
      if (!getResp.ok) throw new Error("HTTP " + getResp.status);
      file = await getResp.json();
    } catch (e) {
      return jsonResponse({ error: "Could not read blog.json: " + e.message }, 502, origin);
    }
    var posts;
    try {
      posts = JSON.parse(base64ToUtf8(file.content) || "[]");
    } catch (e) {
      return jsonResponse({ error: "blog.json is not valid JSON." }, 502, origin);
    }
    if (!Array.isArray(posts)) posts = [];
    function langField(existing, text) {
      var obj = existing && typeof existing === "object" ? { en: existing.en || "", de: existing.de || "" } : { en: "", de: "" };
      obj[lang] = (text || "").toString().trim();
      return obj;
    }
    __name(langField, "langField");
    function langBody(existing, paras) {
      var obj = existing && typeof existing === "object" && !Array.isArray(existing) ? { en: existing.en || [], de: existing.de || [] } : { en: [], de: [] };
      obj[lang] = paras;
      return obj;
    }
    __name(langBody, "langBody");
    var idx = -1;
    if (body.slug) {
      idx = posts.findIndex(function(p) {
        return p.slug === body.slug && p.status === "draft" && p.submittedBy;
      });
    }
    var entry;
    if (idx !== -1) {
      entry = posts[idx];
    } else {
      var pendingCount = posts.filter(function(p) {
        return p.status === "draft" && p.submittedBy;
      }).length;
      if (pendingCount >= MAX_PENDING_GUEST_DRAFTS) {
        return jsonResponse({ error: "There are already several submissions waiting for review. Please try again later, or contact Jakob directly." }, 429, origin);
      }
      var existingSlugs = posts.map(function(p) {
        return p.slug;
      });
      entry = {
        slug: uniqueSlug(title, existingSlugs),
        status: "draft",
        date: todayInBerlin(),
        author: (body.guestName || "").toString().trim() || "Guest author",
        image: "",
        imageCaption: "",
        imageCredit: "",
        games: []
      };
      idx = posts.length;
      posts.push(entry);
    }
    var coverImagePath = null;
    var imageMap = {};
    if (body.coverImage && typeof body.coverImage === "object" && body.coverImage.base64) {
      var coverParsed = parseDataUrl(body.coverImage.base64);
      if (!coverParsed || !ALLOWED_IMAGE_TYPES[coverParsed.mime]) {
        return jsonResponse({ error: "Cover photo must be a JPG, PNG, WebP or GIF file." }, 400, origin);
      }
      if (base64ByteLength(coverParsed.base64) > MAX_IMAGE_BYTES) {
        return jsonResponse({ error: "Cover photo is too large (max 4 MB)." }, 400, origin);
      }
      try {
        coverImagePath = await uploadImage(env, coverParsed.base64, ALLOWED_IMAGE_TYPES[coverParsed.mime], entry.slug, "cover");
      } catch (e) {
        return jsonResponse({ error: "Cover photo upload failed: " + e.message }, 502, origin);
      }
    }
    var inlineImages = Array.isArray(body.inlineImages) ? body.inlineImages.slice(0, MAX_INLINE_IMAGES) : [];
    for (var ii = 0; ii < inlineImages.length; ii++) {
      var img = inlineImages[ii];
      if (!img || !img.id || !img.base64) continue;
      var imgParsed = parseDataUrl(img.base64);
      if (!imgParsed || !ALLOWED_IMAGE_TYPES[imgParsed.mime]) {
        return jsonResponse({ error: "One of the inserted images has an unsupported file type (use JPG, PNG, WebP or GIF)." }, 400, origin);
      }
      if (base64ByteLength(imgParsed.base64) > MAX_IMAGE_BYTES) {
        return jsonResponse({ error: "One of the inserted images is too large (max 4 MB each)." }, 400, origin);
      }
      try {
        imageMap[img.id] = await uploadImage(env, imgParsed.base64, ALLOWED_IMAGE_TYPES[imgParsed.mime], entry.slug, "img");
      } catch (e) {
        return jsonResponse({ error: "Image upload failed: " + e.message }, 502, origin);
      }
    }
    if (Object.keys(imageMap).length) {
      bodyParas = bodyParas.map(function(para) {
        Object.keys(imageMap).forEach(function(id) {
          para = para.split("pending:" + id).join(imageMap[id]);
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
    if (coverImagePath) entry.image = coverImagePath;
    entry.imageCaption = langField(entry.imageCaption, body.imageCaption);
    entry.imageCredit = (body.imageCredit || "").toString().trim();
    entry.games = sanitizeGames(body.games);
    entry.status = "draft";
    entry.submittedBy = {
      name: (body.guestName || "").toString().trim(),
      contact: (body.guestContact || "").toString().trim(),
      submittedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    posts[idx] = entry;
    try {
      var putResp = await fetch(contentsUrl(BLOG_JSON_PATH), {
        method: "PUT",
        headers: Object.assign({ "Content-Type": "application/json" }, ghHeaders(env)),
        body: JSON.stringify({
          message: "Add guest blog draft via guest-editor.html (" + (entry.submittedBy.name || "anonymous") + ")",
          content: utf8ToBase64(JSON.stringify(normalizeDashes(posts), null, 2) + "\n"),
          branch: REPO_BRANCH,
          sha: file.sha,
          committer: { name: "Guest submission (jlpchess)", email: "jakobpajeken@gmail.com" }
        })
      });
      if (!putResp.ok) {
        var errMsg = "HTTP " + putResp.status;
        try {
          var errJson = await putResp.json();
          if (errJson.message) errMsg = errJson.message;
        } catch (e) {
        }
        return jsonResponse({ error: "Saving failed: " + errMsg }, 502, origin);
      }
    } catch (e) {
      return jsonResponse({ error: "Worker error: " + e.message }, 500, origin);
    }
    return jsonResponse({ ok: true, slug: entry.slug, lang, coverImagePath, imageMap }, 200, origin);
  }
};
export {
  guest_submit_worker_default as default
};
//# sourceMappingURL=guest-submit-worker.js.map
