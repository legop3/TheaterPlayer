const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function createBot(prefix) {
    const events = {};
    const messages = [];
    const requests = [];
    const socket = {
        connected: true,
        on: (event, callback) => { events[event] = callback; },
        timeout() { return this; },
        emit(event, payload, callback) {
            if (event === 'chat:send') messages.push(payload.text);
            callback(null, {});
        },
        disconnect() {}
    };
    const context = { require: () => ({ io: () => socket }), module: { exports: {} }, console };
    vm.runInNewContext(fs.readFileSync(require.resolve('../theaterBot'), 'utf8'), context);
    context.module.exports.startTheaterBot('http://example.test', {
        commandPrefix: prefix,
        onRequest: (query, options) => requests.push({ query, ...options }),
        onSkip: () => { requests.push('skip'); return true; }
    });
    return { events, messages, requests };
}

for (const prefix of ['!', '!screen2', '[a].']) {
    test(`commands, aliases, and help use literal prefix ${prefix}`, async () => {
        const bot = createBot(prefix);
        await bot.events.connect();
        for (const text of ['tsk', '?skip', `${prefix}extraSkip`]) bot.events['chat:message']({ text });
        if (prefix !== '!') bot.events['chat:message']({ text: '!skip' });
        assert.equal(bot.requests.length, 0);
        bot.events['chat:message']({ text: `${prefix}TsK` });
        bot.events['chat:message']({ text: `${prefix}q a movie` });
        bot.events['chat:message']({ text: `${prefix}yt music` });
        bot.events['chat:message']({ text: `${prefix}play`, bot: true });
        bot.events['chat:message']({ text: `${prefix}play` });
        bot.events['chat:message']({ text: `${prefix}help` });
        await new Promise(setImmediate);
        assert.equal(bot.requests.length, 3);
        assert.equal(bot.requests[0], 'skip');
        assert.equal(bot.requests[1].next, true);
        assert.equal(bot.requests[2].youtube, true);
        const output = bot.messages.join('\n');
        assert.ok(output.includes(`Usage: ${prefix}play`));
        assert.ok(output.includes(`${prefix}help: Show commands.`));
        assert.ok(output.includes(`${prefix}streams: List streams.`));
    });
}

test('default prefix is ! and invalid prefixes fail', async () => {
    const bot = createBot();
    await bot.events.connect();
    bot.events['chat:message']({ text: '!s' });
    assert.equal(bot.requests[0], 'skip');
    for (const prefix of ['', 'a b', 42]) assert.throws(() => createBot(prefix), /commandPrefix/);
});

test('configuration loads the tracked stream list separately', () => {
    const yaml = require('js-yaml');
    const config = require('../services/config').loadConfig();
    assert.deepEqual(config.streams, yaml.load(fs.readFileSync('streams.yml', 'utf8')));
    assert.ok(Object.keys(config.streams).length > 0);
    assert.equal(yaml.load(fs.readFileSync('config.example.yml', 'utf8')).streams, undefined);
});
