"""
Two-way bridge between data/games.pgn (a real PGN database you can open and
edit directly in ChessBase or any other PGN-aware tool) and this site's own
data/games.json + data/blog.json (where the "My most memorable games"
section and blog-embedded games actually live).

Run every cycle by scripts/sync-once.ps1, right before it checks for
anything to commit — so any edit made in ChessBase (and saved to
games.pgn) rides along on the next normal auto-sync push, same as any
other change to this repo.

How the matching works: every game gets a stable "WebsiteId" custom PGN
header tag the first time it's synced. That tag is what lets a later run
recognise "this is the same game" even after ChessBase has reformatted the
movetext, added comments, changed the Elo tags, etc. — matching is never
done by comparing PGN text.

Fully two-way:
  - A game edited in ChessBase (comments, NAGs, variations, moves — saved
    back into games.pgn) has its update reflected in the matching
    games.json/blog.json entry.
  - A game added directly in ChessBase — pasted in fresh, no WebsiteId yet
    — is picked up as new and added as its own entry in games.json (the
    "My most memorable games" list), with a stable id assigned so it's
    recognised from then on. There's no way to know from the database
    alone which blog post (if any) it belongs "inside", so new database
    games always land in games.json, not embedded in a post — move it
    into a post afterwards with editor.html if that's where it belongs.
  - A game added through editor.html (no WebsiteId yet, since it's brand
    new) is added to games.pgn the same way, so it becomes available to
    open and annotate in ChessBase too.

Every game's PGN is also parsed into a structured "annotations" tree
(comments, NAGs as symbols, and nested variations, arbitrarily deep) and
stored as a second field alongside "pgn" — see extract_annotations() below
for the exact shape. That's what the site actually renders; "pgn" itself
stays the flat mainline text chess.js (the board-stepping library used by
the site) needs, which cannot represent variations or NAGs at all, hence
the second, richer field just for display.

Titles, the short "meta" line, and which blog post a game is embedded in
are intentionally left alone here for games that already exist on the
site — those stay owned by editor.html; only "pgn" and "annotations" are
synced for them. A newly-discovered database game DOES get its title set
(from the PGN's White/Black tags, since it has no title yet at all).

Requires the "chess" package (`python -m pip install chess`) - already
installed on this machine as of when this script was written.
"""
import json
import os
import re
import sys
import io
import urllib.request
import urllib.parse
import urllib.error

try:
    import chess.pgn
except ImportError:
    sys.stderr.write("Missing dependency: run `python -m pip install chess`\n")
    sys.exit(1)

# Same translation cascade editor.html's JS uses for everything else on the
# site (see translateChunk() there) — DeepL via Jakob's own Cloudflare
# Worker proxy first, MyMemory as the fallback. Google Translate's public
# endpoint (the third option in the JS version) is skipped here: it works
# fine from a real browser but blocks plain server-side requests like this
# script's as "automated queries", so there's no point trying it.
DEEPL_PROXY_URL = "https://jlpdeepl.jakobpajeken.workers.dev"


def _http_post_json(url, payload, timeout=15):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _http_get_json(url, timeout=15):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def translate_via_deepl(text, source, target):
    data = _http_post_json(DEEPL_PROXY_URL, {"text": text, "source": source, "target": target})
    translated = data.get("translatedText")
    if not translated:
        raise RuntimeError(data.get("error") or "empty response")
    return translated


def translate_via_mymemory(text, source, target):
    url = ("https://api.mymemory.translated.net/get?q=" + urllib.parse.quote(text)
           + "&langpair=" + source.lower() + "|" + target.lower())
    data = _http_get_json(url)
    translated = (data.get("responseData") or {}).get("translatedText")
    if not translated or re.search(r"MYMEMORY WARNING|INVALID LANGPAIR|NO QUERY SPECIFIED", translated, re.I):
        raise RuntimeError("no usable translation")
    return translated


