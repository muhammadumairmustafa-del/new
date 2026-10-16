# YouTube channel transcribe + translate

Downloads the list of videos on a channel, gets a transcript of each one, and translates it.

- **Transcript:** YouTube captions (manual, then auto-generated). If a video has none, the audio is transcribed locally with Whisper (needs `ffmpeg`).
- **Translation:** Google Translate via `deep-translator`. No API key needed.

## Run

```bash
cd tools/youtube-transcribe
pip install -r requirements.txt
python transcribe_channel.py https://www.youtube.com/@TimGabe/videos --lang ur
```

Useful flags:

| Flag | Meaning |
|---|---|
| `--lang ur` | Target language code (`ur` Urdu, `hi` Hindi, `ar` Arabic, `es` Spanish, ...) |
| `--limit 3` | Try the first 3 videos before running the whole channel |
| `--no-whisper` | Skip videos without captions instead of downloading audio |
| `--whisper-model base` | Smaller/faster Whisper model (`tiny`, `base`, `small`, `medium`) |
| `--out output` | Output folder |
| `--cookies-from-browser chrome` | Use your YouTube login from `chrome`, `firefox`, `safari`, `edge` or `brave`. Fixes `HTTP Error 429` / "Sign in to confirm you're not a bot" |
| `--delay 10` | Seconds to wait between videos (raise it if you still get 429s) |

### `HTTP Error 429: Too Many Requests`

YouTube is rate-limiting your connection. Log in to youtube.com in your browser, then add `--cookies-from-browser chrome` (or your browser). On a Mac, Safari needs Terminal to have Full Disk Access (System Settings → Privacy & Security), so Chrome or Firefox is easier. Already finished videos are skipped when you run it again.

## Output

For each video, `output/` gets `NNN_<id>_<title>.en.txt` (transcript) and `NNN_<id>_<title>.<lang>.txt` (translation), plus `index.csv` listing every video and whether it succeeded.

If the script is interrupted, run it again: files that already exist are skipped. The `output/` folder is git-ignored, so the transcripts stay on your computer. They are the channel owner's content, so keep them for personal use.

Run this from your own computer. YouTube and Google Translate rate-limit cloud/datacenter IPs (HTTP 429).
