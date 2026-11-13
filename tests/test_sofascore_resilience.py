"""Local-only resilience test for SofaScoreALLDATA_Scraping.py.

Serves synthetic SofaScore team/detail/statistics responses from an in-memory
HTTP server and runs the real scraper entry point against it.
"""

import csv
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRAPER_DIR = REPO_ROOT / 'Scraping Codes' / 'SofaScore'
SCRAPER_PATH = SCRAPER_DIR / 'SofaScoreALLDATA_Scraping.py'

TEAM_ID = '12345'

# A 1x1 transparent PNG, so the image check succeeds for known players.
PNG_BYTES = bytes.fromhex(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4'
    '890000000a49444154789c6360000002000154a24f6a0000000049454e44ae426082'
)

TEAM_PAGE = """
<html><body>
<h2 class="Text edxjEB">Test FC</h2>
<a href="/player/good-player/1001">
  <div class="Text cOreSJ">Good Player</div>
  <span class="Text dJOWjw">Morocco</span>
</a>
<a href="/player/detail-error/1002">
  <div class="Text cOreSJ">Detail Error</div>
  <span class="Text dJOWjw">Morocco</span>
</a>
<a href="/player/missing-stats/1003">
  <div class="Text cOreSJ">Missing Stats</div>
  <span class="Text dJOWjw">Morocco</span>
</a>
<a href="/player/no-name/1004">
  <div class="Text cOreSJ"></div>
  <span class="Text dJOWjw">Morocco</span>
</a>
<a href="/player/blank-stats/1005">
  <div class="Text cOreSJ">Blank Stats</div>
  <span class="Text dJOWjw">Morocco</span>
</a>
<a href="/player/invalid-json/1006">
  <div class="Text cOreSJ">Invalid JSON</div>
  <span class="Text dJOWjw">Morocco</span>
</a>
<a href="/player/after-failures/1007">
  <div class="Text cOreSJ">After Failures</div>
  <span class="Text dJOWjw">Morocco</span>
</a>
</body></html>
"""

DETAIL_PAGE = """
<html><body>
<div class="Text beCNLk">24 yrs</div>
<div class="Text beCNLk">180 cm</div>
<div class="Text beCNLk">Right</div>
<div class="Text beCNLk">M</div>
<div class="Text beCNLk">7</div>
</body></html>
"""

GOOD_STATS = {
    'rating': 7.1,
    'goals': 4,
    'assists': 2,
    'appearances': 10,
    'id': 555,
    'type': 'overall',
}


class FixtureHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # keep test output clean
        return

    def _send(self, status, body, content_type='text/html; charset=utf-8'):
        data = body.encode('utf-8') if isinstance(body, str) else body
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split('?', 1)[0]

        if path.startswith('/team/football/') and path.endswith('/' + TEAM_ID):
            self._send(200, TEAM_PAGE)
            return

        if path.startswith('/team/football/'):
            self._send(404, 'team not found')
            return

        if path.startswith('/api/v1/player/') and path.endswith('/image'):
            self._send(200, PNG_BYTES, 'image/png')
            return

        if path.startswith('/player/'):
            player_id = path.rsplit('/', 1)[-1]
            if player_id == '1002':
                self._send(500, 'boom')
            else:
                self._send(200, DETAIL_PAGE)
            return

        if '/statistics/overall' in path:
            player_id = path.split('/api/v1/player/')[1].split('/')[0]
            if player_id == '1003':
                self._send(200, json.dumps({'error': 'not found'}))
            elif player_id == '1005':
                self._send(200, json.dumps({'statistics': {}}))
            elif player_id == '1006':
                self._send(200, '{not valid json', 'application/json')
            elif player_id == '1002':
                # Detail page is broken but stats are valid.
                self._send(200, json.dumps({'statistics': dict(GOOD_STATS)}))
            else:
                self._send(200, json.dumps({'statistics': dict(GOOD_STATS)}))
            return

        self._send(404, 'not found')