def translate_text(text, source, target):
    """Best-effort translation with the same fallback order as the site's
    own JS translator. Returns the ORIGINAL text unchanged if every service
    fails (offline, proxy down, etc.) rather than raising — a sync run
    should never hard-fail just because translation is unavailable right
    now; it'll simply try again next cycle."""
    text = (text or "").strip()
    if not text:
        return ""
    try:
        return translate_via_deepl(text, source, target).strip()
    except Exception:
        pass
    try:
        return translate_via_mymemory(text, source, target).strip()
    except Exception:
        pass
    return text

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GAMES_JSON = os.path.join(REPO_ROOT, "data", "games.json")
BLOG_JSON = os.path.join(REPO_ROOT, "data", "blog.json")
PGN_PATH = os.path.join(REPO_ROOT, "data", "games.pgn")

# The common subset of the standard NAG (Numeric Annotation Glyph) table —
# move-quality and position-evaluation symbols, which cover the vast
# majority of what ChessBase (or any annotator) actually uses in practice.
# Anything outside this set (rare ones like zugzwang, time-pressure,
# counterplay symbols) is simply omitted rather than guessed at.
NAG_SYMBOLS = {
    1: "!", 2: "?", 3: "!!", 4: "??", 5: "!?", 6: "?!",
    10: "=", 13: "∞",             # unclear (infinity symbol)
    14: "⩲", 15: "⩱",        # slight edge, white/black
    16: "±", 17: "∓",        # moderate edge, white/black
    18: "+−", 19: "−+",      # decisive edge, white/black
}


def nag_symbol(n):
    return NAG_SYMBOLS.get(n, "")


def slugify(text):
    text = (text or "").lower()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-") or "game"


def pick_title_en(title):
    if isinstance(title, dict):
        return title.get("en") or title.get("de") or ""
    return title or ""


def load_json(path):
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def export_game(game):
    exporter = chess.pgn.StringExporter(headers=True, variations=True, comments=True)
    return game.accept(exporter).strip()


def build_comment_cache(tree):
    """Flattens an existing annotations tree (mainline + every nested
    variation) into { (ply, san): {"de":..., "en":...} }, so a later
    extraction run can reuse a comment's already-translated pair instead of
    calling the translation API again for text that hasn't changed since
    last time. Keyed by (ply, san) rather than ply alone, since a mainline
    move and a variation move can share the same ply number but are
    different moves entirely."""
    cache = {}

    def walk(line):
        for entry in line or []:
            comment = entry.get("comment")
            if isinstance(comment, dict) and (comment.get("de") or comment.get("en")):
                cache[(entry.get("ply"), entry.get("san"))] = comment
            for variation in entry.get("variations") or []:
                walk(variation)

    walk(tree or [])
    return cache


def translate_comment(raw_comment, cache_key, cache):
    """Comments are assumed to be written in German — ChessBase is Jakob's
    own working tool, and German is the natural language for his own
    analysis notes. The original German is kept byte-for-byte as typed (in
    "de"); "en" is filled in by machine translation. Reuses a cached
    translation instead of re-calling the API when this exact German text
    was already seen at this exact move last time, so an unattended sync
    running every ~10s doesn't re-translate every comment in the database
    on every single cycle — only ones that actually changed."""
    text = (raw_comment or "").strip()
    if not text:
        return {"de": "", "en": ""}
    cached = cache.get(cache_key)
    if cached and (cached.get("de") or "").strip() == text:
        return cached
    return {"de": text, "en": translate_text(text, "DE", "EN")}


def serialize_line(node, board, cache):
    """node: a GameNode with a move set (never the game root). board: the
    position immediately BEFORE node.move. Returns a list of move dicts
    describing this line (following each node's own mainline child, i.e.
    variations[0]) up to wherever it ends; any sibling alternatives at a
    given move are attached to that move's dict as a "variations" list of
    further such lists, recursively — so a variation can itself contain
    its own sub-variations, matching what PGN itself allows. cache: the
    (ply, san) -> {de, en} lookup built by build_comment_cache() from
    whatever annotations tree this game had before this run."""
    line = []
    cur = node
    cur_board = board
    while cur is not None:
        san = cur_board.san(cur.move)
        next_board = cur_board.copy()
        next_board.push(cur.move)
        entry = {
            "ply": cur.ply(),
            "san": san,
            "nag": "".join(nag_symbol(n) for n in sorted(cur.nags) if nag_symbol(n)),
            "comment": translate_comment(cur.comment, (cur.ply(), san), cache),
        }
        children = cur.variations
        if len(children) > 1:
            entry["variations"] = [serialize_line(child, next_board, cache) for child in children[1:]]
        line.append(entry)
        cur_board = next_board
        cur = children[0] if children else None
    return line


