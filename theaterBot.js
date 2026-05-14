const { io } = require('socket.io-client');

function startTheaterBot(serverUrl, handlers = {}) {
    const onSkip = handlers.onSkip || (() => false);
    const onFindAndPlay = handlers.onFindAndPlay || (async () => ({ ok: false, message: 'Search unavailable.' }));
    const profileImage = handlers.profileImage || '';

    if (!serverUrl) {
        console.log('theater bot disabled: no server url configured');
        return null;
    }

    const socket = io(serverUrl, {
        transports: ['websocket', 'polling'],
        query: { role: 'spectator' },
        timeout: 15000
    });

    function emitAck(event, payload = {}) {
        return new Promise((resolve, reject) => {
            socket.emit(event, payload, (resp = {}) => {
                if (resp.error) reject(new Error(resp.error));
                else resolve(resp);
            });
        });
    }

    function sendBotMessage(text) {
        return emitAck('chat:send', {
            text,
            bot: true,
            profileImage
        });
    }

    const helpCommands = [
        { command: '!help', description: 'Show available commands.' },
        { command: '!skip or tsk', description: 'Skip the currently playing video.' },
        { command: '!play <search text>', description: 'Find and play the best matching video.' }
    ];

    socket.on('connect', async () => {
        try {
            await emitAck('session:identify', { nickname: 'Theater' });
            await emitAck('session:setRole', { role: 'spectator' });
            await emitAck('session:subscribeAll');
            // await emitAck('chat:send', { text: 'TheaterBot online. Use !tskip to skip current video.' });
        } catch (e) {
            console.error('theater bot handshake failed:', e.message);
        }
    });

    socket.on('chat:message', async (msg = {}) => {
        const textRaw = String(msg.text || '').trim();
        const text = textRaw.toLowerCase();

        try {
            if (text === '!help') {
                const helpText = helpCommands
                    .map((c) => `${c.command} - ${c.description}`)
                    .join('\n');
                await sendBotMessage(helpText);
                return;
            }

            if (text === '!skip' || text === '!tskip' || text === 'tsk' || text === '!tsk') {
                const skipped = onSkip();
                if (skipped) await sendBotMessage('Skipping!');
                else await sendBotMessage('Nothing is currently playing.');
                return;
            }

            if (text.startsWith('!play ') || text.startsWith('!tfind ')) {
                const query = text.startsWith('!play ')
                    ? textRaw.slice(6).trim()
                    : textRaw.slice(7).trim();
                const result = await onFindAndPlay(query);
                if (result && result.ok) {
                    await sendBotMessage(`Playing: ${result.matched}`);
                } else {
                    await sendBotMessage(result && result.message ? result.message : 'No match found.');
                }
            }
        } catch (e) {
            console.error('theater bot chat send failed:', e.message);
        }
    });

    socket.on('connect_error', (err) => {
        console.error('theater bot connect error:', err.message);
    });

    return socket;
}

module.exports = { startTheaterBot };
