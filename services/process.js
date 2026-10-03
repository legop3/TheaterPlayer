const { spawn } = require('child_process');

function abortError() {
    const error = new Error('Cancelled');
    error.name = 'AbortError';
    return error;
}

function throwIfAborted(signal) {
    if (signal && signal.aborted) throw abortError();
}

function waitFor(promise, signal) {
    throwIfAborted(signal);
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
        const abort = () => reject(abortError());
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve(promise).then(resolve, reject).finally(() => {
            signal.removeEventListener('abort', abort);
        });
    });
}

function startProcess(command, args, { signal, ...options } = {}) {
    throwIfAborted(signal);
    // Own the process group as well as the direct child: mpv may spawn yt-dlp.
    const proc = spawn(command, args, { ...options, detached: true });
    let killTimer;
    let spawnError;
    function kill(childSignal) {
        if (!proc.pid) return;
        try { process.kill(-proc.pid, childSignal); } catch (error) {
            if (error.code !== 'ESRCH') proc.kill(childSignal);
        }
    }
    const abort = () => {
        kill('SIGTERM');
        killTimer = setTimeout(() => kill('SIGKILL'), 2000);
        killTimer.unref();
    };
    if (signal) signal.addEventListener('abort', abort, { once: true });
    const done = new Promise((resolve, reject) => {
        proc.on('error', (error) => { spawnError = error; });
        proc.on('close', (code, childSignal) => {
            if (signal && signal.aborted) kill('SIGKILL');
            clearTimeout(killTimer);
            if (signal) signal.removeEventListener('abort', abort);
            // Wait for close before rejecting, so callers can safely delete partial files.
            if (signal && signal.aborted) reject(abortError());
            else if (spawnError) reject(spawnError);
            else resolve({ code, signal: childSignal });
        });
    });
    return { proc, done };
}

module.exports = { abortError, throwIfAborted, waitFor, startProcess };
