import json
import os
import re
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

import pandas as pd
import requests
import urllib3
from bs4 import BeautifulSoup
from PIL import Image, UnidentifiedImageError

headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
}
# Disable the InsecureRequestWarning
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# Endpoints are overridable through environment variables so the scraper can be
# exercised against a local fixture server. Normal runs use the public defaults.
WEB_BASE = os.environ.get('SOFASCORE_WEB_BASE', 'https://www.sofascore.com').rstrip('/')
API_BASE = os.environ.get('SOFASCORE_API_BASE', 'https://api.sofascore.app').rstrip('/')

INPUT_FILE = 'sofascore_links.txt'
OUTPUT_CSV = 'BOTOLA Players Stats.csv'
OUTCOME_FILE = 'BOTOLA Players Outcomes.json'
DEFAULT_STATS_FILE = 'default_player_stats.txt'
DEFAULT_PORTRAIT = 'https://img.a.transfermarkt.technology/portrait/medium/default.jpg'

REQUEST_TIMEOUT = 20

FIRST_COLUMNS = [
    'Player',
    'Nationality',
    'Team',
    'Position',
    'Age',
    'Height',
    'Preferred Foot',
    'Shirt Number',
    'Player Image',
    'Team Logo',
]

STATUS_SUCCESS = 'success'
STATUS_SUCCESS_DEFAULT_STATS = 'success_default_stats'
STATUS_FAILED = 'failed'


def describe_request_error(stage, exc):
    """Turn a request exception into a short, human-readable reason."""
    if isinstance(exc, requests.exceptions.HTTPError) and exc.response is not None:
        reason = (exc.response.reason or '').strip()
        message = 'HTTP {}'.format(exc.response.status_code)
        if reason:
            message = '{} {}'.format(message, reason)
        return '{} failed: {}'.format(stage, message)
    if isinstance(exc, requests.exceptions.Timeout):
        return '{} timed out: {}'.format(stage, exc)
    if isinstance(exc, requests.exceptions.ConnectionError):
        return '{} failed: connection error ({})'.format(stage, exc)
    if isinstance(exc, requests.exceptions.RequestException):
        return '{} failed: {}'.format(stage, exc)
    return '{} failed: {}: {}'.format(stage, type(exc).__name__, exc)


def load_default_stats():
    """Load the placeholder statistics used when a player has no usable stats."""
    candidates = [Path(DEFAULT_STATS_FILE), Path(__file__).resolve().parent / DEFAULT_STATS_FILE]
    for path in candidates:
        if path.is_file():
            with path.open('r', encoding='utf-8') as file:
                default_stats = json.load(file)
            if not isinstance(default_stats, dict):
                raise ValueError('{} must contain a JSON object'.format(path))
            return dict(default_stats)
    raise FileNotFoundError(
        "Could not find '{}'. Place it next to the script or run from its directory.".format(DEFAULT_STATS_FILE)
    )


def stats_are_default(statistics):
    """True when the statistics payload carries no actual values."""
    if not statistics:
        return True
    values = [value for value in statistics.values() if not isinstance(value, (dict, list))]
    if not values:
        return True
    return all(value in (None, '', '-') for value in values)


def scrapeURLplayer(url):
    """Scrape age, height, preferred foot, position and shirt number."""

    res = requests.get(url, headers=headers, verify=False, timeout=REQUEST_TIMEOUT)
    res.raise_for_status()  # Raise an exception for bad status codes

    # The next two lines get around the issue with comments breaking the parsing.
    comm = re.compile("<!--|-->")
    soup = BeautifulSoup(comm.sub("", res.text), 'lxml')
    all_stats = soup.find_all('div', {"class": "Text beCNLk"})
    stats = {
        'age': '--',
        'height': '--',
        'foot': '--',
        'position': '--',
        'shirt_number': '--'
    }
    if len(all_stats) != 0:
        for stat in all_stats:
            item = stat.text.strip()
            if item.endswith(" yrs"):
                stats['age'] = item
            elif item.endswith(" cm"):
                stats['height'] = item
            elif item in ["Right", "Left", "Both"]:
                stats['foot'] = item
            elif item in ["G", "D", "M", "F"]:
                stats['position'] = item
            elif item.isdigit():
                stats['shirt_number'] = int(item)

    return stats['age'], stats['height'], stats['foot'], stats['position'], stats['shirt_number']


