# SuperMemory-VQA review studio

Local annotation portal for independent review of the SuperMemory-VQA QA labels.


## Demo Video

Watch Demo Here: 
[Video Link](https://drive.google.com/file/d/1AINLujV1hYkQoH3jxfXgftv4Qv2oz0nI/view?usp=drive_link)


## Run

Requirements: Python 3.10+ and FFmpeg. The portal itself uses only the Python standard library.

Set the FFmpeg `bin` directory and one video encoder before starting the portal. Run only one of these PowerShell configurations:

```powershell
# AMD GPU
$env:SUPERMEMORY_FFMPEG_DIR = 'C:\ffmpeg-7.0.1-full_build\bin'
$env:SUPERMEMORY_VIDEO_ENCODER = 'h264_amf'
python portal/server.py --port 9876
```

For an NVIDIA GPU, use `h264_nvenc` instead:

```powershell
$env:SUPERMEMORY_FFMPEG_DIR = 'C:\ffmpeg-7.0.1-full_build\bin'
$env:SUPERMEMORY_VIDEO_ENCODER = 'h264_nvenc'
python portal/server.py --port 9876
```

For CPU-only encoding, use `libx264`:

```powershell
$env:SUPERMEMORY_FFMPEG_DIR = 'C:\ffmpeg-7.0.1-full_build\bin'
$env:SUPERMEMORY_VIDEO_ENCODER = 'libx264'
python portal/server.py --port 9876
```

The FFmpeg directory must contain `ffmpeg.exe` and `ffprobe.exe`. Hardware encoding also requires a supported GPU driver.

Open <http://127.0.0.1:9876>. Enter a reviewer name and a passphrase of at least eight characters. A new name creates a reviewer account; entering the same name and passphrase resumes its drafts. Select Person 1–10 to see that person's questions. Person 9 has 310 QA items.

The server reads QA from `data/json/all_qa.json`, redacted transcripts from `data/transcripts/person_N`, and video from `data/video/Person_N`. Videos are deliberately excluded from this GitHub repository. Place the MP4 files from the [SuperMemory-VQA dataset](https://huggingface.co/datasets/OSU-AIoT-MLSys-Lab/SuperMemory-VQA/tree/main/data/video) under `data/video/Person_N` to enable playback. Missing video is shown as unavailable; available transcripts can still be reviewed.

The bundled QA JSON and redacted transcripts come from [OSU-AIoT-MLSys-Lab/SuperMemory-VQA](https://huggingface.co/datasets/OSU-AIoT-MLSys-Lab/SuperMemory-VQA), which lists the data license as [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/).

## Review data

Drafts autosave after edits and can also be saved manually. Submission requires clarity, answerability, evidence correctness, and a predicted choice. Submitted reviews are locked. Records are stored in `var/reviews.sqlite3`, keyed by reviewer and question, with version, status, timestamps, and a JSON review payload. Media clips are cached under `var/media_cache`; the cache is disposable and bounded to about 2 GiB. Set `SUPERMEMORY_PORTAL_STATE_DIR` to move the database and cache.

The review API constructs an explicit public question object. It sends the question, choices, category, participant/session data, recording eligibility, and GT evidence **video IDs, times, and modalities**. It does not send the answer key, correctness labels, dataset answerability label, evidence text, or other raw `answer_evidence` fields. The source JSON and source MP4 files have no static route.

Export submitted judgments as JSON Lines for agreement analysis:

```sh
python portal/export_reviews.py --output reviews.jsonl
```

Add `--include-drafts` to include unfinished reviews. Each line contains reviewer name, question ID, status/timestamps, judgments, issue reasons, feedback, and suggested evidence spans.

The dataset's `start_time` is the recording's Unix start time. The portal takes the earliest `question_evidence.time_spans` start as a conservative cutoff for that question. For the six QA items without question-context spans, it uses the recording start and flags later GT spans. An eligible recording must start before the cutoff; playback and transcript rows are capped before it. Video requests generate short re-encoded clips and never serve byte ranges from the source MP4. A small 0.25-second margin keeps encoding at the boundary conservative. GT spans after the cutoff remain visible as metadata but cannot be played.

The player displays synchronized redacted transcript lines as optional on-video captions. Use **CC On/Off** below the player to toggle them; the full transcript panel remains available for reading. Captions are available only where a redacted transcript file exists.

This is a local study tool. By default it binds only to `127.0.0.1`. Reviewer name/passphrase accounts separate drafts; for a remotely hosted study, add HTTPS and your institution's access controls before opening the port publicly.

## Checks

```sh
python -m unittest portal/test_server.py -v
```

The checks cover sanitized QA responses, Person 9 selection, reviewer isolation and submission, transcript cutoff, source file blocking, and an actual FFmpeg clip that ends before a synthetic question cutoff.
