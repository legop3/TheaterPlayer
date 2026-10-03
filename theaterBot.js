const { io } = require('socket.io-client');

const HELP = [
    '!play <search or URL>: Play now, with YouTube fallback.',
    '!q <search or URL>: Add to the request queue.',
    '!yt <search>: Play from YouTube.',
    '!streams: List streams.',
    '!skip: Skip playback or preparation.',
    '!now: Show what’s playing and what’s next.',
    '!info: Show theater status.',
    '!help: Show commands.'
].join('\n');

const ALIASES = {
    '!p': '!play', '!tfind': '!play', '!yt': '!youtube',
    '!ls': '!streams', '!s': '!skip', '!tskip': '!skip', '!tsk': '!skip',
    tsk: '!skip', '!h': '!help'
};

function startTheaterBot(serverUrl, handlers = {}) {
    if (!serverUrl) return { send: () => {}, close: () => {} };
    const socket = io(serverUrl, {
        transports: ['websocket', 'polling'], query: { role: 'spectator' }, timeout: 15000
    });
    let ready = false;
    let connection = 0;
    let outbox = Promise.resolve();
    const emitAck = (event, payload = {}) => new Promise((resolve, reject) => {
        socket.timeout(10000).emit(event, payload, (error, response = {}) => {
            if (error || response.error) reject(error || new Error(response.error));
            else resolve(response);
        });
    });
    function send(text) {
        if (!ready || !text) return;
        // Chat delivery must never gate playback. Serialize messages for readable
        // ordering, and do not replay stale announcements after reconnecting.
        const generation = connection;
        outbox = outbox.then(async () => {
            if (!ready || generation !== connection) return;
            const chunks = [];
            let chunk = '';
            for (const line of String(text).split('\n')) {
                if (chunk && chunk.length + line.length + 1 > 400) {
                    chunks.push(chunk);
                    chunk = '';
                }
                let rest = line;
                while (rest.length > 400) {
                    chunks.push(rest.slice(0, 400));
                    rest = rest.slice(400);
                }
                chunk += (chunk ? '\n' : '') + rest;
            }
            if (chunk) chunks.push(chunk);
            for (const text of chunks) {
                if (!ready || generation !== connection) return;
                await emitAck('chat:send', { text, bot: true, profileImage: handlers.profileImage || '' });
            }
        }).catch((error) => console.error('theater chat:', error.message));
    }
    socket.on('connect', async () => {
        try {
            await emitAck('nickname:set', { nickname: 'Theater' });
            await emitAck('session:setRole', { role: 'spectator' });
            ready = socket.connected;
        } catch (error) { console.error('theater bot handshake:', error.message); }
    });
    socket.on('session:sync', (session) => {
        handlers.onServerMode?.(session?.mode);
    });
    socket.on('disconnect', () => {
        ready = false;
        connection += 1;
        // Reconnect must provide a fresh snapshot before playback can resume.
        handlers.onServerMode?.(null);
    });
    socket.on('connect_error', (error) => console.error('theater bot connection:', error.message));
    socket.on('chat:message', (message = {}) => {
        if (!ready || message.bot) return;
        const match = String(message.text || '').trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
        if (!match) return;
        const command = ALIASES[match[1].toLowerCase()] || match[1].toLowerCase();
        const query = (match[2] || '').trim();
        try {
            switch (command) {
                case '!help': send(HELP); break;
                case '!streams': send(handlers.onStreams()); break;
                case '!now': send(handlers.onNow()); break;
                case '!info': send(handlers.onInfo()); break;
                case '!skip': send(handlers.onSkip() ? 'Skipping.' : 'Nothing to skip.'); break;
                case '!play':
                case '!q':
                case '!youtube':
                    if (!query) send(`Usage: ${command} <${command === '!youtube' ? 'search terms' : 'search or URL'}>`);
                    else handlers.onRequest(query, { next: command === '!q', youtube: command === '!youtube' });
                    break;
            }
        } catch (error) { send(`Couldn't process command: ${error.message}`); }
    });
    return { send, close: () => { ready = false; socket.disconnect(); } };
}

module.exports = { startTheaterBot };
