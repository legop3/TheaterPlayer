const fs = require('fs');
const yaml = require('js-yaml');

function loadConfig() {
    const configContents = fs.readFileSync('config.yml', 'utf-8');
    return yaml.load(configContents);
}

module.exports = { loadConfig };
