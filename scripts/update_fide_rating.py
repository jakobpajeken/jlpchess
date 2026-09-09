#!/usr/bin/env python3
"""
Fetches the current classical (standard) FIDE rating and world ranking
(among active players) for Jakob Leon Pajeken (FIDE ID 12942839) and
writes both to rating.json in the repo root — along with the career-peak
classical rating, which is only updated when the freshly-fetched rating
is actually higher than the one already stored (the peak itself isn't
something FIDE's profile page shows directly; it's just carried forward
from run to run and bumped whenever a new high is reached).

Meant to be run monthly by the accompanying GitHub Actions workflow
(.github/workflows/update-fide-rating.yml), but can also be run by hand:

    python scripts/update_fide_rating.py

Note: this parses FIDE's public profile page with simple regexes rather
than a documented API (FIDE doesn't offer one), so it's best-effort. If
FIDE changes their page layout, this script may need a small update —
look at https://ratings.fide.com/profile/12942839 and adjust the parsing
functions below to match:
  - classical rating: near where "logo_std.svg" appears
  - world ranking: in the "World Rank" block, the "Active players" number
"""

import datetime
import json
import re
import sys
import urllib.request

FIDE_ID = "12942839"
PROFILE_URL = f"https://ratings.fide.com/profile/{FIDE_ID}"
OUTPUT_PATH = "rating.json"


def fetch_html(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.read().decode("utf-8", errors="replace")


def extract_classical_rating(html: str) -> int:
    """Find the number shown next to the 'STANDARD' rating icon."""
    idx = html.find("logo_std.svg")
    if idx == -1:
        raise RuntimeError(
            "Could not find the standard-rating marker on the FIDE profile "
            "page — FIDE may have changed their page layout. This script "
            "needs a small update."
        )
    window = html[idx : idx + 400]
    text_only = re.sub(r"<[^>]+>", " ", window)
    match = re.search(r"\b(\d{3,4})\b", text_only)
    if not match:
        raise RuntimeError(
            "Found the standard-rating marker but no number near it — "
            "check the page layout."
        )
    return int(match.group(1))


def extract_world_rank(html: str) -> int:
    """Find the 'Active players' number in the 'World Rank' block."""
    idx = html.find("World Rank")
    if idx == -1:
        raise RuntimeError(
            "Could not find the 'World Rank' block on the FIDE profile "
            "page — FIDE may have changed their page layout. This script "
            "needs a small update."
        )
    window = html[idx : idx + 500]
    text_only = re.sub(r"<[^>]+>", " ", window)
    match = re.search(r"Active players\s+(\d+)", text_only)
    if not match:
        raise RuntimeError(
            "Found the 'World Rank' block but no 'Active players' number "
            "near it — check the page layout."
        )
    return int(match.group(1))


def load_existing() -> dict:
    try:
        with open(OUTPUT_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def main() -> None:
    html = fetch_html(PROFILE_URL)
    rating = extract_classical_rating(html)
    world_rank = extract_world_rank(html)

    now = datetime.date.today()
    current_period = now.strftime("%Y-%b")

    existing = load_existing()
    prev_peak = existing.get("peak")
    prev_peak_period = existing.get("peakPeriod")
    if isinstance(prev_peak, int) and prev_peak >= rating:
        # no new high this month — keep the existing peak and the period
        # it was actually reached in
        peak, peak_period = prev_peak, (prev_peak_period or current_period)
    else:
        # either no peak recorded yet, or this month's rating is a new high
        peak, peak_period = rating, current_period

    data = {
        "classical": rating,
        "worldRank": world_rank,
        "peak": peak,
        "peakPeriod": peak_period,
        "period": current_period,
        "source": PROFILE_URL,
        "updated": now.isoformat(),
    }

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")

    print(
        f"Updated {OUTPUT_PATH} -> classical={rating}, worldRank={world_rank}, "
        f"peak={peak} ({peak_period})"
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print(f"Failed to update FIDE rating: {exc}", file=sys.stderr)
        sys.exit(1)