def extract_annotations(game, old_annotations=None):
    cache = build_comment_cache(old_annotations)
    mainline = game.variations
    return serialize_line(mainline[0], game.board(), cache) if mainline else []


def parse_pgn_database(path):
    """Returns an ordered list of (website_id_or_None, chess.pgn.Game) for
    every game in the file, in file order — website_id is None for a game
    that has no WebsiteId tag yet (new, direct-in-ChessBase content)."""
    games = []
    if not os.path.exists(path):
        return games
    with open(path, encoding="utf-8") as f:
        while True:
            game = chess.pgn.read_game(f)
            if game is None:
                break
            games.append((game.headers.get("WebsiteId") or None, game))
    return games


def make_game_from_pgn_text(pgn_text, website_id, website_source):
    game = chess.pgn.read_game(io.StringIO(pgn_text))
    if game is None:
        return None
    game.headers["WebsiteId"] = website_id
    game.headers["WebsiteSource"] = website_source
    return game


def default_title_from_headers(game):
    white = game.headers.get("White", "").strip()
    black = game.headers.get("Black", "").strip()
    if white and black and white != "?" and black != "?":
        return white + " vs " + black
    return game.headers.get("Event", "").strip() or "Untitled game"


def main():
    games_data = load_json(GAMES_JSON)
    blog_data = load_json(BLOG_JSON)
    if games_data is None:
        games_data = []
    if blog_data is None:
        blog_data = []

    pgn_games = parse_pgn_database(PGN_PATH)  # [(wid_or_None, Game), ...] in file order

    used_ids = set()
    for wid, _ in pgn_games:
        if wid:
            used_ids.add(wid)
    for entry in games_data:
        if entry.get("id"):
            used_ids.add(entry["id"])
    for post in blog_data:
        for g in post.get("games") or []:
            if g.get("id"):
                used_ids.add(g["id"])

    def ensure_id(current_id, title_en):
        if current_id:
            return current_id
        base = slugify(title_en)
        candidate = base
        n = 2
        while candidate in used_ids:
            candidate = base + "-" + str(n)
            n += 1
        used_ids.add(candidate)
        return candidate

    # id -> Game, for every tagged game currently in the database
    by_id = {wid: game for wid, game in pgn_games if wid}

    changed_games_json = False
    changed_blog_json = False
    rewrite_pgn = False
    # games.pgn is fully rebuilt (not just appended to) whenever anything
    # changes, so a freshly-assigned WebsiteId on a database-native game
    # actually gets saved — this list is that rebuild, seeded with every
    # game already in the file (tagging the untagged ones as we go).
    final_pgn_games = []
    consumed_ids = set()  # ids from pgn_games that correspond to a known JSON entry (handled below)

    # ---- data/games.json entries ("My most memorable games") ----
    for entry in games_data:
        title_en = pick_title_en(entry.get("title"))
        wid = entry.get("id")
        if not wid:
            wid = ensure_id(None, title_en)
            entry["id"] = wid
            changed_games_json = True
        if wid in by_id:
            consumed_ids.add(wid)
            game = by_id[wid]
            new_pgn = export_game(game)
            new_annotations = extract_annotations(game, entry.get("annotations"))
            if (entry.get("pgn") or "").strip() != new_pgn:
                entry["pgn"] = new_pgn
                changed_games_json = True
            if entry.get("annotations") != new_annotations:
                entry["annotations"] = new_annotations
                changed_games_json = True
        elif entry.get("pgn"):
            # not in the database yet -> add it (JSON -> PGN)
            game = make_game_from_pgn_text(entry["pgn"], wid, "games.json")
            if game:
                final_pgn_games.append(game)
                rewrite_pgn = True
                normalized = export_game(game)
                if entry["pgn"].strip() != normalized:
                    entry["pgn"] = normalized
                    changed_games_json = True
                new_annotations = extract_annotations(game, entry.get("annotations"))
                if entry.get("annotations") != new_annotations:
                    entry["annotations"] = new_annotations
                    changed_games_json = True

    # ---- data/blog.json embedded games ----
    for post in blog_data:
        games_list = post.get("games") or []
        for g in games_list:
            title_en = pick_title_en(g.get("title"))
            wid = g.get("id")
            if not wid:
                wid = ensure_id(None, title_en)
                g["id"] = wid
                changed_blog_json = True
            source = "blog.json:" + (post.get("slug") or "")
            if wid in by_id:
                consumed_ids.add(wid)
                game = by_id[wid]
                new_pgn = export_game(game)
                new_annotations = extract_annotations(game)
                if (g.get("pgn") or "").strip() != new_pgn:
                    g["pgn"] = new_pgn
                    changed_blog_json = True
                if g.get("annotations") != new_annotations:
                    g["annotations"] = new_annotations
                    changed_blog_json = True
            elif g.get("pgn"):
                game = make_game_from_pgn_text(g["pgn"], wid, source)
                if game:
                    final_pgn_games.append(game)
                    rewrite_pgn = True
                    normalized = export_game(game)
                    if g["pgn"].strip() != normalized:
                        g["pgn"] = normalized
                        changed_blog_json = True
                    new_annotations = extract_annotations(game)
                    if g.get("annotations") != new_annotations:
                        g["annotations"] = new_annotations
                        changed_blog_json = True

    # ---- games present in games.pgn but not (yet) known to either JSON
    #      file: either brand new content pasted straight into the
    #      database, or a game whose WebsiteId tag was present but doesn't
    #      match anything (e.g. the tag was hand-edited) — treated the
    #      same way, added as a new games.json entry rather than dropped. ----
    new_from_database = []
    for wid, game in pgn_games:
        if wid and wid in consumed_ids:
            continue
        # give it a real, unused id (reusing its own tag if it had one
        # that just didn't match anything above)
        new_id = ensure_id(wid if wid and wid not in used_ids else None, default_title_from_headers(game))
        game.headers["WebsiteId"] = new_id
        game.headers["WebsiteSource"] = "games.json"
        new_from_database.append(game)

    for game in new_from_database:
        wid = game.headers["WebsiteId"]
        title_en = default_title_from_headers(game)
        games_data.append({
            "id": wid,
            "title": {"en": title_en, "de": ""},
            "meta": "",
            "pgn": export_game(game),
            "annotations": extract_annotations(game),
        })
        changed_games_json = True
        final_pgn_games.append(game)
        rewrite_pgn = True

    # any tagged game already in games.pgn that WAS matched above also
    # needs to be carried into the rebuild, unchanged, so it isn't lost
    for wid, game in pgn_games:
        if wid and wid in consumed_ids:
            final_pgn_games.append(by_id[wid])

    if rewrite_pgn and final_pgn_games:
        # de-dupe while preserving first-seen order, in case a game ended
        # up referenced twice above (defensive; shouldn't normally happen)
        seen = set()
        ordered_unique = []
        for game in final_pgn_games:
            wid = game.headers.get("WebsiteId")
            if wid in seen:
                continue
            seen.add(wid)
            ordered_unique.append(game)
        new_pgn_text = "\n\n".join(export_game(g) for g in ordered_unique) + "\n"
        old_pgn_text = None
        if os.path.exists(PGN_PATH):
            with open(PGN_PATH, encoding="utf-8") as f:
                old_pgn_text = f.read()
        if old_pgn_text != new_pgn_text:
            with open(PGN_PATH, "w", encoding="utf-8") as f:
                f.write(new_pgn_text)
            print("Rewrote games.pgn (%d games)" % len(ordered_unique))

    if new_from_database:
        print("New game(s) found directly in games.pgn, added to games.json: %s"
              % ", ".join(g.headers["WebsiteId"] for g in new_from_database))

    if changed_games_json:
        save_json(GAMES_JSON, games_data)
        print("Updated games.json")
    if changed_blog_json:
        save_json(BLOG_JSON, blog_data)
        print("Updated blog.json")

    if not new_from_database and not changed_games_json and not changed_blog_json and not rewrite_pgn:
        print("games.pgn already in sync, nothing to do.")


if __name__ == "__main__":
    main()