def extract_player_stats(player_id):
    """Fetch per-season statistics.

    Returns a tuple ``(statistics, error)``. On success ``statistics`` is a dict
    and ``error`` is None. On failure ``statistics`` is None and ``error`` holds
    a readable reason. Failures never raise, so one bad player cannot stop a
    whole team (or the whole batch).
    """
    if not player_id:
        return None, 'statistics API skipped: missing player id'

    api = '{}/api/v1/player/{}/unique-tournament/937/season/54108/statistics/overall'.format(
        WEB_BASE, player_id
    )
    try:
        response = requests.get(api, headers=headers, timeout=REQUEST_TIMEOUT)
        response.raise_for_status()
    except requests.exceptions.RequestException as exc:
        return None, describe_request_error('statistics API request', exc)

    try:
        json_data = response.json()
    except ValueError as exc:
        return None, 'statistics API returned invalid JSON: {}'.format(exc)

    if not isinstance(json_data, dict):
        return None, 'statistics API response is not a JSON object'
    if 'statistics' not in json_data:
        return None, "statistics API response is missing the 'statistics' key"

    statistics = json_data['statistics']
    if statistics is None:
        statistics = {}
    elif not isinstance(statistics, dict):
        return None, "statistics API response has a non-object 'statistics' value"
    return statistics, None


def check_image_url(url, verify_ssl=True):
    try:
        # Send a GET request to the URL
        response = requests.get(url, headers=headers, verify=verify_ssl, timeout=10)

        # Check if the request was successful
        response.raise_for_status()

        # Check the content type
        content_type = response.headers.get('content-type', '').lower()

        if 'image' in content_type:
            # If it's an image, try to open it
            img = Image.open(BytesIO(response.content))
            img.verify()  # Verify that it is, in fact, an image
            return True
        else:
            return False

    except (requests.exceptions.SSLError, requests.exceptions.RequestException,
            UnidentifiedImageError, ValueError, OSError):
        # If SSL verification fails or any other request exception occurs,
        # retry without SSL verification if it was initially enabled
        if verify_ssl:
            return check_image_url(url, verify_ssl=False)
        return False


def player_identifier(name, player_id, href):
    if name and player_id:
        return '{} (ID {})'.format(name, player_id)
    if name:
        return name
    if player_id:
        return 'ID {}'.format(player_id)
    if href:
        return href
    return '(unknown player)'


