import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const rawVideo = resolve(root, 'demo/scopeguard-demo.webm');
const recordingMetadata = resolve(root, 'demo/recording-metadata.json');
const narration = resolve(root, 'demo/scopeguard-narration.wav');
const narratedVideo = resolve(root, 'demo/scopeguard-demo-narrated.mp4');
const finalVideo = resolve(root, 'demo/scopeguard-demo.mp4');
const subtitles = resolve(root, 'demo/scopeguard-demo.srt');
const narrationSentences = [
  'ScopeGuard begins with one boundary. The language model may describe a purchase, but it never receives PayPal credentials.',
  'This is the clearly labeled local simulation mode. A twelve dollar inference request is reduced to four fields, checked against fixed category and spending rules, and reserved before any remote call.',
  'The simulator now returns buyer approval. Capture is still a separate, explicit action.',
  'Here, the remote side completes the capture, but the response is deliberately dropped. ScopeGuard does not release the budget or guess that payment failed. It keeps the amount reserved, and marks the outcome uncertain.',
  'Reconciliation reads the authoritative order state, and commits the reservation exactly once. It does not send a second capture.',
  'The next requests are rejected deterministically. One exceeds the twenty five dollar transaction limit. The other uses a prohibited merchant category. Neither reaches PayPal.',
  'The local audit trail records each reservation, uncertain outcome, reconciliation, completion, and denial across restarts.',
  'This recording uses an in-memory PayPal simulator. No real sandbox payment is claimed. The repository also includes raw-body webhook signature verification, and twenty five passing tests.',
];
const narrationDurations = [8.85, 13.875, 6.475, 14.85, 9.375, 12.8, 9.375, 14.75];
const sentencePause = 0.35;

function runFfmpeg(args) {
  const result = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`ffmpeg exited with status ${result.status}`);
}

function duration(filePath) {
  const result = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath],
    { cwd: root, encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`ffprobe failed for ${filePath}`);
  return Number(result.stdout.trim());
}

function srtTime(seconds) {
  const millis = Math.max(0, Math.round(seconds * 1000));
  const ms = millis % 1000;
  const totalSeconds = Math.floor(millis / 1000);
  const sec = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const min = totalMinutes % 60;
  const hour = Math.floor(totalMinutes / 60);
  return `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

const spokenDuration = duration(narration);
const sourceDuration = duration(rawVideo);
const { trimStartSeconds } = JSON.parse(readFileSync(recordingMetadata, 'utf8'));
if (!Number.isFinite(trimStartSeconds) || trimStartSeconds < 0 || trimStartSeconds >= sourceDuration) {
  throw new Error(`Invalid recording trim start: ${trimStartSeconds}`);
}
const usableVideoDuration = sourceDuration - trimStartSeconds;
const tailDuration = 1.0;
const outputDuration = Math.max(spokenDuration, usableVideoDuration) + tailDuration;
const videoPad = Math.max(0, outputDuration - usableVideoDuration);
const audioPad = Math.max(0, outputDuration - spokenDuration);
const fadeStart = Math.max(0, spokenDuration - 0.65);

let captionStart = 0.1;
let captionIndex = 0;
const captionRows = [];
for (let sentenceIndex = 0; sentenceIndex < narrationSentences.length; sentenceIndex += 1) {
  const words = narrationSentences[sentenceIndex].split(/\s+/);
  const chunks = [];
  for (let wordIndex = 0; wordIndex < words.length; wordIndex += 10) {
    chunks.push(words.slice(wordIndex, wordIndex + 10).join(' '));
  }
  const sentenceDuration = narrationDurations[sentenceIndex];
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const chunkWords = chunks[chunkIndex].split(/\s+/).length;
    const chunkDuration = sentenceDuration * (chunkWords / words.length);
    const captionEnd = captionStart + chunkDuration;
    captionIndex += 1;
    captionRows.push(
      `${captionIndex}\n${srtTime(captionStart)} --> ${srtTime(captionEnd)}\n${chunks[chunkIndex]}`,
    );
    captionStart = captionEnd;
  }
  captionStart += sentencePause;
}
writeFileSync(subtitles, `${captionRows.join('\n\n')}\n`);

runFfmpeg([
  '-i', rawVideo,
  '-i', narration,
  '-filter_complex', `[0:v]trim=start=${trimStartSeconds.toFixed(3)},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${videoPad.toFixed(3)}[v];[1:a]afade=t=in:st=0:d=0.2,afade=t=out:st=${fadeStart.toFixed(3)}:d=0.6,loudnorm=I=-16:TP=-1.5:LRA=11,apad=pad_dur=${audioPad.toFixed(3)}[a]`,
  '-map', '[v]',
  '-map', '[a]',
  '-c:v', 'libx264',
  '-preset', 'medium',
  '-crf', '21',
  '-pix_fmt', 'yuv420p',
  '-c:a', 'aac',
  '-b:a', '128k',
  '-ar', '48000',
  '-movflags', '+faststart',
  '-t', outputDuration.toFixed(3),
  narratedVideo,
]);

runFfmpeg([
  '-i', narratedVideo,
  '-vf', "subtitles=demo/scopeguard-demo.srt:force_style='FontName=Arial,FontSize=11,PrimaryColour=&H00FFFFFF,OutlineColour=&H00101816,BorderStyle=3,BackColour=&H9007100F,Outline=1,Shadow=0,MarginV=18'",
  '-c:v', 'libx264',
  '-preset', 'medium',
  '-crf', '20',
  '-pix_fmt', 'yuv420p',
  '-c:a', 'copy',
  '-movflags', '+faststart',
  finalVideo,
]);

console.log(`Saved narrated ScopeGuard demo to ${finalVideo}`);
