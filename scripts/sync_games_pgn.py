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

Direction 1 — ChessBase -> website (the main point of this):
  For every game in games.pgn that has a WebsiteId already used by a game
  in games.json/blog.json, that JSON entry's "pgn" field is replaced with
  a freshly exported copy of the games.pgn version (headers + moves +
  comments + variations), so the board viewer on the site shows exactly
  what was last saved from ChessBase.

Direction 2 — website -> ChessBase (keeps the database complete over time):
  Any game in games.json/blog.json that has no WebsiteId yet (i.e. it was
  never synced before — a brand new game added through editor.html) gets
  one assigned and is appended to games.pgn, so it becomes available to
  open and annotate next time the database is loaded in ChessBase. This
  never touches a game already in games.pgn, so it can't undo comments
  ChessBase already has for it.

Titles, the short "meta" line, and which blog post a game is embedded in
are intentionally left alone here — those stay owned by editor.html; only
the "pgn" field itself (the actual moves/headers/comments) is synced.

Requires the "chess" package (`python -m pip install chess`) - already
installed on this machine as of when this script was written.
"""
import json
import os
import re
import sys
import io

try:
    import chess.pgn
except ImportError:
    sys.stderr.write("Missing dependency: run `python -m pip install chess`\n")
    sys.exit(1)

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GAMES_JSON = os.path.join(REPO_ROOT, "data", "games.json")
BLOG_JSON = os.path.join(REPO_ROOT, "data", "blog.json")
PGN_PATH = os.path.join(REPO_ROOT, "data", "games.pgn")


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


def parse_pgn_database(path):
    """Returns {website_id: chess.pgn.Game} for every game in the file that
    already carries a WebsiteId tag. Games without one (shouldn't normally
    happen, since this script is what adds that tag) are skipped."""
    games = {}
    if not os.path.exists(path):
        return games
    with open(path, encoding="utf-8") as f:
        while True:
            game = chess.pgn.read_game(f)
            if game is None:
                break
            wid = game.headers.get("WebsiteId")
            if wid:
                games[wid] = game
    return games


def make_game_from_pgn_text(pgn_text, website_id, website_source):
    game = chess.pgn.read_game(io.StringIO(pgn_text))
    if game is None:
        return None
    game.headers["WebsiteId"] = website_id
    game.headers["WebsiteSource"] = website_source
    return game


def main():
    games_data = load_json(GAMES_JSON)
    blog_data = load_json(BLOG_JSON)
    if games_data is None:
        games_data = []
    if blog_data is None:
        blog_data = []

    existing = parse_pgn_database(PGN_PATH)
    used_ids = set(existing.keys())

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

    changed_games_json = False
    changed_blog_json = False
    to_append = []  # (website_id, chess.pgn.Game) new to the database this run

    # ---- data/games.json entries ("My most memorable games") ----
    for entry in games_data:
        title_en = pick_title_en(entry.get("title"))
        wid = entry.get("id")
        if not wid:
            wid = ensure_id(None, title_en)
            entry["id"] = wid
            changed_games_json = True
        if wid in existing:
            new_pgn = export_game(existing[wid])
            if (entry.get("pgn") or "").strip() != new_pgn:
                entry["pgn"] = new_pgn
                changed_games_json = True
        elif entry.get("pgn"):
            game = make_game_from_pgn_text(entry["pgn"], wid, "games.json")
            if game:
                to_append.append((wid, game))

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
            if wid in existing:
                new_pgn = export_game(existing[wid])
                if (g.get("pgn") or "").strip() != new_pgn:
                    g["pgn"] = new_pgn
                    changed_blog_json = True
            elif g.get("pgn"):
                game = make_game_from_pgn_text(g["pgn"], wid, source)
                if game:
                    to_append.append((wid, game))

    if to_append:
        mode = "a" if os.path.exists(PGN_PATH) else "w"
        with open(PGN_PATH, mode, encoding="utf-8") as f:
            for wid, game in to_append:
                f.write(export_game(game) + "\n\n")
        print("Appended %d new game(s) to games.pgn: %s" % (len(to_append), ", ".join(w for w, _ in to_append)))

    if changed_games_json:
        save_json(GAMES_JSON, games_data)
        print("Updated games.json from games.pgn")
    if changed_blog_json:
        save_json(BLOG_JSON, blog_data)
        print("Updated blog.json from games.pgn")

    if not to_append and not changed_games_json and not changed_blog_json:
        print("games.pgn already in sync, nothing to do.")


if __name__ == "__main__":
    main()
