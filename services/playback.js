const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.wav', '.ogg', '.opus', '.m4a', '.aac']);

function isLikelyUrl(source) {
    try {
        // Direct stream playback intentionally supports every URL protocol that
        // the installed mpv/FFmpeg stack supports. This check only decides
        // whether the source is URL-shaped so local-file-only behavior, such as
        // audio extension handling, is not applied to arbitrary remote URLs.
        const parsed = new URL(String(source || ''));
        return Boolean(parsed.protocol);
    } catch (_) {
        return false;
    }
}

function isAudioFile(source) {
    return !isLikelyUrl(source) && AUDIO_EXTENSIONS.has(path.extname(source).toLowerCase());
}

function getDurationSeconds(filePath) {
    return new Promise((resolve) => {
        execFile('ffprobe', [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath
        ], (err, stdout) => {
            if (err) return resolve(null);
            const n = Number((stdout || '').trim());
            resolve(Number.isFinite(n) ? Math.round(n) : null);
        });
    });
}

function playWithMpv(source, displayConfig) {
    const args = [];
    if (displayConfig && displayConfig.fullscreen) args.push('--fs');
    if (displayConfig && Number.isInteger(displayConfig.screen)) args.push(`--screen=${displayConfig.screen}`);
    args.push('--af=loudnorm');

    if (isAudioFile(source)) {
        // Audio-only files need a video stream so the theater display has
        // something intentional to show. The filter splits mpv's first audio
        // stream into normal audio output and FFmpeg's showcqt visualizer output.
        // This deliberately stays local-file-only because a stream URL can
        // represent video, audio, a playlist, or a protocol where extension
        // guessing is misleading. mpv should decide how remote sources render.
        args.push('--lavfi-complex=[aid1]asplit[ao][a]; [a]showcqt[vo]');
    }

    // Ask mpv itself to prefer English audio tracks before it applies its normal
    // fallback behavior. This avoids trying to translate ffprobe stream indexes
    // into mpv track ids, because mpv already understands the track metadata and
    // is the final authority on which audio ids can actually be selected.
    args.push('--alang=eng,en,english');

    args.push(source);

    const proc = spawn('mpv', args, { stdio: 'inherit' });
    const done = new Promise((resolve, reject) => {
        proc.on('error', reject);
        proc.on('close', (code, signal) => resolve({ code, signal }));
    });

    return { proc, done };
}

function cleanupTempDir(tempDir) {
    try {
        for (const name of fs.readdirSync(tempDir)) {
            const filePath = require('path').join(tempDir, name);
            try {
                fs.rmSync(filePath, { recursive: true, force: true });
            } catch (_) {}
        }
    } catch (_) {}
}

module.exports = { getDurationSeconds, playWithMpv, cleanupTempDir };
