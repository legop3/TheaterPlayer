function formatSeconds(totalSeconds) {
    if (totalSeconds == null) return '--:--';
    const s = Math.max(0, totalSeconds);
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
}

function createPlayerState() {
    return {
        title: 'Nothing playing',
        durationSeconds: null,
        elapsedSeconds: null,
        remainingSeconds: null,
        durationLabel: '--:--',
        elapsedLabel: '--:--',
        remainingLabel: '--:--',
        progressLabel: '--:--/--:--',
        queue: [],
        status: 'starting'
    };
}

function broadcastState(io, state) {
    state.durationLabel = formatSeconds(state.durationSeconds);
    state.elapsedLabel = formatSeconds(state.elapsedSeconds);
    state.remainingLabel = formatSeconds(state.remainingSeconds);
    state.progressLabel = `${state.elapsedLabel}/${state.durationLabel}`;
    io.emit('state', state);
}

module.exports = { createPlayerState, broadcastState };