def scrape_player(link, team, team_missing, team_id, team_url, row_index, default_stats):
    """Collect one player. Any failure here is recorded, never raised."""
    failures = []

    href = link.get('href') or ''
    match = re.search(r'/(\d+)$', href)
    player_id = match.group(1) if match else ''

    nationality_span = link.find('span', {"class": "Text dJOWjw"})
    nationality = nationality_span.get_text(strip=True) if nationality_span else ''
    if not nationality:
        nationality = '--'

    name_div = link.find('div', {"class": "Text cOreSJ"})
    name = name_div.get_text(strip=True) if name_div else ''
    if not name:
        # Keep a known value if the dedicated name element is absent but the
        # link itself still carries text (ignoring the nationality label).
        parts = [
            text for text in link.stripped_strings
            if text != nationality and not text.isdigit()
        ]
        name = ' '.join(parts).strip()
    if not name:
        failures.append('missing player name on team page')
    if team_missing:
        failures.append('missing team name on team page')
    if not player_id:
        failures.append('missing player id in player link')

    # Player image: verify it, otherwise fall back to the default portrait.
    image = DEFAULT_PORTRAIT
    if player_id:
        candidate_image = '{}/api/v1/player/{}/image'.format(API_BASE, player_id)
        try:
            if check_image_url(candidate_image):
                image = candidate_image
        except Exception:
            image = DEFAULT_PORTRAIT

    # Player detail page: age, height, foot, position, shirt number.
    age = height = foot = position = shirt_number = '--'
    if player_id:
        player_name = name.lower().replace(' ', '-')
        slug = player_name if player_name else player_id
        player_link = '{}/player/{}/{}'.format(WEB_BASE, slug, player_id)
        try:
            age, height, foot, position, shirt_number = scrapeURLplayer(player_link)
        except Exception as exc:
            failures.append(describe_request_error('player detail page', exc))

    # Season statistics. On failure the row keeps the placeholder stats.
    statistics = None
    stats_error = None
    if player_id:
        statistics, stats_error = extract_player_stats(player_id)
    if stats_error:
        failures.append(stats_error)
    if statistics is None:
        statistics = {}

    # A failed player's statistics columns fall back to the defaults from
    # default_player_stats.txt, even if a partial statistics payload arrived.
    stats_default = bool(failures) or stats_are_default(statistics)

    row = dict(default_stats)
    if not stats_default:
        row.update(statistics)
    row['Player'] = name if name else '--'
    row['Player Image'] = image
    row['Team'] = team
    row['Team Logo'] = '{}/api/v1/team/{}/image'.format(API_BASE, team_id) if team_id else '--'
    row['Nationality'] = nationality
    row['Age'] = age
    row['Height'] = height
    row['Preferred Foot'] = foot
    row['Position'] = position
    row['Shirt Number'] = shirt_number

    if failures:
        status = STATUS_FAILED
        failure_reason = '; '.join(failures)
        note = ''
    elif stats_default:
        status = STATUS_SUCCESS_DEFAULT_STATS
        failure_reason = ''
        note = 'player data collected, but no usable statistics were returned; default values used'
    else:
        status = STATUS_SUCCESS
        failure_reason = ''
        note = ''

    outcome = {
        'row': row_index,
        'team_url': team_url,
        'team_id': team_id or None,
        'player_id': player_id or None,
        'identifier': player_identifier(name, player_id, href),
        'player_name': name or None,
        'status': status,
        'failure_reason': failure_reason,
        'statistics_default': bool(stats_default),
        'note': note,
    }
    return row, outcome


def failed_player_row(default_stats, team, team_logo):
    """Minimal row used only if per-player handling itself unexpectedly breaks."""
    row = dict(default_stats)
    row['Player'] = '--'
    row['Player Image'] = DEFAULT_PORTRAIT
    row['Team'] = team
    row['Team Logo'] = team_logo
    row['Nationality'] = '--'
    row['Age'] = '--'
    row['Height'] = '--'
    row['Preferred Foot'] = '--'
    row['Position'] = '--'
    row['Shirt Number'] = '--'
    return row


