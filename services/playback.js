const fs = require('fs');
const { spawn, execFile } = require('child_process');

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
