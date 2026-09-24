"""Local SuperMemory-VQA independent review portal.

Run with: python portal/server.py
Only the whitelisted review API and static assets are served; dataset files are
never mounted as a web directory.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
from collections import Counter
from datetime import datetime, timezone
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit


BASE = Path(__file__).resolve().parents[1]
DATA = BASE / "data"
STATIC = Path(__file__).resolve().parent / "static"
STATE = Path(os.environ.get("SUPERMEMORY_PORTAL_STATE_DIR", BASE / "var"))
DB = STATE / "reviews.sqlite3"
CACHE = STATE / "media_cache"
FFMPEG_DIR = os.environ.get("SUPERMEMORY_FFMPEG_DIR", "")
VIDEO_ENCODER = os.environ.get("SUPERMEMORY_VIDEO_ENCODER", "libx264")
SUPPORTED_VIDEO_ENCODERS = {"libx264", "h264_nvenc", "h264_amf", "h264_qsv"}


def media_tool_path(name):
    if FFMPEG_DIR:
        suffix = ".exe" if os.name == "nt" else ""
        candidate = Path(FFMPEG_DIR) / (name + suffix)
        if candidate.is_file():
            return str(candidate)
    return name


FFMPEG = media_tool_path("ffmpeg")
FFPROBE = media_tool_path("ffprobe")
SEGMENT_SECONDS = 45
SAFETY_SECONDS = 0.25
MAX_CACHE_BYTES = 2 * 1024**3
ISSUES = {
    "unclear wording", "incorrect answer key", "multiple valid choices",
    "insufficient evidence", "missing evidence", "wrong timestamps",
    "evidence after question time", "other",
}
CLARITY = {"Clear", "Unclear"}
ANSWERABILITY = {"Answerable", "Unanswerable", "Unable to verify within the review"}
EVIDENCE = {
    "Sufficient and correctly timed", "Partly sufficient or needs revision",
    "Insufficient or wrong", "Not applicable",
}
VIDEO_ID = re.compile(r"^Person_(10|[1-9])_session_\d+_\d{8}_glasses_[A-Za-z0-9]+$")
SESSION_COOKIE = "smvqa_session"


class MediaToolUnavailable(RuntimeError):
    pass


def missing_media_tools():
    return [tool for tool in (FFPROBE, FFMPEG) if shutil.which(tool) is None]


def media_tool_message(tools):
    return (f"Video playback needs {', '.join(tools)}. Set "
            "SUPERMEMORY_FFMPEG_DIR to the FFmpeg bin directory, then restart "
            "the portal.")


def video_encoder_available():
    null_device = "NUL" if os.name == "nt" else "/dev/null"
    try:
        result = subprocess.run(
            [FFMPEG, "-hide_banner", "-loglevel", "error", "-f", "lavfi",
             "-i", "color=c=black:s=320x180:r=1", "-frames:v", "1",
                         *video_encoder_options(),
             "-f", "null", null_device],
            capture_output=True, text=True, timeout=30, check=False)
    except OSError:
        return False
    return result.returncode == 0


def video_encoder_options():
    if VIDEO_ENCODER == "libx264":
        return ["-c:v", VIDEO_ENCODER, "-preset", "veryfast", "-crf", "23"]
    if VIDEO_ENCODER == "h264_amf":
        return ["-c:v", VIDEO_ENCODER, "-quality", "speed", "-rc", "cqp",
                "-qp_i", "23", "-qp_p", "23"]
    if VIDEO_ENCODER == "h264_qsv":
        return ["-c:v", VIDEO_ENCODER, "-preset", "veryfast", "-global_quality", "23"]
    return ["-c:v", VIDEO_ENCODER, "-preset", "p4", "-cq", "23"]


def print_media_setup_check():
    configured = os.environ.get("SUPERMEMORY_FFMPEG_DIR") or "<not set>"
    missing = missing_media_tools()
    print("[setup] SUPERMEMORY_FFMPEG_DIR=" + configured, flush=True)
    print("[setup] ffmpeg=" + (shutil.which(FFMPEG) or "not found"), flush=True)
    print("[setup] ffprobe=" + (shutil.which(FFPROBE) or "not found"), flush=True)
    print("[setup] video encoder=" + VIDEO_ENCODER, flush=True)
    if VIDEO_ENCODER not in SUPPORTED_VIDEO_ENCODERS:
        print("[setup] video encoder check: FAILED", file=sys.stderr, flush=True)
        print("[setup] Supported encoders: " + ", ".join(sorted(SUPPORTED_VIDEO_ENCODERS)),
              file=sys.stderr, flush=True)
        return
    if not missing and not video_encoder_available():
        print("[setup] video encoder check: FAILED", file=sys.stderr, flush=True)
        print("[setup] The selected encoder is not usable on this machine. "
              "Use $env:SUPERMEMORY_VIDEO_ENCODER = 'libx264' or install the "
              "matching GPU driver.", file=sys.stderr, flush=True)
        return
    if missing:
        print("[setup] FFmpeg check: FAILED", file=sys.stderr, flush=True)
        print("[setup] PowerShell: $env:SUPERMEMORY_FFMPEG_DIR = "
              "'C:\\ffmpeg-7.0.1-full_build\\bin'", file=sys.stderr, flush=True)
        print("Warning: " + media_tool_message(missing), file=sys.stderr, flush=True)
    else:
        print("[setup] FFmpeg check: OK", flush=True)


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def finite_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def load_data():
    with (DATA / "json" / "all_qa.json").open(encoding="utf-8") as stream:
        items = json.load(stream)
    qa = {int(item["question_id"]): item for item in items}
    if len(qa) != len(items):
        raise ValueError("Duplicate question IDs in all_qa.json")
    starts = {}
    for item in items:
        meta = item.get("metadata") or {}
        observations = [(meta.get("primary_video_id"), meta.get("primary_video_start_time"))]
        question_evidence = item.get("question_evidence") or {}
        observations.append((question_evidence.get("video_id"), question_evidence.get("start_time")))
        observations += [(s.get("video_id"), s.get("video_start_time_unix"))
                         for s in question_evidence.get("time_spans") or []]
        observations += [(s.get("video_id"), s.get("start_time"))
                         for s in (item.get("answer_evidence") or {}).get("evidence_list") or []]
        for video_id, start in observations:
            if video_id and finite_number(start):
                if video_id in starts and starts[video_id] != start:
                    raise ValueError(f"Conflicting recording start for {video_id}")
                starts[video_id] = start
    return qa, starts


QA, VIDEO_STARTS = load_data()
PEOPLE_COUNTS = Counter(item["subject"] for item in QA.values())
PROBE_CACHE = {}
PROBE_LOCK = threading.Lock()
MEDIA_LOCKS = {}
MEDIA_LOCKS_GUARD = threading.Lock()
TRANSCRIPT_CACHE = {}
TRANSCRIPT_LOCK = threading.Lock()


def db_connection():
    connection = sqlite3.connect(DB, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA busy_timeout=30000")
    return connection


def init_db():
    STATE.mkdir(exist_ok=True)
    CACHE.mkdir(exist_ok=True)
    with db_connection() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS reviewers (
                id INTEGER PRIMARY KEY, login_key TEXT UNIQUE NOT NULL,
                display_name TEXT NOT NULL, salt BLOB NOT NULL,
                password_hash BLOB NOT NULL, created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY, reviewer_id INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                FOREIGN KEY(reviewer_id) REFERENCES reviewers(id)
            );
            CREATE TABLE IF NOT EXISTS reviews (
                reviewer_id INTEGER NOT NULL, question_id INTEGER NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('draft', 'submitted')),
                payload TEXT NOT NULL, version INTEGER NOT NULL,
                saved_at TEXT NOT NULL, submitted_at TEXT,
                PRIMARY KEY(reviewer_id, question_id),
                FOREIGN KEY(reviewer_id) REFERENCES reviewers(id)
            );
            CREATE INDEX IF NOT EXISTS reviews_status_idx
                ON reviews(reviewer_id, status);
        """)