def scrapeURL(urls):
    all_player_stats = []
    outcomes = []
    team_failures = []
    default_stats = load_default_stats()

    for url in urls:
        print(url)
        team_url = url

        # Team ID
        match = re.search(r'/(\d+)$', url)
        team_id = match.group(1) if match else ''

        try:
            res = requests.get(url, headers=headers, verify=False, timeout=REQUEST_TIMEOUT)
            res.raise_for_status()  # Raise an exception for bad status codes
        except Exception as exc:
            reason = describe_request_error('team page request', exc)
            print('  team page failed: {}'.format(reason))
            team_failures.append({
                'team_url': team_url,
                'status': STATUS_FAILED,
                'failure_reason': reason,
            })
            continue

        # The next two lines get around the issue with comments breaking the parsing.
        comm = re.compile("<!--|-->")
        soup = BeautifulSoup(comm.sub("", res.text), 'lxml')

        # Team
        team_heading = soup.find('h2', {"class": "Text edxjEB"})
        team = team_heading.get_text(strip=True) if team_heading else ''
        team_missing = not team
        if team_missing:
            team = '--'
        # Team Logo
        logo = '{}/api/v1/team/{}/image'.format(API_BASE, team_id) if team_id else '--'

        # Find all <a> tags with href starting with "/player/"
        player_links = soup.find_all('a', href=lambda href: href and href.startswith('/player/'))
        for link in player_links:
            row_index = len(all_player_stats) + 1
            try:
                row, outcome = scrape_player(
                    link, team, team_missing, team_id, team_url, row_index, default_stats
                )
            except Exception as exc:
                # Last-resort isolation: a bug or unexpected payload for one
                # player must not discard the rest of the batch.
                reason = 'unexpected error while processing player: {}: {}'.format(
                    type(exc).__name__, exc
                )
                href = link.get('href') or ''
                player_id_match = re.search(r'/(\d+)$', href)
                player_id = player_id_match.group(1) if player_id_match else ''
                row = failed_player_row(default_stats, team, logo)
                outcome = {
                    'row': row_index,
                    'team_url': team_url,
                    'team_id': team_id or None,
                    'player_id': player_id or None,
                    'identifier': player_identifier('', player_id, href),
                    'player_name': None,
                    'status': STATUS_FAILED,
                    'failure_reason': reason,
                    'statistics_default': True,
                    'note': '',
                }

            all_player_stats.append(row)
            outcomes.append(outcome)
            message = '  [{}] {}: {}'.format(row_index, outcome['identifier'], outcome['status'])
            if outcome['failure_reason']:
                message += ' - {}'.format(outcome['failure_reason'])
            elif outcome['note']:
                message += ' - {}'.format(outcome['note'])
            print(message)

    df = pd.DataFrame(all_player_stats)
    # Remove 'id', 'type', and 'appearances' from the statistics columns
    df = df.drop(columns=[column for column in ('id', 'type') if column in df.columns], errors='ignore')

    if df.empty:
        stat_columns = [column for column in default_stats if column not in ('id', 'type')]
        df = pd.DataFrame(columns=FIRST_COLUMNS + stat_columns)

    # Keep the required leading column order, then whatever statistics the
    # source returned. Failed players contribute the same columns via defaults.
    all_columns = df.columns.tolist()
    other_columns = [col for col in all_columns if col not in FIRST_COLUMNS]
    new_order = FIRST_COLUMNS + other_columns
    df = df.reindex(columns=[col for col in new_order if col in df.columns])
    return df, outcomes, team_failures


def write_outcome_report(outcomes, team_failures, csv_rows, path=OUTCOME_FILE):
    succeeded = sum(1 for item in outcomes if item['status'] == STATUS_SUCCESS)
    succeeded_default = sum(1 for item in outcomes if item['status'] == STATUS_SUCCESS_DEFAULT_STATS)
    failed = sum(1 for item in outcomes if item['status'] == STATUS_FAILED)
    report = {
        'input_file': INPUT_FILE,
        'output_csv': OUTPUT_CSV,
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'summary': {
            'players': len(outcomes),
            'csv_rows': csv_rows,
            'success': succeeded,
            'success_default_stats': succeeded_default,
            'failed': failed,
            'team_page_failures': len(team_failures),
        },
        'team_failures': team_failures,
        'players': outcomes,
    }
    with open(path, 'w', encoding='utf-8') as file:
        json.dump(report, file, ensure_ascii=False, indent=2)
        file.write('\n')
    return report


def main():
    with open(INPUT_FILE, 'r', encoding='utf-8-sig') as file:
        urls = file.readlines()
        # Remove newline characters and blank entries
        urls = [url.strip() for url in urls if url.strip()]

    df_player, outcomes, team_failures = scrapeURL(urls)
    df_player.to_csv(OUTPUT_CSV, encoding='utf-8-sig', index=False)
    report = write_outcome_report(outcomes, team_failures, len(df_player))

    print('Outcome report: {}'.format(OUTCOME_FILE))
    print('Players: {players} | success: {success} | success (default stats): {success_default_stats} | failed: {failed}'.format(
        **report['summary']
    ))
    print(" SUCCESS !")


if __name__ == '__main__':
    main()
