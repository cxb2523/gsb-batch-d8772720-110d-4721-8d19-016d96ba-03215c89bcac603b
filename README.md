![PyPI - Downloads](https://img.shields.io/pypi/dw/spotipyfree) ![Downloads](https://static.pepy.tech/badge/spotipyfree)
# SpotipyFree

A lightweight **drop-in replacement for Spotipy** without using the spotify api. This project was build because spotify removed access to its API for non-premium users. This project doesn't use ANY Spotify APIs. 
- - -

## Features

*   Drop-in style response compatible with `spotipy`

*   No Spotify account required

*   Returns playback data structured like the official Spotify API


- - -

## Current Status

This project is **experimental**.

Currently implemented:

*   `search()`
*   `track()`  
*   `playlist()`
*   `playlist_items()`
*   `artist()`
*   `artist_albums()`
*   `audio_features()` - batched BPM/key lookup with per-track status and selective rerun
*   `album()`
*   `album_tracks()`
*   `current_user_recently_played()` - must first run startRecentlyPlayedListener
*   `current_user_saved_tracks()`
*   `current_user_saved_tracks_contains()`
*   `current_user_playlists()`
*   `current_playback()`
*   `current_user()`
*   `me()`
*   `seek_track()`
*   `next_track()`
*   `previous_track()`
*   `start_playback()`
*   `pause_playback()`
- - -

There is also a feature to host the api as a Flask endpoint.

## Installation

Bash

`pip install spotipyFree`

- - -

## Usage without login

```python
from SpotipyFree import Spotify

sp = Spotify()

search = sp.search("Blinding Light - Weekend")
artist = sp.artist("3Bd1cgCjtCI32PYvDC3ynO")
artistAlbums = sp.artist_albums("3Bd1cgCjtCI32PYvDC3ynO", include_groups="album,single,compilation")
playlist = sp.playlist_items("6lnfkAgnVtNzvj8KScLSkj")
track = sp.track("67Hna13dNDkZvBpTXRIaOJ")
album = sp.album("4m2880jivSbbyEGAKfITCa")
albumTracks = sp.album_tracks("4m2880jivSbbyEGAKfITCa")
```

### Batch audio features (`audio_features`)

`audio_features` accepts a single track ID string or a list of IDs (Spotify
URLs are normalized automatically). A failure on one track never aborts the
batch: network errors, non-200 status codes and unparseable JSON responses are
each recorded against that track, and the rest keep being collected. The
original one-second throttle between track requests is preserved.

```python
result = sp.audio_features([
    "4tyjNEHKos3lZPYAfTiMKH",
    "https://open.spotify.com/track/67Hna13dNDkZvBpTXRIaOJ",
])

# result["items"] lines up 1:1 with the input order
#   {
#     "items": [
#       {"trackId": "...", "status": "ok", "features": {...}},
#       {"trackId": "...", "status": "error",
#        "error": "bad status code: 429", "retryable": true},
#     ],
#     "summary": {"total": 2, "success": 1, "failed": 1, "retryable": 1}
#   }
```

`summary.retryable` counts the failures that may succeed on another attempt
(network errors, HTTP 429/5xx, invalid JSON); other 4xx responses such as 404
are marked non-retryable. To re-collect only the failed retryable tracks, pass
the previous result back through the same entry point. Already successful
tracks are served from the previous result and are never requested again, and
the returned items stay aligned to the input order:

```python
retried = sp.audio_features(original_ids, previousResult=result)
```


## Usage with login
```python
from SpotipyFree import Spotify

sp = Spotify()
sp.login()

saved = sp.current_user_saved_tracks()
currentPlayback = sp.current_playback()
me = sp.me()
```

## Usage with web API
### Hosting the web api:
```bash
python -c "import SpotipyFree.web as web; web.runWebAPI()"
```
### Using the web api
```python
import json
import requests

BASE_URL = "http://127.0.0.1:5000"

url = f"{BASE_URL}/search"
response = requests.post(url, json=["Blinding Light - Weekend"])

print(f"Status: {response.status_code}")
print(response.json())
```
This project is in no way **affiliated with Spotify**.

## LICENSE
### This project is hosted under the MIT LICENSE. See the LICENSE file for more info
