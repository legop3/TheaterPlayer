const blessed = require('@blessed/neo-blessed');

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const BUSY_STATUSES = new Set([
    'starting',
    'searching media library',
    'searching',
    'inspecting media',
    'cleaning cache'
]);

function capitalize(value) {
    const text = String(value || 'idle');
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '--';

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = Math.max(0, bytes);
    let unitIndex = 0;

    // Advancing through the fixed unit list keeps byte counts compact enough
    // for a centered terminal layout without hiding the transferred amount.
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }

    const decimals = unitIndex === 0 || value >= 100 ? 0 : (value >= 10 ? 1 : 2);
    return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

function formatDuration(totalSeconds) {
    if (!Number.isFinite(totalSeconds)) return '--:--';

    const seconds = Math.max(0, Math.ceil(totalSeconds));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = seconds % 60;

    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
    }
    return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function buildProgressBar(percent, width) {
    const boundedPercent = Math.max(0, Math.min(1, percent));
    const completedWidth = Math.round(boundedPercent * width);
    return '█'.repeat(completedWidth) + '░'.repeat(width - completedWidth);
}

function truncateMiddle(value, maximumLength) {
    const text = String(value || '');
    if (text.length <= maximumLength) return text;
    if (maximumLength <= 3) return text.slice(0, maximumLength);

    // Preserve both the containing folder and the recognizable end of a long
    // filename. Cutting only the right side would often hide the extension or
    // the most distinguishing part of similarly named media.
    const available = maximumLength - 3;
    const leftLength = Math.ceil(available / 2);
    const rightLength = Math.floor(available / 2);
    return `${text.slice(0, leftLength)}...${text.slice(-rightLength)}`;
}

function createTerminalUi() {
    const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY);
    let latestState = {};
    let spinnerIndex = 0;
    let lastFallbackLine = null;
    let lastFallbackStateKey = null;
    let lastFallbackAt = 0;

    // Blessed owns the interactive terminal screen and recalculates centered
    // positions on resize. The one borderless box is only a layout container;
    // it deliberately provides no window chrome, title, menu, or input controls.
    const screen = interactive
        ? blessed.screen({ smartCSR: true, fullUnicode: true })
        : null;
    const content = screen
        ? blessed.box({
            parent: screen,
            top: 'center',
            left: 'center',
            width: '100%',
            height: 1,
            align: 'center',
            valign: 'middle',
            tags: false
        })
        : null;

    if (screen) {
        // Blessed enables raw input mode while it owns the screen, so explicitly
        // retain the ordinary Ctrl+C behavior people expect from this process.
        screen.key(['C-c'], () => {
            screen.destroy();
            process.exit(0);
        });
    }

    function getAvailableWidth() {
        const columns = screen ? Number(screen.width) : Number(process.stdout.columns);
        return Math.max(10, (Number.isFinite(columns) ? columns : 100) - 4);
    }

    function buildLines() {
        const state = latestState;
        const availableWidth = getAvailableWidth();

        if (state.status === 'downloading' && state.downloadProgress) {
            const progress = state.downloadProgress;
            const percent = Number.isFinite(progress.percent) ? progress.percent : 0;
            const percentLabel = `${Math.round(percent * 100)}%`;
            const barWidth = Math.max(10, Math.min(48, availableWidth - percentLabel.length - 2));
            const speed = progress.bytesPerSecond > 0
                ? `${formatBytes(progress.bytesPerSecond)}/s`
                : '--/s';
            const details = `${formatBytes(progress.transferredBytes)} / ${formatBytes(progress.totalBytes)} • ${speed} • ETA ${formatDuration(progress.etaSeconds)}`;

            // These four consecutive lines are the entire download view. There
            // are intentionally no blank spacer rows between any of them.
            return [
                'Downloading',
                truncateMiddle(state.title, availableWidth),
                `${buildProgressBar(percent, barWidth)}  ${percentLabel}`,
                truncateMiddle(details, availableWidth)
            ];
        }

        if (state.status === 'playing') {
            return [
                'Playing',
                truncateMiddle(state.title, availableWidth),
                state.progressLabel || '--:--/--:--'
            ];
        }

        if (state.status === 'playing stream') {
            return ['Playing stream', truncateMiddle(state.title, availableWidth)];
        }

        const statusText = truncateMiddle(capitalize(state.status), availableWidth - 2);
        if (BUSY_STATUSES.has(state.status)) {
            return [`${SPINNER_FRAMES[spinnerIndex]} ${statusText}…`];
        }

        return [statusText];
    }

    function draw() {
        const lines = buildLines();

        if (screen) {
            // Matching the box height to the exact line count is what centers the
            // whole compact block vertically without inserting blank lines.
            content.height = lines.length;
            content.setContent(lines.join('\n'));
            screen.render();
            return;
        }

        const line = lines.join('\n');
        const now = Date.now();
        const stateKey = `${latestState.status || ''}|${latestState.title || ''}`;
        const stateChanged = stateKey !== lastFallbackStateKey;

        // Redirected output remains a conventional, rate-limited log because a
        // full-screen layout is inappropriate when no interactive terminal exists.
        if (line !== lastFallbackLine && (stateChanged || now - lastFallbackAt >= 5000)) {
            process.stdout.write(`${line}\n`);
            lastFallbackLine = line;
            lastFallbackStateKey = stateKey;
            lastFallbackAt = now;
        }
    }

    const spinnerTimer = setInterval(() => {
        spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length;
        if (screen && BUSY_STATUSES.has(latestState.status)) draw();
    }, 80);
    spinnerTimer.unref();

    return {
        render(state) {
            latestState = state;
            draw();
        }
    };
}

module.exports = { createTerminalUi };
