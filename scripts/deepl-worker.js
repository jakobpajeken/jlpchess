/*
 * Cloudflare Worker — DeepL translation proxy for editor.html
 * ==============================================================
 * Why this exists: DeepL's API requires a secret key and doesn't allow
 * direct calls from browser JavaScript (no CORS). This tiny Worker sits
 * in between — the editor calls this Worker (which is safe to call from
 * a public page, it doesn't expose anything), and the Worker calls DeepL
 * using the key, which stays only on Cloudflare's side and never reaches
 * the browser or the website's own source code.
 *
 * Setup (see chat for the full walkthrough):
 *   1. Create a Worker in the Cloudflare dashboard, paste this file in.
 *   2. Worker settings -> Variables -> add a SECRET (not a plain text
 *      variable) named DEEPL_API_KEY with your DeepL API key as the value.
 *   3. Deploy. Copy the Worker's URL (looks like
 *      https://<name>.<your-subdomain>.workers.dev) and give it to
 *      Claude so it can be wired into editor.html.
 *
 * If you're on DeepL API Pro (not Free), change the DEEPL_URL below from
 * api-free.deepl.com to api.deepl.com — that's the only difference.
 */

var DEEPL_URL = 'https://api-free.deepl.com/v2/translate';

/* Only these origins may use this Worker — keeps a stranger who finds
   the Worker's URL from spending your DeepL quota. Add your custom
   domain here too, once you have one (e.g. "https://jakobpajeken.com"). */
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

export default {
  async fetch(request, env){
    var origin = request.headers.get('Origin') || '';

    if(request.method === 'OPTIONS'){
      return new Response(null, { headers: corsHeaders(origin) });
    }
    if(request.method !== 'POST'){
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405, headers: corsHeaders(origin)
      });
    }

    var body;
    try{
      body = await request.json();
    }catch(e){
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400, headers: corsHeaders(origin)
      });
    }
    var text = body && body.text;
    if(!text || typeof text !== 'string'){
      return new Response(JSON.stringify({ error: 'Missing "text" field' }), {
        status: 400, headers: corsHeaders(origin)
      });
    }
    /* defaults to EN->DE (what editor.html always sends); a caller can
       also request the other direction, e.g. { text, source: "DE", target: "EN" } */
    var sourceLang = (body.source || 'EN').toUpperCase();
    var targetLang = (body.target || 'DE').toUpperCase();
    if(!env.DEEPL_API_KEY){
      return new Response(JSON.stringify({ error: 'DEEPL_API_KEY is not configured on this Worker' }), {
        status: 500, headers: corsHeaders(origin)
      });
    }

    try{
      var deeplResp = await fetch(DEEPL_URL, {
        method: 'POST',
        headers: {
          'Authorization': 'DeepL-Auth-Key ' + env.DEEPL_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text: [text],
          source_lang: sourceLang,
          target_lang: targetLang
        })
      });
      if(!deeplResp.ok){
        var errText = await deeplResp.text();
        return new Response(JSON.stringify({ error: 'DeepL error (' + deeplResp.status + '): ' + errText }), {
          status: 502, headers: corsHeaders(origin)
        });
      }
      var data = await deeplResp.json();
      var translatedText = (data.translations && data.translations[0] && data.translations[0].text) || '';
      return new Response(JSON.stringify({ translatedText: translatedText }), {
        headers: corsHeaders(origin)
      });
    }catch(err){
      return new Response(JSON.stringify({ error: 'Worker error: ' + err.message }), {
        status: 500, headers: corsHeaders(origin)
      });
    }
  }
};
