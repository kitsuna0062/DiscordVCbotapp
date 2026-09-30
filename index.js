process.env.NODE_NO_WARNINGS = '1';
const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, StreamType, getVoiceConnection, VoiceConnectionStatus } = require('@discordjs/voice');
const { Transform, Readable } = require('stream');
const prism = require('prism-media');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');

const TOKENS = {
    botMain: process.env.DISCORD_TOKEN_MAIN,
    subs: [
        process.env.DISCORD_TOKEN_A,
        process.env.DISCORD_TOKEN_B,
        process.env.DISCORD_TOKEN_C,
        process.env.DISCORD_TOKEN_D,
        process.env.DISCORD_TOKEN_E
    ].filter(t => t && t !== '') 
};

const CONFIG_FILE = path.join(__dirname, 'config.json');

class GuildAudioMixer extends Readable {
    constructor(guildId) {
        super();
        this.guildId = guildId;
        this.buffers = new Map();
        this.volumes = new Map();
        this.frameSize = 3840;
        this.timer = setInterval(() => this.generateFrame(), 20);
    }
    setVolume(sourceIndex, value) { this.volumes.set(String(sourceIndex), value); }
    getVolume(sourceIndex) {
        const idx = String(sourceIndex);
        if (!this.volumes.has(idx)) this.volumes.set(idx, 1.0);
        return this.volumes.get(idx);
    }
    pushChunk(sourceIndex, chunk) {
        const idx = String(sourceIndex);
        if (!this.buffers.has(idx)) this.buffers.set(idx, Buffer.alloc(0));
        let buf = Buffer.concat([this.buffers.get(idx), chunk]);
        if (buf.length > this.frameSize * 2) buf = buf.subarray(buf.length - this.frameSize);
        this.buffers.set(idx, buf);
    }
    generateFrame() {
        let hasData = false;
        for (const [_, buf] of this.buffers) { if (buf.length > 0) { hasData = true; break; } }
        if (!hasData) { this.push(Buffer.alloc(this.frameSize)); return; }
        const mixed = Buffer.alloc(this.frameSize);
        for (let i = 0; i < this.frameSize; i += 2) {
            let mixedSample = 0;
            for (const [idx, buf] of this.buffers) {
                let sample = i < buf.length ? buf.readInt16LE(i) : 0;
                sample = Math.floor(sample * this.getVolume(idx));
                mixedSample += sample;
            }
            if (mixedSample > 32767) mixedSample = 32767;
            if (mixedSample < -32768) mixedSample = -32768;
            mixed.writeInt16LE(mixedSample, i);
        }
        this.push(mixed);
        for (const [idx, buf] of this.buffers) { this.buffers.set(idx, buf.subarray(this.frameSize)); }
    }
    destroy() { clearInterval(this.timer); this.buffers.clear(); this.volumes.clear(); }
    _read() {}
}

const guildMixers = new Map();
const guildPlayers = new Map();
const createClient = () => new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const clientMain = createClient();
const subClients = [];

