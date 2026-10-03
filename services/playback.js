const path = require('path');
const { startProcess } = require('./process');

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.wav', '.ogg', '.opus', '.m4a', '.aac']);

async function playWithMpv(source, displayConfig = {}, signal, onUpdate = () => {}) {
    const args = ['--input-ipc-client=fd://3', '--af=loudnorm', '--alang=eng,en,english'];
    if (displayConfig.fullscreen) args.push('--fs');
    if (Number.isInteger(displayConfig.screen)) args.push(`--screen=${displayConfig.screen}`);
    if (path.isAbsolute(source) && AUDIO_EXTENSIONS.has(path.extname(source).toLowerCase())) {
        // Preserve the theater's local audio visualizer without guessing the
        // contents of remote URLs from their extensions.
        args.push('--lavfi-complex=[aid1]asplit[ao][a]; [a]showcqt[vo]');
    }
    args.push('--', source);
    const { proc, done } = startProcess('mpv', args, {
        signal, stdio: ['ignore', 'pipe', 'pipe', 'pipe']
    });
    const ipc = proc.stdio[3];
    let buffer = '';
    let diagnostics = '';
    let playbackError;
    let started = false;
    const properties = {};
    const capture = (chunk) => { diagnostics = (diagnostics + chunk).slice(-8192); };
    proc.stdout.on('data', capture);
    proc.stderr.on('data', capture);
    ipc.setEncoding('utf8');
    // An inherited duplex descriptor avoids socket paths and connection polling.
    ipc.on('error', (error) => { playbackError = `mpv control connection: ${error.message}`; });
    ipc.on('data', (chunk) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            let message;
            try { message = JSON.parse(line); } catch (_) { continue; }
            if (message.event === 'start-file') {
                started = false;
                for (const key of Object.keys(properties)) delete properties[key];
                onUpdate({ started: false, properties: { ...properties } });
            } else if (message.event === 'property-change') {
                properties[message.name] = message.data;
                onUpdate({ started, properties: { ...properties } });
            } else if (message.event === 'playback-restart') {
                started = true;
                onUpdate({ started, properties: { ...properties } });
            } else if (message.event === 'end-file' && message.reason === 'error') {
                playbackError = message.file_error || message.error || 'mpv could not play this source';
            }
        }
    });
    ['media-title', 'duration', 'time-pos', 'pause', 'paused-for-cache'].forEach((name, id) => {
        ipc.write(JSON.stringify({ command: ['observe_property', id, name] }) + '\n');
    });
    try {
        const result = await done;
        if (result.code !== 0 || playbackError) {
            const detail = diagnostics.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' ');
            throw new Error(playbackError || detail || `mpv exited with code ${result.code}`);
        }
    } finally {
        ipc.destroy();
    }
}

module.exports = { playWithMpv };