def load_scraper():
    spec = importlib.util.spec_from_file_location('sofascore_scraper', SCRAPER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run():
    server = ThreadingHTTPServer(('127.0.0.1', 0), FixtureHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = 'http://127.0.0.1:{}'.format(server.server_address[1])

    workdir = Path(tempfile.mkdtemp(prefix='sofascore_test_'))
    try:
        shutil.copy(SCRAPER_DIR / 'default_player_stats.txt', workdir / 'default_player_stats.txt')
        with open(workdir / 'sofascore_links.txt', 'w', encoding='utf-8') as file:
            # A broken team page before/after a good one must not stop the batch.
            file.write('{}/team/football/broken-fc/99999\n'.format(base))
            file.write('{}/team/football/test-fc/{}\n'.format(base, TEAM_ID))
            file.write('{}/team/football/also-broken/99998\n'.format(base))

        os.environ['SOFASCORE_WEB_BASE'] = base
        os.environ['SOFASCORE_API_BASE'] = base

        previous_cwd = os.getcwd()
        os.chdir(workdir)
        try:
            scraper = load_scraper()
            scraper.main()
        finally:
            os.chdir(previous_cwd)

        csv_path = workdir / scraper.OUTPUT_CSV
        report_path = workdir / scraper.OUTCOME_FILE
        with open(csv_path, encoding='utf-8-sig', newline='') as file:
            rows = list(csv.DictReader(file))
        with open(report_path, encoding='utf-8') as file:
            report = json.load(file)

        return rows, report, workdir
    finally:
        server.shutdown()
        server.server_close()


def check(rows, report):
    failures = []
    players = report['players']

    def expect(condition, message):
        if not condition:
            failures.append(message)

    expect(len(rows) == 7, 'expected 7 CSV rows, got {}'.format(len(rows)))
    expect(len(players) == len(rows), 'outcome count {} != CSV rows {}'.format(len(players), len(rows)))
    expect(report['summary']['csv_rows'] == len(rows), 'summary csv_rows mismatch')
    expect(report['summary']['team_page_failures'] == 2,
           'expected 2 team page failures, got {}'.format(report['summary']['team_page_failures']))
    expect(all(item['status'] == 'failed' and 'HTTP 404' in item['failure_reason']
               for item in report['team_failures']),
           'team page failure reasons unclear: {}'.format(report['team_failures']))

    header = list(rows[0].keys())
    required_prefix = [
        'Player', 'Nationality', 'Team', 'Position', 'Age', 'Height',
        'Preferred Foot', 'Shirt Number', 'Player Image', 'Team Logo',
    ]
    expect(header[:len(required_prefix)] == required_prefix,
           'CSV column prefix wrong: {}'.format(header[:len(required_prefix)]))

    by_id = {player['player_id']: player for player in players}
    row_by_id = {}
    for row, outcome in zip(rows, players):
        row_by_id[outcome['player_id']] = row
    expect(set(by_id) == {'1001', '1002', '1003', '1004', '1005', '1006', '1007'},
           'unexpected player ids: {}'.format(sorted(by_id)))

    expect(by_id['1001']['status'] == 'success', 'normal player not success: {}'.format(by_id['1001']))
    expect(by_id['1001']['failure_reason'] == '', 'normal player has failure reason')

    expect(by_id['1002']['status'] == 'failed', 'detail 500 not marked failed')
    expect('HTTP 500' in by_id['1002']['failure_reason'],
           'detail 500 reason not readable: {}'.format(by_id['1002']['failure_reason']))
    expect(by_id['1002']['player_name'] == 'Detail Error', 'detail 500 lost known name')
    expect(by_id['1002']['statistics_default'] is True, 'failed player should use default stats')
    expect(row_by_id['1002']['goals'] == '-', 'failed player stats should use defaults')

    expect(by_id['1003']['status'] == 'failed', 'missing statistics not marked failed')
    expect("'statistics'" in by_id['1003']['failure_reason'],
           'missing statistics reason unclear: {}'.format(by_id['1003']['failure_reason']))

    expect(by_id['1004']['status'] == 'failed', 'empty name not marked failed')
    expect('name' in by_id['1004']['failure_reason'], 'empty name reason unclear')

    expect(by_id['1005']['status'] == 'success_default_stats',
           'default stats success not distinct: {}'.format(by_id['1005']))
    expect(by_id['1005']['statistics_default'] is True, 'default stats flag not set')

    expect(by_id['1006']['status'] == 'failed', 'invalid JSON not marked failed')
    expect('invalid JSON' in by_id['1006']['failure_reason'],
           'invalid JSON reason unclear: {}'.format(by_id['1006']['failure_reason']))

    expect(by_id['1007']['status'] == 'success', 'player after failures not processed')
    expect(all(player['team_url'].endswith('/' + TEAM_ID) for player in players),
           'team URL missing from outcome report')

    row_by_id = {}
    for row, outcome in zip(rows, players):
        row_by_id[outcome['player_id']] = row
    expect(row_by_id['1004']['Player'] == '--', 'empty name row should use "--": {}'.format(row_by_id['1004']))
    expect(row_by_id['1002']['Team'] == 'Test FC', 'failed player lost known team')
    expect(row_by_id['1002']['Nationality'] == 'Morocco', 'failed player lost nationality')
    expect(row_by_id['1003']['Team'] == 'Test FC', 'stats-failed player lost team')
    expect(row_by_id['1001']['goals'] == '4', 'normal player statistics missing')
    expect(row_by_id['1003']['goals'] == '-', 'failed stats should use default "-"')

    return failures


def main():
    rows, report, workdir = run()
    failures = check(rows, report)
    print('--- outcome report summary ---')
    print(json.dumps(report['summary'], indent=2))
    for player in report['players']:
        print('{} | {} | {} | {}'.format(
            player['row'], player['identifier'], player['status'],
            player['failure_reason'] or player['note'] or 'ok'))
    if failures:
        print('\nFAILURES:')
        for failure in failures:
            print(' - {}'.format(failure))
        sys.exit(1)
    print('\nAll resilience checks passed (artifacts in {}).'.format(workdir))


if __name__ == '__main__':
    main()
