const { loadConfig } = require('./services/config');
const { MediaLibrary } = require('./services/mediaLibrary');
const { MediaCache } = require('./services/cache');
const { PlayerController } = require('./services/playerController');
const { createTerminalUi } = require('./services/terminalUi');
const { startTheaterBot } = require('./theaterBot');

async function main() {
    const config = loadConfig();
    const library = new MediaLibrary(config.smb);
    const cache = new MediaCache(config.storage, library);
    let controller;
    let bot;
    let closing;
    const shutdown = () => {
        if (!closing) {
            bot?.close();
            closing = controller.close();
        }
        return closing;
    };
    const ui = createTerminalUi(shutdown);
    controller = new PlayerController(config, library, cache, (state) => ui.render(state), (text) => bot?.send(text));
    bot = startTheaterBot(config.bot?.serverUrl, {
        profileImage: config.bot?.profileImage,
        onRequest: (query, options) => controller.request(query, options),
        onSkip: () => controller.skip(),
        onServerMode: (mode) => controller.setServerMode(mode),
        onNow: () => controller.now(),
        onInfo: () => controller.info(),
        onStreams: () => controller.listStreams()
    });
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    try {
        await controller.run();
    } finally {
        await shutdown();
        ui.close();
        process.removeListener('SIGINT', shutdown);
        process.removeListener('SIGTERM', shutdown);
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
