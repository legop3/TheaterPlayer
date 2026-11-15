const fs = require('fs');
const yaml = require('js-yaml');

function loadConfig() {
    const configContents = fs.readFileSync('config.yml', 'utf-8');
    const config = yaml.load(configContents);
    config.streams = yaml.load(fs.readFileSync('streams.yml', 'utf-8')) || {};
    return config;
}

module.exports = { loadConfig };