function getOrCreateGuildResources(guildId) {
    if (!guildMixers.has(guildId)) guildMixers.set(guildId, new GuildAudioMixer(guildId));
    if (!guildPlayers.has(guildId)) {
        const player = createAudioPlayer();
        player.on('error', (err) => { if (!err.message.includes('Premature close') && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error(err); });
        guildPlayers.set(guildId, player);
    }
    return { mixer: guildMixers.get(guildId), player: guildPlayers.get(guildId) };
}

function setupVoiceReceiver(connection, sourceName, guildId, sourceIndex) {
    const receiver = connection.receiver;
    const activeStreams = new Map();
    const silenceBytes = Math.floor((48000 * 2 * 2 * 400) / 1000);
    const flushSilenceBuffer = Buffer.alloc(silenceBytes);

    connection.on(VoiceConnectionStatus.Ready, () => { console.log(`📡 [ギルド: ${guildId} / Bot: ${sourceName}] 受信準備完了。`); });

    receiver.speaking.on('start', (userId) => {
        if (activeStreams.has(userId)) return;
        console.log(`🎵 [ギルド: ${guildId} / Bot: ${sourceName}] 音声検知: ID ${userId}`);
        const opusStream = receiver.subscribe(userId, { end: { behavior: 'afterSilence', duration: 0 } });
        const ffmpegProcess = spawn(ffmpegPath, ['-fflags', 'nobuffer', '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
        const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });

        activeStreams.set(userId, { opusStream, ffmpegProcess });
        opusStream.on('error', () => {}); decoder.on('error', () => {});
        opusStream.pipe(decoder).pipe(ffmpegProcess.stdin).on('error', () => {});

        ffmpegProcess.stdout.on('data', (chunk) => {
            const m = guildMixers.get(guildId);
            if (m) m.pushChunk(sourceIndex, chunk);
        });
        ffmpegProcess.on('error', () => {}); ffmpegProcess.stdin.on('error', () => {}); ffmpegProcess.stdout.on('error', () => {});

        const cleanup = () => {
            if (activeStreams.has(userId)) {
                try { ffmpegProcess.kill(); decoder.destroy(); opusStream.destroy(); } catch(e){}
                activeStreams.delete(userId);
                const m = guildMixers.get(guildId);
                if (m) m.pushChunk(sourceIndex, flushSilenceBuffer);
                console.log(`🧹 [ギルド: ${guildId}] ストリームリセット完了。`);
            }
        };
        opusStream.on('end', cleanup);
    });
}
async function findVoiceChannelForce(guild, target) {
    const channels = await guild.channels.fetch().catch(() => null);
    if (!channels) return null;
    return channels.find(c => c && (c.id === target || c.name === target) && (c.type === ChannelType.GuildVoice || c.isVoiceBased()));
}

function connectToVCs(guildId, mainChannel, sourceChannels) {
    try { getVoiceConnection(guildId, 'botMain')?.destroy(); } catch(e){}
    sourceChannels.forEach((_, index) => { try { getVoiceConnection(guildId, `botSub_${index}`)?.destroy(); } catch(e){} });

    const { mixer, player } = getOrCreateGuildResources(guildId);

    sourceChannels.forEach((channel, index) => {
        const clientSub = subClients[index];
        if (!clientSub) return;
        const connSub = joinVoiceChannel({ channelId: channel.id, guildId, adapterCreator: clientSub.guilds.cache.get(guildId).voiceAdapterCreator, selfMute: false, selfDeaf: false, group: `botSub_${index}` });
        setupVoiceReceiver(connSub, `Sub_${index + 1}`, guildId, index + 1);
    });

    const connMain = joinVoiceChannel({ channelId: mainChannel.id, guildId, adapterCreator: clientMain.guilds.cache.get(guildId).voiceAdapterCreator, group: 'botMain' });
    connMain.on(VoiceConnectionStatus.Ready, () => {
        console.log(`🔊 [ギルド: ${guildId}] 大域ライン開通。`);
        const resource = createAudioResource(mixer, { inputType: StreamType.Raw, inlineVolume: true });
        connMain.subscribe(player); player.play(resource);
    });
}

clientMain.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    const currentGuildId = message.guildId;
    const guild = clientMain.guilds.cache.get(currentGuildId);
    if (!guild) return;

    if (message.content.startsWith('!vol')) {
        const args = message.content.split(' ');
        if (args.length < 3) return message.reply('❌ 使用法: !vol [元VC番号(1, 2, ...)] [倍率(0.0〜3.0)]');
        const targetIndex = args[1].trim();
        const value = parseFloat(args[2]);
        if (isNaN(parseInt(targetIndex)) || parseInt(targetIndex) < 1) return message.reply('❌ 番号は1以上の数値にしてください。');
        if (isNaN(value) || value < 0 || value > 3.0) return message.reply('❌ 倍率は 0.0 〜 3.0 にしてください。');

        const { mixer } = getOrCreateGuildResources(currentGuildId);
        mixer.setVolume(targetIndex, value);

        try {
            let configData = {};
            if (fs.existsSync(CONFIG_FILE)) configData = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
            if (!configData[currentGuildId]) configData[currentGuildId] = {};
            if (!configData[currentGuildId].volumes) configData[currentGuildId].volumes = {};
            configData[currentGuildId].volumes[targetIndex] = value;
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(configData, null, 2));
        } catch (e) { console.error(e); }
        return message.reply(`🔊 元VC ${targetIndex} の音量を ${value}倍 に変更しました。`);
    }

    if (!message.content.startsWith('!setvc') && message.content !== '!connect' && message.content !== '!vcleave') return;

    if (message.content === '!vcleave') {
        try {
            let disconnected = false;
            const connMain = getVoiceConnection(currentGuildId, 'botMain');
            if (connMain) { connMain.destroy(); disconnected = true; }
            for (let i = 0; i < TOKENS.subs.length; i++) {
                const connSub = getVoiceConnection(currentGuildId, `botSub_${i}`);
                if (connSub) { connSub.destroy(); disconnected = true; }
            }
            if (guildMixers.has(currentGuildId)) { guildMixers.get(currentGuildId).destroy(); guildMixers.delete(currentGuildId); }
            if (guildPlayers.has(currentGuildId)) guildPlayers.delete(currentGuildId);
            message.reply(disconnected ? '👋 ボットがこのサーバーのVCから退出しました。' : '❓ 参加していません。');
        } catch (e) { console.error(e); message.reply('❌ 退出エラー'); }
        return;
    }

    if (message.content.startsWith('!setvc')) {
        const args = message.content.split(' ');
        if (args.length < 3) return message.reply('❌ 使用法: !setvc [大域VC] [元VC1] [元VC2]... (最小1個〜無限拡張対応)');
        const targetMainName = args[1];
        const targetSourceNames = args.slice(2);

        if (targetSourceNames.length > TOKENS.subs.length) return message.reply(`❌ 用意されているBotの数（最大${TOKENS.subs.length}台）を超えています。`);
        message.channel.sendTyping();

        const channelMain = await findVoiceChannelForce(guild, targetMainName);
        const sourceChannels = [];
        for (const name of targetSourceNames) { const ch = await findVoiceChannelForce(guild, name); if (ch) sourceChannels.push(ch); }
        if (!channelMain || sourceChannels.length === 0) return message.reply('❌ ボイスチャンネルが見つかりません。');

        try {
            connectToVCs(currentGuildId, channelMain, sourceChannels);
            let configData = {};
            if (fs.existsSync(CONFIG_FILE)) { try { configData = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch(e){} }
            configData[currentGuildId] = {
                mainId: channelMain.id,
                sourceIds: sourceChannels.map(c => c.id),
                volumes: configData[currentGuildId]?.volumes || {}
            };
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(configData, null, 2));

            const { mixer } = getOrCreateGuildResources(currentGuildId);
            let volMsg = '\n🎵 【現在の音量設定】';
            sourceChannels.forEach((_, idx) => { volMsg += `\n・元VC ${idx + 1}: **${mixer.getVolume(idx + 1)}倍**`; });
            message.reply(`✅ 独立中継を開始しました！\n• 大域Bot ➔ <#${channelMain.id}>\n• 聴くBot ➔ ${sourceChannels.length}チャンネルに展開。${volMsg}`);
        } catch (error) { console.error(error); message.reply('❌ 接続エラーが発生しました。'); }
    }

    if (message.content === '!connect') {
        if (!fs.existsSync(CONFIG_FILE)) return message.reply('❌ 履歴なし');
        try {
            const configData = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
            const guildConfig = configData[currentGuildId];
            if (!guildConfig) return message.reply('❌ このサーバーの履歴がありません。');

            await guild.channels.fetch().catch(() => null);
            const channelMain = guild.channels.cache.get(guildConfig.mainId);
            const sourceChannels = [];
            for (const id of guildConfig.sourceIds) { const ch = guild.channels.cache.get(id); if (ch) sourceChannels.push(ch); }
            if (!channelMain || sourceChannels.length === 0) return message.reply('❌ チャンネルが見つかりません。');

            const { mixer } = getOrCreateGuildResources(currentGuildId);
            if (guildConfig.volumes) { Object.keys(guildConfig.volumes).forEach(idx => { mixer.setVolume(idx, guildConfig.volumes[idx]); }); }

            connectToVCs(currentGuildId, channelMain, sourceChannels);
            let volMsg = '\n🎵 【引き継いだ音量設定】';
            sourceChannels.forEach((_, idx) => { volMsg += `\n・元VC ${idx + 1}: **${mixer.getVolume(idx + 1)}倍**`; });
            message.reply(`♻️ 前回の設定で中継を再開しました！\n• 大域Bot ➔ <#${channelMain.id}>${volMsg}`);
        } catch (error) { console.error(error); message.reply('❌ 再接続エラー'); }
    }
});

clientMain.once('clientReady', () => { console.log(`🚀 司令塔Botが正常に起動しました！`); });
process.on('uncaughtException', (err) => { if (!err.message.includes('Premature close') && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error(' [システム警告]:', err); });

(async () => {
    try {
        if (!TOKENS.botMain || TOKENS.subs.length === 0) { console.error('❌ 環境変数が空です。'); return; }
        console.log('🔗 司令塔Bot (Main) に接続中...');
        await clientMain.login(TOKENS.botMain);

        for (let i = 0; i < TOKENS.subs.length; i++) {
            await new Promise(r => setTimeout(r, 1200));
            console.log(`🔗 聴く係Bot (${i + 1}/${TOKENS.subs.length}) に接続中...`);
            const subClient = createClient();
            subClient.once('ready', () => { console.log(`✅ 聴く係Bot_${i + 1} オンライン。`); });
            await subClient.login(TOKENS.subs[i]);
            subClients.push(subClient);
        }
        console.log(`🚀 すべてのBot（合計 ${subClients.length + 1} 台）が正常に起動しました！`);
    } catch (err) { console.error('❌ ログイン接続エラー:', err); }
})();
