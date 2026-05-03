const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const yaml = require('js-yaml');
const SambaClient = require('samba-client');

const TEMP_DIR = path.join(os.tmpdir(), 'theaterplayer');
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.avi', '.webm', '.m4v']);

function loadConfig() {
    console.log('loading config...');
    const configContents = fs.readFileSync('config.yml', 'utf-8');
    const config = yaml.load(configContents);
    console.log('config loaded!');
    return config;
}

function isVideoFile(file) {
    if (file.type !== 'N') return false;
    return VIDEO_EXTENSIONS.has(path.extname(file.name).toLowerCase());
}

function chooseRandom(items) {
    return items[Math.floor(Math.random() * items.length)];
}

function playWithMpv(filePath, displayConfig) {
    const args = [];
    if (displayConfig && displayConfig.fullscreen) args.push('--fs');
    if (displayConfig && Number.isInteger(displayConfig.screen)) args.push(`--screen=${displayConfig.screen}`);
    args.push(filePath);

    return new Promise((resolve, reject) => {
        const proc = spawn('mpv', args, { stdio: 'inherit' });
        proc.on('error', reject);
        proc.on('close', () => resolve());
    });
}

async function main() {
    const config = loadConfig();
    fs.mkdirSync(TEMP_DIR, { recursive: true });

    const client = new SambaClient({
        address: config.smb.address,
        directory: config.smb.directory
    });

    while (true) {
        const remoteFiles = await client.list('*');
        const videos = remoteFiles.filter(isVideoFile);

        if (videos.length === 0) {
            console.log('no videos found, retrying in 5s');
            await new Promise((r) => setTimeout(r, 5000));
            continue;
        }

        const picked = chooseRandom(videos);
        const localPath = path.join(TEMP_DIR, picked.name);

        console.log(`playing: ${picked.name}`);
        await client.getFile(picked.name, localPath);
        await playWithMpv(localPath, config.display);

        try {
            fs.unlinkSync(localPath);
        } catch (_) {}
    }
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
