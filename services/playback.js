const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.wav', '.ogg', '.opus', '.m4a', '.aac']);

function isAudioFile(filePath) {
    return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
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

function playWithMpv(filePath, displayConfig) {
    const args = [];
    if (displayConfig && displayConfig.fullscreen) args.push('--fs');
    if (displayConfig && Number.isInteger(displayConfig.screen)) args.push(`--screen=${displayConfig.screen}`);
    args.push('--af=loudnorm');

    if (isAudioFile(filePath)) {
        // Audio-only files need a video stream so the theater display has
        // something intentional to show. The filter splits mpv's first audio
        // stream into normal audio output and FFmpeg's showcqt visualizer output.
        args.push('--lavfi-complex=[aid1]asplit[ao][a]; [a]showcqt[vo]');
    }

    // Ask mpv itself to prefer English audio tracks before it applies its normal
    // fallback behavior. This avoids trying to translate ffprobe stream indexes
    // into mpv track ids, because mpv already understands the track metadata and
    // is the final authority on which audio ids can actually be selected.
    args.push('--alang=eng,en,english');

    args.push(filePath);

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
