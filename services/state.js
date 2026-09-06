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
        playbackType: null,
        isLive: false,
        durationSeconds: null,
        elapsedSeconds: null,
        remainingSeconds: null,
        durationLabel: '--:--',
        elapsedLabel: '--:--',
        remainingLabel: '--:--',
        progressLabel: '--:--/--:--',
        downloadProgress: null,
        queue: [],
        status: 'starting'
    };
}

function updateFormattedState(state) {
    if (state.isLive) {
        // Livestreams do not have a meaningful fixed duration. Showing "live"
        // makes chat/UI output honest instead of pretending there is a normal
        // elapsed/remaining timeline.
        state.durationLabel = 'live';
        state.elapsedLabel = 'live';
        state.remainingLabel = 'live';
        state.progressLabel = 'live';
    } else {
        state.durationLabel = formatSeconds(state.durationSeconds);
        state.elapsedLabel = formatSeconds(state.elapsedSeconds);
        state.remainingLabel = formatSeconds(state.remainingSeconds);
        state.progressLabel = `${state.elapsedLabel}/${state.durationLabel}`;
    }
}

module.exports = { createPlayerState, updateFormattedState };