def question_cutoff(item):
    spans = (item.get("question_evidence") or {}).get("time_spans") or []
    candidates = [s["video_start_time_unix"] + s["start_time"] for s in spans
                  if finite_number(s.get("video_start_time_unix")) and finite_number(s.get("start_time"))]
    if candidates:
        return min(candidates), "start of question context"
    return item["start_time"], "recording start; question context timing unavailable"


def video_path(video_id, person):
    if not VIDEO_ID.fullmatch(video_id) or int(VIDEO_ID.fullmatch(video_id).group(1)) != person:
        return None
    return DATA / "video" / f"Person_{person}" / f"{video_id}.mp4"


def video_duration(path):
    if not path or not path.is_file():
        return None
    stat = path.stat()
    key = (str(path), stat.st_size, stat.st_mtime_ns)
    with PROBE_LOCK:
        if key in PROBE_CACHE:
            return PROBE_CACHE[key]
    try:
        result = subprocess.run(
            [FFPROBE, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            capture_output=True, text=True, timeout=30, check=False)
    except OSError as exc:
        raise MediaToolUnavailable(media_tool_message(["ffprobe"])) from exc
    try:
        duration = float(result.stdout.strip()) if result.returncode == 0 else None
        if duration is not None and (not math.isfinite(duration) or duration <= 0):
            duration = None
    except ValueError:
        duration = None
    with PROBE_LOCK:
        PROBE_CACHE[key] = duration
    return duration


def transcript_path(video_id, person):
    root = DATA / "transcripts" / f"person_{person}"
    stem = video_id.lower()
    for suffix in ("_gemini_aligned_transcript.json", "_whisper_transcript.json"):
        path = root / (stem + suffix)
        if path.is_file():
            return path
    return None


def transcript_rows(path):
    if not path:
        return []
    stat = path.stat()
    key = (str(path), stat.st_mtime_ns)
    with TRANSCRIPT_LOCK:
        if key in TRANSCRIPT_CACHE:
            return TRANSCRIPT_CACHE[key]
    with path.open(encoding="utf-8") as stream:
        raw = json.load(stream)
    raw = raw.get("transcript", []) if isinstance(raw, dict) else raw
    rows = []
    for row in raw:
        start, end = row.get("start"), row.get("end")
        if finite_number(start) and finite_number(end) and end >= start:
            rows.append({
                "start": start, "end": end,
                "text": str(row.get("text") or ""),
                "speaker": row.get("person") or row.get("speaker") or "",
            })
    rows.sort(key=lambda row: row["start"])
    with TRANSCRIPT_LOCK:
        TRANSCRIPT_CACHE.clear()
        TRANSCRIPT_CACHE[key] = rows
    return rows


def eligible_recordings(item):
    person = item["subject"]
    cutoff, _ = question_cutoff(item)
    result = []
    for video_id in dict.fromkeys(item.get("video_ids") or []):
        start = VIDEO_STARTS.get(video_id)
        path = video_path(video_id, person)
        if start is None or start >= cutoff or path is None:
            continue
        missing = missing_media_tools() if path.is_file() else []
        tool_error = media_tool_message(missing) if missing else None
        try:
            duration = video_duration(path) if not missing else None
        except MediaToolUnavailable as exc:
            duration = None
            tool_error = str(exc)
        max_time = min(duration, cutoff - start) if duration is not None else cutoff - start
        if max_time <= 0:
            continue
        result.append({
            "video_id": video_id, "recording_start_unix": start,
            "allowed_until": round(max_time, 3), "video_available": duration is not None and not tool_error,
            "video_error": tool_error,
            "transcript_available": transcript_path(video_id, person) is not None,
        })
    return sorted(result, key=lambda row: (row["recording_start_unix"], row["video_id"]))


def public_question(item):
    cutoff, cutoff_source = question_cutoff(item)
    evidence = []
    for source in (item.get("answer_evidence") or {}).get("evidence_list") or []:
        span = source.get("time_span") or {}
        video_id = source.get("video_id")
        start, end = span.get("start_time"), span.get("end_time")
        if not video_id or not finite_number(start) or not finite_number(end):
            continue
        video_start = VIDEO_STARTS.get(video_id)
        evidence.append({
            "video_id": video_id, "start": start, "end": end,
            "modalities": [str(m) for m in source.get("modalities") or []],
            "within_cutoff": video_start is not None and video_start + end <= cutoff,
        })
    meta = item.get("metadata") or {}
    return {
        "question_id": item["question_id"], "person": item["subject"],
        "question": item["question"], "choices": item["choices"],
        "category": meta.get("skill") or "Uncategorized",
        "primary_video_id": meta.get("primary_video_id"),
        "question_time_unix": cutoff, "question_time_basis": cutoff_source,
        "evidence_spans": evidence,
        "recordings": eligible_recordings(item),
    }


def clean_review(payload, item, submitted):
    if not isinstance(payload, dict):
        raise ValueError("Review must be an object")
    clean = {}
    for key, allowed in (("clarity", CLARITY), ("answerability", ANSWERABILITY),
                         ("evidence_correctness", EVIDENCE)):
        value = payload.get(key)
        if value in (None, "") and not submitted:
            clean[key] = None
        elif value in allowed:
            clean[key] = value
        else:
            raise ValueError(f"Choose a valid {key.replace('_', ' ')}")
    choice = payload.get("predicted_choice")
    if choice in (None, "") and not submitted:
        clean["predicted_choice"] = None
    elif isinstance(choice, int) and not isinstance(choice, bool) and 0 <= choice < len(item["choices"]):
        clean["predicted_choice"] = choice
    else:
        raise ValueError("Choose one predicted answer")
    issues = payload.get("issues") or []
    if not isinstance(issues, list) or any(issue not in ISSUES for issue in issues):
        raise ValueError("Invalid issue reason")
    clean["issues"] = sorted(set(issues))
    for key, limit in (("other_issue", 500), ("feedback", 5000)):
        value = payload.get(key) or ""
        if not isinstance(value, str) or len(value) > limit:
            raise ValueError(f"{key.replace('_', ' ').capitalize()} is too long")
        clean[key] = value.strip()
    if submitted and "other" in clean["issues"] and not clean["other_issue"]:
        raise ValueError("Describe the other issue")
    edit = payload.get("edit_evidence") is True
    clean["edit_evidence"] = edit
    spans = payload.get("edited_spans") or []
    if not isinstance(spans, list) or len(spans) > 30:
        raise ValueError("Too many edited spans")
    permitted = {r["video_id"]: r["allowed_until"] for r in eligible_recordings(item)}
    edited = []
    if edit:
        for row in spans:
            if not isinstance(row, dict):
                raise ValueError("Invalid edited span")
            video_id, start, end = row.get("video_id"), row.get("start"), row.get("end")
            if video_id not in permitted and (submitted or video_id != ""):
                raise ValueError("Edited spans must use eligible recordings")
            if submitted and (not finite_number(start) or not finite_number(end)):
                raise ValueError("Edited spans need numeric start and end times")
            if not submitted and ((start is not None and not finite_number(start)) or
                                  (end is not None and not finite_number(end))):
                raise ValueError("Edited span times must be numeric")
            if submitted and (start < 0 or end <= start or end > permitted[video_id] - SAFETY_SECONDS):
                raise ValueError("Edited spans must end before the question cutoff")
            modalities = row.get("modalities") or []
            if not isinstance(modalities, list) or len(modalities) > 8 or any(not isinstance(m, str) or len(m) > 30 for m in modalities):
                raise ValueError("Invalid edited span modality")
            edited.append({"video_id": video_id, "start": start, "end": end,
                           "modalities": list(dict.fromkeys(modalities))})
    clean["edited_spans"] = edited
    if submitted and edit and not edited and clean["evidence_correctness"] == "Sufficient and correctly timed":
        raise ValueError("A sufficient evidence rating conflicts with removing every span")
    return clean


def prune_cache():
    files = sorted(CACHE.glob("*.mp4"), key=lambda path: path.stat().st_mtime)
    total = sum(path.stat().st_size for path in files)
    for path in files:
        if total <= MAX_CACHE_BYTES:
            break
        size = path.stat().st_size
        try:
            path.unlink()
            total -= size
        except OSError:
            pass


def clipped_media(item, video_id, segment):
    recording = next((r for r in eligible_recordings(item) if r["video_id"] == video_id), None)
    if recording and recording["video_error"]:
        raise MediaToolUnavailable(recording["video_error"])
    if recording is None or not recording["video_available"]:
        raise FileNotFoundError("Recording is unavailable or outside the review cutoff")
    if not isinstance(segment, int) or segment < 0:
        raise ValueError("Invalid segment")
    at = segment * SEGMENT_SECONDS
    remaining = recording["allowed_until"] - SAFETY_SECONDS - at
    if remaining <= 0:
        raise FileNotFoundError("Segment is outside the review cutoff")
    length = min(SEGMENT_SECONDS, remaining)
    source = video_path(video_id, item["subject"])
    stat = source.stat()
    key = hashlib.sha256(f"{source}:{stat.st_size}:{stat.st_mtime_ns}:{at}:{length:.3f}".encode()).hexdigest()
    target = CACHE / (key + ".mp4")
    with MEDIA_LOCKS_GUARD:
        lock = MEDIA_LOCKS.setdefault(key, threading.Lock())
    with lock:
        if target.is_file() and target.stat().st_size:
            target.touch()
            return target
        tmp = CACHE / (key + "." + secrets.token_hex(4) + ".tmp.mp4")
        command = [
            FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
            "-ss", str(at), "-i", str(source), "-t", f"{length:.3f}",
            "-map", "0:v:0", "-map", "0:a:0?", *video_encoder_options(), "-c:a", "aac",
            "-b:a", "96k", "-movflags", "+faststart", str(tmp),
        ]
        try:
            try:
                result = subprocess.run(command, capture_output=True, text=True, timeout=300, check=False)
            except OSError as exc:
                raise MediaToolUnavailable(media_tool_message(["ffmpeg"])) from exc
            if result.returncode or not tmp.is_file() or not tmp.stat().st_size:
                raise RuntimeError("Could not prepare this video segment: " + result.stderr[-500:])
            os.replace(tmp, target)
            prune_cache()
            return target
        finally:
            tmp.unlink(missing_ok=True)


class PortalHandler(BaseHTTPRequestHandler):
    server_version = "SuperMemoryReview/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def send_body(self, status, body, content_type="application/json; charset=utf-8", headers=None):
        if not isinstance(body, bytes):
            body = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def error_json(self, status, message):
        self.send_body(status, {"error": message})

    def request_json(self):
        if self.headers.get("Content-Type", "").split(";")[0] != "application/json" or self.headers.get("X-Portal-Request") != "1":
            raise ValueError("Expected a portal JSON request")
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 256_000:
            raise ValueError("Invalid request size")
        return json.loads(self.rfile.read(length))

    def reviewer(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
            token = cookie[SESSION_COOKIE].value
        except Exception:
            return None
        digest = hashlib.sha256(token.encode()).hexdigest()
        with db_connection() as db:
            row = db.execute("""SELECT reviewers.id, reviewers.display_name FROM sessions
                JOIN reviewers ON reviewers.id=sessions.reviewer_id
                WHERE sessions.token_hash=? AND sessions.expires_at>?""",
                (digest, int(time.time()))).fetchone()
        return dict(row) if row else None

    def require_reviewer(self):
        reviewer = self.reviewer()
        if not reviewer:
            self.error_json(HTTPStatus.UNAUTHORIZED, "Sign in to review")
        return reviewer

    def do_GET(self):
        parsed = urlsplit(self.path)
        path = unquote(parsed.path)
        query = parse_qs(parsed.query)
        try:
            if path == "/api/session":
                self.send_body(200, {"reviewer": self.reviewer()})
                return
            if path.startswith("/api/"):
                reviewer = self.require_reviewer()
                if not reviewer:
                    return
                if path == "/api/people":
                    with db_connection() as db:
                        rows = db.execute("SELECT question_id,status FROM reviews WHERE reviewer_id=?",
                                          (reviewer["id"],)).fetchall()
                    progress = {person: {"draft": 0, "submitted": 0} for person in PEOPLE_COUNTS}
                    for row in rows:
                        item = QA.get(row["question_id"])
                        if item:
                            progress[item["subject"]][row["status"]] += 1
                    self.send_body(200, {"people": [{"person": n, "total": PEOPLE_COUNTS[n], **progress[n]}
                                                       for n in sorted(PEOPLE_COUNTS)]})
                    return
                match = re.fullmatch(r"/api/people/(10|[1-9])/questions", path)
                if match:
                    person = int(match.group(1))
                    with db_connection() as db:
                        rows = db.execute("SELECT question_id,status FROM reviews WHERE reviewer_id=?", (reviewer["id"],)).fetchall()
                    statuses = {row["question_id"]: row["status"] for row in rows}
                    items = [{"question_id": q["question_id"], "question": q["question"],
                              "category": (q.get("metadata") or {}).get("skill"),
                              "status": statuses.get(q["question_id"], "new")}
                             for q in QA.values() if q["subject"] == person]
                    self.send_body(200, {"person": person, "questions": items})
                    return
                match = re.fullmatch(r"/api/questions/(\d+)(?:/(review|transcript|media/[^/]+))?", path)
                if match:
                    question_id = int(match.group(1))
                    item = QA.get(question_id)
                    if not item:
                        self.error_json(404, "Question not found")
                        return
                    action = match.group(2)
                    if action is None:
                        self.send_body(200, public_question(item))
                    elif action == "review":
                        with db_connection() as db:
                            row = db.execute("SELECT status,payload,version,saved_at,submitted_at FROM reviews WHERE reviewer_id=? AND question_id=?",
                                             (reviewer["id"], question_id)).fetchone()
                        self.send_body(200, {"review": {**dict(row), "payload": json.loads(row["payload"])} if row else None})
                    elif action == "transcript":
                        self.get_transcript(item, query)
                    else:
                        video_id = action.split("/", 1)[1]
                        self.get_media(item, video_id, query)
                    return
                self.error_json(404, "Not found")
                return
            self.get_static(path)
        except (ValueError, json.JSONDecodeError) as exc:
            self.error_json(400, str(exc))
        except Exception as exc:
            self.log_message("GET failure: %r", exc)
            self.error_json(500, "Server error")

    def get_static(self, path):
        names = {"/": "index.html", "/static/app.css": "app.css", "/static/app.js": "app.js"}
        if path.startswith("/review/"):
            filename = "index.html"
        else:
            filename = names.get(path)
        if not filename:
            self.error_json(404, "Not found")
            return
        mime = {"index.html": "text/html; charset=utf-8", "app.css": "text/css; charset=utf-8",
                "app.js": "text/javascript; charset=utf-8"}[filename]
        self.send_body(200, (STATIC / filename).read_bytes(), mime)

    def get_transcript(self, item, query):
        video_id = (query.get("video") or [""])[0]
        recording = next((r for r in eligible_recordings(item) if r["video_id"] == video_id), None)
        if not recording:
            self.error_json(403, "Recording is outside the review cutoff")
            return
        start = float((query.get("from") or ["0"])[0])
        end = float((query.get("to") or [str(start + SEGMENT_SECONDS)])[0])
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start or end - start > 120:
            raise ValueError("Invalid transcript window")
        max_time = recording["allowed_until"] - SAFETY_SECONDS
        rows = [row for row in transcript_rows(transcript_path(video_id, item["subject"]))
                if row["end"] <= max_time and row["start"] < min(end, max_time) and row["end"] >= start]
        self.send_body(200, {"video_id": video_id, "rows": rows})

    def get_media(self, item, video_id, query):
        if not VIDEO_ID.fullmatch(video_id):
            self.error_json(404, "Recording not found")
            return
        try:
            segment = int((query.get("segment") or ["0"])[0])
            path = clipped_media(item, video_id, segment)
        except FileNotFoundError as exc:
            self.error_json(404, str(exc))
            return
        except MediaToolUnavailable as exc:
            self.error_json(503, str(exc))
            return
        size = path.stat().st_size
        range_header = self.headers.get("Range")
        start, end = 0, size - 1
        if range_header:
            match = re.fullmatch(r"bytes=(\d+)-(\d*)", range_header.strip())
            if not match:
                self.error_json(416, "Invalid byte range")
                return
            start = int(match.group(1))
            end = min(int(match.group(2)), size - 1) if match.group(2) else size - 1
            if start >= size or end < start:
                self.error_json(416, "Byte range outside clip")
                return
        self.send_response(206 if range_header else 200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "private, no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if range_header:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        try:
            with path.open("rb") as stream:
                stream.seek(start)
                remaining = end - start + 1
                while remaining:
                    chunk = stream.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        path = urlsplit(self.path).path
        try:
            body = self.request_json()
            if path == "/api/session":
                self.create_session(body)
                return
            reviewer = self.require_reviewer()
            if not reviewer:
                return
            match = re.fullmatch(r"/api/questions/(\d+)/review", path)
            if not match:
                self.error_json(404, "Not found")
                return
            item = QA.get(int(match.group(1)))
            if not item:
                self.error_json(404, "Question not found")
                return
            submitted = body.get("submit") is True
            cleaned = clean_review(body.get("payload"), item, submitted)
            version = body.get("version")
            if not isinstance(version, int) or version < 0:
                raise ValueError("Invalid review version")
            with db_connection() as db:
                db.execute("BEGIN IMMEDIATE")
                old = db.execute("SELECT version,status FROM reviews WHERE reviewer_id=? AND question_id=?",
                                 (reviewer["id"], item["question_id"])).fetchone()
                if old and old["status"] == "submitted":
                    self.error_json(409, "This review has already been submitted")
                    return
                if version != (old["version"] if old else 0):
                    self.error_json(409, "This review changed in another tab. Reload to continue")
                    return
                new_version = version + 1
                timestamp = now_iso()
                db.execute("""INSERT INTO reviews(reviewer_id,question_id,status,payload,version,saved_at,submitted_at)
                    VALUES(?,?,?,?,?,?,?) ON CONFLICT(reviewer_id,question_id) DO UPDATE SET
                    status=excluded.status,payload=excluded.payload,version=excluded.version,
                    saved_at=excluded.saved_at,submitted_at=excluded.submitted_at""",
                    (reviewer["id"], item["question_id"], "submitted" if submitted else "draft",
                     json.dumps(cleaned, ensure_ascii=False), new_version, timestamp, timestamp if submitted else None))
            self.send_body(200, {"status": "submitted" if submitted else "draft", "version": new_version,
                                 "saved_at": timestamp})
        except (ValueError, json.JSONDecodeError) as exc:
            self.error_json(400, str(exc))
        except Exception as exc:
            self.log_message("POST failure: %r", exc)
            self.error_json(500, "Server error")

    def create_session(self, body):
        name = str(body.get("name") or "").strip()
        password = body.get("passphrase")
        if not 2 <= len(name) <= 64 or not isinstance(password, str) or len(password) < 8:
            raise ValueError("Enter a reviewer name (2–64 characters) and passphrase (8+ characters)")
        key = name.casefold()
        with db_connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM reviewers WHERE login_key=?", (key,)).fetchone()
            if row:
                digest = hashlib.pbkdf2_hmac("sha256", password.encode(), row["salt"], 200_000)
                if not hmac.compare_digest(digest, row["password_hash"]):
                    self.error_json(401, "Incorrect passphrase for this reviewer name")
                    return
                reviewer_id, display = row["id"], row["display_name"]
            else:
                salt = secrets.token_bytes(16)
                digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 200_000)
                cursor = db.execute("INSERT INTO reviewers(login_key,display_name,salt,password_hash,created_at) VALUES(?,?,?,?,?)",
                                    (key, name, salt, digest, now_iso()))
                reviewer_id, display = cursor.lastrowid, name
            token = secrets.token_urlsafe(32)
            db.execute("INSERT INTO sessions(token_hash,reviewer_id,expires_at) VALUES(?,?,?)",
                       (hashlib.sha256(token.encode()).hexdigest(), reviewer_id, int(time.time()) + 30 * 86400))
        self.send_body(200, {"reviewer": {"id": reviewer_id, "display_name": display}}, headers={
            "Set-Cookie": f"{SESSION_COOKIE}={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000",
        })

    def do_DELETE(self):
        if urlsplit(self.path).path != "/api/session":
            self.error_json(404, "Not found")
            return
        if self.headers.get("X-Portal-Request") != "1":
            self.error_json(400, "Expected a portal request")
            return
        cookie = SimpleCookie()
        cookie.load(self.headers.get("Cookie", ""))
        if SESSION_COOKIE in cookie:
            digest = hashlib.sha256(cookie[SESSION_COOKIE].value.encode()).hexdigest()
            with db_connection() as db:
                db.execute("DELETE FROM sessions WHERE token_hash=?", (digest,))
        self.send_body(200, {"ok": True}, headers={
            "Set-Cookie": f"{SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        })


def main():
    import argparse
    parser = argparse.ArgumentParser(description="SuperMemory-VQA review portal")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    init_db()
    print_media_setup_check()
    server = ThreadingHTTPServer((args.host, args.port), PortalHandler)
    print(f"Review portal: http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
