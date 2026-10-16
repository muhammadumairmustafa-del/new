#!/usr/bin/env python3
"""Fetch every video on a YouTube channel, transcribe it, and translate it.

Transcription prefers YouTube's own captions (manual first, then auto-generated).
If a video has none, the audio is downloaded and transcribed locally with Whisper.
Translation uses Google Translate via deep-translator (no API key needed).

Usage:
    python transcribe_channel.py https://www.youtube.com/@TimGabe/videos --lang ur
    python transcribe_channel.py <channel-url> --lang es --limit 5

Re-running is safe: videos whose output files already exist are skipped.
"""
import argparse
import csv
import json
import re
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import yt_dlp
from deep_translator import GoogleTranslator

CHUNK_CHARS = 4500  # Google Translate rejects requests over 5000 chars


def list_videos(channel_url):
    opts = {"extract_flat": True, "quiet": True, "skip_download": True}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(channel_url, download=False)
    return [{"id": e["id"], "title": e.get("title") or e["id"]}
            for e in info.get("entries", []) if e.get("id")]


def pick_caption_url(info, src_lang):
    for key in ("subtitles", "automatic_captions"):
        tracks = info.get(key) or {}
        # exact language first, then variants like "en-US" / "en-orig"
        langs = [src_lang] + sorted(l for l in tracks if l.startswith(src_lang + "-"))
        for lang in langs:
            for fmt in tracks.get(lang, []):
                if fmt.get("ext") == "json3":
                    return fmt["url"]
    return None


def json3_to_text(data):
    """Turn YouTube's json3 caption format into plain paragraphs."""
    lines = []
    for event in data.get("events", []):
        text = "".join(seg.get("utf8", "") for seg in event.get("segs", []) or [])
        text = text.replace("\n", " ").strip()
        if text:
            lines.append(text)
    text = " ".join(lines)
    text = re.sub(r"\s+", " ", text).strip()
    # break into readable paragraphs of ~5 sentences
    sentences = re.split(r"(?<=[.!?])\s+", text)
    return "\n\n".join(" ".join(sentences[i:i + 5]) for i in range(0, len(sentences), 5))


def captions_transcript(video_url, src_lang):
    with yt_dlp.YoutubeDL({"quiet": True, "skip_download": True}) as ydl:
        info = ydl.extract_info(video_url, download=False)
    url = pick_caption_url(info, src_lang)
    if not url:
        return None
    with urllib.request.urlopen(url) as resp:
        return json3_to_text(json.load(resp))


def whisper_transcript(video_url, model_size, src_lang):
    from faster_whisper import WhisperModel  # imported lazily: heavy dependency

    with tempfile.TemporaryDirectory() as tmp:
        opts = {"quiet": True, "format": "bestaudio/best",
                "outtmpl": str(Path(tmp) / "audio.%(ext)s")}
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(video_url, download=True)
            audio_path = ydl.prepare_filename(info)
        model = WhisperModel(model_size, compute_type="int8")
        segments, _ = model.transcribe(audio_path, language=src_lang)
        text = " ".join(s.text.strip() for s in segments)
    sentences = re.split(r"(?<=[.!?])\s+", text)
    return "\n\n".join(" ".join(sentences[i:i + 5]) for i in range(0, len(sentences), 5))


def chunk_text(text, limit=CHUNK_CHARS):
    chunks, current = [], ""
    for para in text.split("\n\n"):
        while len(para) > limit:  # a single oversized paragraph
            cut = para.rfind(" ", 0, limit)
            if cut <= 0:
                cut = limit
            chunks.append(para[:cut])
            para = para[cut:].strip()
        if current and len(current) + len(para) + 2 > limit:
            chunks.append(current)
            current = para
        else:
            current = f"{current}\n\n{para}" if current else para
    if current:
        chunks.append(current)
    return chunks


def translate(text, src_lang, target_lang, retries=5):
    translator = GoogleTranslator(source=src_lang, target=target_lang)
    out = []
    for chunk in chunk_text(text):
        for attempt in range(retries):
            try:
                out.append(translator.translate(chunk))
                break
            except Exception as exc:
                if attempt == retries - 1:
                    raise
                wait = 2 ** (attempt + 1)
                print(f"    translate error ({exc.__class__.__name__}), retrying in {wait}s")
                time.sleep(wait)
        time.sleep(0.5)  # stay well under Google's rate limit
    return "\n\n".join(out)


def slugify(title):
    return re.sub(r"[^\w]+", "-", title).strip("-")[:60] or "video"


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("channel_url")
    p.add_argument("--lang", default="ur", help="target language code (default: ur = Urdu)")
    p.add_argument("--source-lang", default="en", help="spoken language of the videos (default: en)")
    p.add_argument("--out", default="output", help="output folder (default: ./output)")
    p.add_argument("--limit", type=int, help="only process the first N videos")
    p.add_argument("--whisper-model", default="small", help="Whisper size if captions are missing")
    p.add_argument("--no-whisper", action="store_true", help="skip videos without captions")
    args = p.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    videos = list_videos(args.channel_url)
    if args.limit:
        videos = videos[:args.limit]
    print(f"Found {len(videos)} videos")

    index_rows = []
    for n, v in enumerate(videos, 1):
        url = f"https://www.youtube.com/watch?v={v['id']}"
        base = out_dir / f"{n:03d}_{v['id']}_{slugify(v['title'])}"
        src_file = base.with_name(base.name + f".{args.source_lang}.txt")
        dst_file = base.with_name(base.name + f".{args.lang}.txt")
        print(f"[{n}/{len(videos)}] {v['title']}")
        status = "ok"
        try:
            if src_file.exists():
                transcript = src_file.read_text(encoding="utf-8")
            else:
                transcript = captions_transcript(url, args.source_lang)
                source = "captions"
                if not transcript:
                    if args.no_whisper:
                        raise RuntimeError("no captions available")
                    print("    no captions, transcribing audio with Whisper...")
                    transcript = whisper_transcript(url, args.whisper_model, args.source_lang)
                    source = "whisper"
                header = f"{v['title']}\n{url}\n(transcript source: {source})\n\n"
                src_file.write_text(header + transcript, encoding="utf-8")
                transcript = header + transcript
            if not dst_file.exists():
                dst_file.write_text(translate(transcript, args.source_lang, args.lang), encoding="utf-8")
        except Exception as exc:
            status = f"error: {exc}"
            print(f"    {status}")
        index_rows.append([n, v["id"], v["title"], url, src_file.name, dst_file.name, status])
        time.sleep(1)  # be polite to YouTube

    with open(out_dir / "index.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["#", "video_id", "title", "url", "transcript", "translation", "status"])
        w.writerows(index_rows)
    failed = sum(1 for r in index_rows if r[-1] != "ok")
    print(f"Done. {len(index_rows) - failed} succeeded, {failed} failed. See {out_dir / 'index.csv'}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
