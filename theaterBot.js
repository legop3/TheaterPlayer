const { io } = require('socket.io-client');

function startTheaterBot(serverUrl, onSkip) {
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

    socket.on('connect', async () => {
        try {
            await emitAck('session:identify', { nickname: 'TheaterBot' });
            await emitAck('session:setRole', { role: 'spectator' });
            await emitAck('session:subscribeAll');
            // await emitAck('chat:send', { text: 'TheaterBot online. Use !tskip to skip current video.' });
        } catch (e) {
            console.error('theater bot handshake failed:', e.message);
        }
    });

    socket.on('chat:message', async (msg = {}) => {
        const text = String(msg.text || '').trim().toLowerCase();
        if (text !== '!tskip') return;

        const skipped = onSkip();
        try {
            if (skipped) {
                await emitAck('chat:send', { text: 'Skipping!' });
            } else {
                await emitAck('chat:send', { text: 'what..' });
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
