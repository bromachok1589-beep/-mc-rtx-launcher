const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { Client, Authenticator } = require('minecraft-launcher-core');
const { spawn, execSync } = require('child_process');

const MINECRAFT_PATH = 'C:\\mc_rtx_launcher\\.minecraft';
const MODS_PATH = path.join(MINECRAFT_PATH, 'mods');
const SETTINGS_FILE = path.join(MINECRAFT_PATH, 'pulse_visuals_config.json');

function toShortPath(fullPath) {
    try {
        const folder = path.dirname(fullPath);
        const fileName = path.basename(fullPath);
        const output = execSync(`dir /x "${folder}"`).toString();
        const lines = output.split('\n');
        for (let line of lines) {
            if (line.includes(fileName)) {
                const match = line.match(/\s+([^ ]+)\s+/);
                if (match && match[1]) {
                    return path.join(folder, match[1]);
                }
            }
        }
    } catch (e) {
        console.log('Error getting short path: ' + e.message);
    }
    return fullPath;
}

async function downloadFile(url, dest) {
    try {
        const writer = fs.createWriteStream(dest);
        const response = await axios({ url, method: 'GET', responseType: 'stream' });
        response.data.pipe(writer);
        return new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
    } catch (e) {
        console.log('Download error: ' + e.message);
        throw e;
    }
}

function findJava8() {
    const embeddedJava = path.join(path.dirname(process.execPath), 'runtime', 'jre8', 'bin', 'java.exe');
    if (fs.existsSync(embeddedJava)) return embeddedJava;

    const javaDir = 'C:\\Program Files\\Java';
    const javaDirX86 = 'C:\\Program Files (x86)\\Java';
    try {
        if (fs.existsSync(javaDir)) {
            const folders = fs.readdirSync(javaDir);
            const jre8 = folders.find(f => f.startsWith('jre1.8') || f.startsWith('jdk1.8'));
            if (jre8) return path.join(javaDir, jre8, 'bin', 'java.exe');
        }
        if (fs.existsSync(javaDirX86)) {
            const folders = fs.readdirSync(javaDirX86);
            const jre8 = folders.find(f => f.startsWith('jre1.8') || f.startsWith('jdk1.8'));
            if (jre8) return path.join(javaDirX86, jre8, 'bin', 'java.exe');
        }
    } catch (e) {}
    return 'java';
}

async function installForge(version, event) {
    const forgeInstallerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${version}/forge-${version}-installer.jar`;
    const installerPath = path.join(app.getPath('temp'), 'forge-installer.jar');

    event.reply('launch-log', `Подготовка к установке Forge (${version})...`);
    try {
        event.reply('launch-log', 'Скачивание Forge installer...');
        await downloadFile(forgeInstallerUrl, installerPath);
        event.reply('launch-log', 'Forge installer скачан. Запуск установки...');

        return new Promise((resolve) => {
            const javaExe = findJava8();
            const child = spawn(javaExe, ['-jar', installerPath, '--installClient'], {
                cwd: MINECRAFT_PATH,
                env: { ...process.env, JAVA_HOME: path.dirname(path.dirname(javaExe)) },
                shell: false
            });

            child.on('close', (code) => {
                event.reply('launch-log', `Forge installer завершил работу с кодом ${code}.`);
                const forgeFolderName = '1.12.2-forge';
                const possibleForgeDir = path.join(MINECRAFT_PATH, 'versions', `1.12.2-forge-${version}`);
                const targetForgeDir = path.join(MINECRAFT_PATH, 'versions', forgeFolderName);
                if (fs.existsSync(possibleForgeDir)) {
                    try {
                        if (!fs.existsSync(targetForgeDir)) {
                            fs.renameSync(possibleForgeDir, targetForgeDir);
                            event.reply('launch-log', `Папка Forge переименована в ${forgeFolderName}`);
                        }
                    } catch (e) {
                        event.reply('launch-log', `Ошибка переименования: ${e.message}`);
                    }
                } else {
                    event.reply('launch-log', `Критическая ошибка: Forge не создал папку.`);
                }
                resolve();
            });
            child.on('error', (err) => {
                event.reply('launch-log', `Ошибка запуска Forge: ${err.message}`);
                resolve();
            });
        });
    } catch (e) {
        event.reply('launch-log', `Ошибка при установке Forge: ${e.message}`);
        return Promise.resolve();
    }
}

function createWindow() {
    const win = new BrowserWindow({
        width: 1200, height: 800, frame: false, resizable: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    win.loadFile('index.html');
}

ipcMain.on('launch-game', async (event, args) => {
    const { version, username, profile } = args;
    try {
        if (!fs.existsSync(MINECRAFT_PATH)) fs.mkdirSync(MINECRAFT_PATH, { recursive: true });
        if (!fs.existsSync(MODS_PATH)) fs.mkdirSync(MODS_PATH, { recursive: true });
        
        if (version === '1.12.2' && !fs.existsSync(path.join(MINECRAFT_PATH, 'versions', '1.12.2-forge', '1.12.2-forge.json')) ) {
            event.reply('launch-log', 'Подготовка ванильной версии 1.12.2 перед установкой Forge...');
            const tempClient = new Client();
            try {
                await tempClient.launch({
                    root: MINECRAFT_PATH,
                    authorization: Authenticator.getAuth(username),
                    version: { number: '1.12.2', type: 'release' },
                    javaPath: findJava8()
                });
            } catch (e) {
                console.log('Vanilla setup warning: ' + e.message);
            }
            await installForge('1.12.2-14.23.5.2859', event);
        }

        const pulseConfig = { lastUser: username, activeProfile: profile, settings: { targetHud: true, damageNumbers: true, trajectory: true, autoEat: true, menuKey: 'RIGHT_SHIFT' } };
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(pulseConfig, null, 4));

        const client = new Client();
        const javaPath = findJava8();
        const is32Bit = javaPath.includes('(x86)') || javaPath.includes('Program Files (x86)');
        const maxMemory = is32Bit ? '1G' : '2G';
        const minMemory = is32Bit ? '256M' : '512M';

        client.on('progress', (data) => {
            const percent = (data.task / data.total) * 100;
            event.reply('launch-progress', { percent, message: `[${data.type}] ${data.task}/${data.total}` });
        });
        client.on('download-status', (data) => {
            const percent = (data.current / data.total) * 100;
            event.reply('launch-progress', { percent, message: `Скачивание ${data.name}...` });
        });
        client.on('data', (data) => event.reply('launch-log', data.toString()));
        client.on('close', (code) => event.reply('launch-log', `Игра закрыта с кодом: ${code}`));

        await client.launch({
            root: MINECRAFT_PATH,
            authorization: Authenticator.getAuth(username),
            version: {
                number: version === '1.12.2' ? '1.12.2' : version,
                type: "release",
                custom: version === '1.12.2' ? '1.12.2-forge' : undefined
            },
            memory: { max: maxMemory, min: minMemory },
            javaPath: javaPath,
            customArgs: ['-Dsun.java2d.d3d=false', '-Dsun.java2d.noddraw=true', '-Djava.library.path=.']
        });
        event.reply('launch-status', 'Игра запущена!');
    } catch (e) {
        event.reply('launch-status', 'Ошибка: ' + e.message);
    }
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
