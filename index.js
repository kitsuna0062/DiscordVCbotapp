process.env.NODE_NO_WARNINGS = '1';
const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, StreamType, getVoiceConnection, VoiceConnectionStatus, EndBehaviorType } = require('@discordjs/voice');
const prism = require('prism-media');
const AudioMixer = require('audio-mixer'); 
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream'); 

// 🌟 Render無料プラン対策
const http = require('http');
http.createServer((req, res) => { res.writeHead(200); res.end('OK'); }).listen(process.env.PORT || 3000, () => {
    console.log(`🌍 RenderのWebチェックに合格しました。ダミーWebポートを開放中...`);
});

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

const guildPlayers = new Map();
const guildMixers = new Map(); 
const guildVolumes = new Map();
const guildActiveInputs = new Map(); 

function getOrCreateGuildResources(guildId) {
    if (!guildPlayers.has(guildId)) {
        const player = createAudioPlayer();
        player.on('error', (err) => { if (!err.message.includes('Premature close') && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error(err); });
        guildPlayers.set(guildId, player);
    }
    
    if (!guildMixers.has(guildId)) {
        const mixer = new AudioMixer.Mixer({
            channels: 2,
            bitDepth: 16,
            sampleRate: 48000,
            clearInterval: 100,      
            autoMix: true,           
            highWaterMark: 1024 * 32 
        });
        guildMixers.set(guildId, mixer);
    }
    
    if (!guildVolumes.has(guildId)) {
        guildVolumes.set(guildId, new Map());
    }
    if (!guildActiveInputs.has(guildId)) {
        guildActiveInputs.set(guildId, new Map());
    }
    
    return { player: guildPlayers.get(guildId), mixer: guildMixers.get(guildId) };
}

const silenceBytes = Math.floor((48000 * 2 * 2 * 400) / 1000);
const SILENCE_BUFFER = Buffer.alloc(silenceBytes);

const createClient = () => new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const clientMain = createClient();
const subClients = [];

function setupVoiceReceiver(connection, sourceName, guildId, sourceIndex) {
    const receiver = connection.receiver;
    const activeStreams = new Map(); 

    connection.on(VoiceConnectionStatus.Ready, () => { console.log(`📡 [ギルド: ${guildId} / Bot: ${sourceName}] 受信準備完了。`); });

    receiver.speaking.on('start', (userId) => {
        if (activeStreams.has(userId)) return; 
        
        console.log(`🎵 [ギルド: ${guildId} / Bot: ${sourceName}] 音声検知・中継開始: ID ${userId}`);
        
        const opusStream = receiver.subscribe(userId, { 
            end: { behavior: EndBehaviorType.Manual } 
        });
        const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });

        const volMap = guildVolumes.get(guildId);
        const currentVol = volMap?.get(String(sourceIndex)) ?? 1.0;

        const { mixer } = getOrCreateGuildResources(guildId);
        const mixerInput = mixer.input({
            channels: 2,
            bitDepth: 16,
            sampleRate: 48000,
            volume: currentVol * 100,
            highWaterMark: 1024 * 16
        });

        const inputsMap = guildActiveInputs.get(guildId);
        const compositeKey = `${sourceIndex}_${userId}`;
        if (inputsMap) inputsMap.set(compositeKey, mixerInput);

        const passThrough = new PassThrough({ highWaterMark: 1024 * 16 });

        opusStream.on('error', () => {}); 
        decoder.on('error', () => {});
        passThrough.on('error', () => {});

        opusStream.pipe(decoder).pipe(passThrough);
        
        passThrough.on('data', (chunk) => {
            try { 
                mixerInput.write(chunk); 
            } catch(e) {}
        });

        activeStreams.set(userId, { opusStream, decoder, passThrough, mixerInput, compositeKey });
    });

    receiver.speaking.on('end', (userId) => {
        const streamData = activeStreams.get(userId);
        if (!streamData) return;

        const { opusStream, decoder, passThrough, mixerInput, compositeKey } = streamData;
        const { mixer } = getOrCreateGuildResources(guildId);

        try { mixerInput.write(SILENCE_BUFFER); } catch(e){}

        setTimeout(() => {
            try { 
                passThrough.destroy();
                mixer.removeInput(mixerInput);
                decoder.destroy(); 
                opusStream.destroy(); 
            } catch(e){}
            
            const inputsMap = guildActiveInputs.get(guildId);
            if (inputsMap) inputsMap.delete(compositeKey);
            activeStreams.delete(userId);
            
            console.log(`🧹 [ギルド: ${guildId} / Bot: ${sourceName}] 話し終わりを正確に検知・ストリーム完全解放。`);
        }, 80);
    });
}
async function findVoiceChannelForce(guild, target) {
    const channels = await guild.channels.fetch().catch(() => null);
    if (!channels) return null;
    return channels.find(c => c && (c.id === target || c.name === target) && (c.type === ChannelType.GuildVoice || c.isVoiceBased()));
}

// 💡 20msあたりのPCMバイト数
const FRAME_SIZE = 48000 * 2 * 2 * 0.02; 
// 💡 20ms分の無音バイナリデータ
const SILENCE_FRAME = Buffer.alloc(FRAME_SIZE);

function connectToVCs(guildId, mainChannel, sourceChannels) {
    try { getVoiceConnection(guildId, 'botMain')?.destroy(); } catch(e){}
    sourceChannels.forEach((_, index) => { try { getVoiceConnection(guildId, `botSub_${index}`)?.destroy(); } catch(e){} });

    const { player, mixer } = getOrCreateGuildResources(guildId);

    sourceChannels.forEach((channel, index) => {
        const clientSub = subClients[index];
        if (!clientSub) return;
        const connSub = joinVoiceChannel({ channelId: channel.id, guildId, adapterCreator: clientSub.guilds.cache.get(guildId).voiceAdapterCreator, selfMute: false, selfDeaf: false, group: `botSub_${index}` });
        setupVoiceReceiver(connSub, `Sub_${index + 1}`, guildId, index + 1);
    });

    const connMain = joinVoiceChannel({ channelId: mainChannel.id, guildId, adapterCreator: clientMain.guilds.cache.get(guildId).voiceAdapterCreator, group: 'botMain' });
    
    connMain.on(VoiceConnectionStatus.Ready, () => {
        console.log(`🔊 [ギルド: ${guildId}] 大域ライン開通（無音パディング制御開始）。`);
        
        // 🌟 20msごとにDiscordへ確実にデータを引き渡す無限ストリーム
        const infiniteStream = new PassThrough({ highWaterMark: FRAME_SIZE * 4 });

        const intervalId = setInterval(() => {
            let chunk = mixer.read(FRAME_SIZE);
            
            if (!chunk || chunk.length < FRAME_SIZE) {
                infiniteStream.write(SILENCE_FRAME);
            } else {
                infiniteStream.write(chunk);
            }
        }, 20);

        connMain.on(VoiceConnectionStatus.Destroyed, () => {
            clearInterval(intervalId);
            infiniteStream.destroy();
            console.log(`🛑 [ギルド: ${guildId}] 大域ライン閉鎖。タイマーを解放しました。`);
        });

        const resource = createAudioResource(infiniteStream, { 
            inputType: StreamType.Raw, 
            inlineVolume: false,
            silencePaddingChannels: 0 
        });

        connMain.subscribe(player); 
        player.play(resource);
    });
};

clientMain.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    const currentGuildId = message.guildId;
    const guild = clientMain.guilds.cache.get(currentGuildId);
    if (!guild) return;

    // 🎵 音量変更コマンド (!vol)
    if (message.content.startsWith('!vol')) {
        const args = message.content.split(' ');
        if (args.length < 3) return message.reply('❌ 使用法: !vol [元VC番号(1, 2, ...)] [倍率(0.0〜3.0)]');
        const targetIndex = args[1].trim();
        const value = parseFloat(args[2]);
        if (isNaN(parseInt(targetIndex)) || parseInt(targetIndex) < 1) return message.reply('❌ 番号は1以上の数値にしてください。');
        if (isNaN(value) || value < 0 || value > 3.0) return message.reply('❌ 倍率は 0.0 〜 3.0 にしてください。');

        if (!guildVolumes.has(currentGuildId)) guildVolumes.set(currentGuildId, new Map());
        guildVolumes.get(currentGuildId).set(String(targetIndex), value);

        const inputsMap = guildActiveInputs.get(currentGuildId);
        if (inputsMap) {
            for (const [key, mixerInput] of inputsMap.entries()) {
                if (key.startsWith(`${targetIndex}_`)) {
                    mixerInput.setVolume(value * 100);
                }
            }
        }

        try {
            let configData = {};
            if (fs.existsSync(CONFIG_FILE)) configData = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
            if (!configData[currentGuildId]) configData[currentGuildId] = {};
            if (!configData[currentGuildId].volumes) configData[currentGuildId].volumes = {};
            configData[currentGuildId].volumes[targetIndex] = value;
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(configData, null, 2));
        } catch (e) { console.error(e); }
        return message.reply(`🔊 元VC ${targetIndex} の音量を ${value}倍 に変更しました。(即時適用されました)`);
    }

    if (!message.content.startsWith('!setvc') && message.content !== '!connect' && message.content !== '!vcleave') return;

    // 🚪 退出コマンド (!vcleave)
    if (message.content === '!vcleave') {
        try {
            let disconnected = false;
            const connMain = getVoiceConnection(currentGuildId, 'botMain');
            if (connMain) { connMain.destroy(); disconnected = true; }
            for (let i = 0; i < TOKENS.subs.length; i++) {
                const connSub = getVoiceConnection(currentGuildId, `botSub_${i}`);
                if (connSub) { connSub.destroy(); disconnected = true; }
            }
            if (guildPlayers.has(currentGuildId)) guildPlayers.delete(currentGuildId);
            
            if (guildMixers.has(currentGuildId)) {
                guildMixers.get(currentGuildId).destroy();
                guildMixers.delete(currentGuildId);
            }
            if (guildActiveInputs.has(currentGuildId)) guildActiveInputs.delete(currentGuildId);

            message.reply(disconnected ? '👋 ボットがこのサーバーのVCから退出しました。' : '❓ 参加していません。');
        } catch (e) { console.error(e); message.reply('❌ 退出エラー'); }
        return;
    }

    // 接続・中継開始コマンド (!setvc)
    if (message.content.startsWith('!setvc')) {
        const args = message.content.split(' ');
        if (args.length < 3) return message.reply('❌ 使用法: !setvc [大域VC] [元VC1] [元VC2]... (最小1個〜無限拡張対応)');
        
        const targetMainName = args[1];
        const targetSourceNames = args.slice(2);

        if (targetSourceNames.length > TOKENS.subs.length) return message.reply(`❌ 用意されているBotの数（最大${TOKENS.subs.length}台）を超えています。`);
        message.channel.sendTyping();

        const channelMain = await findVoiceChannelForce(guild, targetMainName);
        const sourceChannels = [];
        for (const name of targetSourceNames) { 
            const ch = await findVoiceChannelForce(guild, name); 
            if (ch) sourceChannels.push(ch); 
        }
        
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

            if (!guildVolumes.has(currentGuildId)) guildVolumes.set(currentGuildId, new Map());
            const volMap = guildVolumes.get(currentGuildId);

            // 🌟 修正ポイント: どのBotがどのVCに入ったかをメンション形式で一覧化
            let vcDetailMsg = `\n\n📌 **【接続チャンネル詳細】**\n・📢 大域Bot (Main) ➔ <#${channelMain.id}>`;
            sourceChannels.forEach((ch, idx) => {
                const v = volMap.get(String(idx + 1)) ?? 1.0;
                vcDetailMsg += `\n・🎧 聴く係Bot ${idx + 1} ➔ <#${ch.id}> (音量: **${v}倍**)`;
            });

            message.reply(`✅ 独立中継を開始しました！${vcDetailMsg}`);
        } catch (error) { console.error(error); message.reply('❌ 接続エラーが発生しました。'); }
    }

    // ♻️ 履歴から再接続コマンド (!connect)
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

            if (!guildVolumes.has(currentGuildId)) guildVolumes.set(currentGuildId, new Map());
            const volMap = guildVolumes.get(currentGuildId);

            if (guildConfig.volumes) { 
                Object.keys(guildConfig.volumes).forEach(idx => { 
                    volMap.set(String(idx), guildConfig.volumes[idx]); 
                }); 
            }

            connectToVCs(currentGuildId, channelMain, sourceChannels);

            // 🌟 修正ポイント: 再接続時も同様にメンション形式で一覧化
            let vcDetailMsg = `\n\n📌 **【接続チャンネル詳細】**\n・📢 大域Bot (Main) ➔ <#${channelMain.id}>`;
            sourceChannels.forEach((ch, idx) => {
                const v = volMap.get(String(idx + 1)) ?? 1.0;
                vcDetailMsg += `\n・🎧 聴く係Bot ${idx + 1} ➔ <#${ch.id}> (音量: **${v}倍**)`;
            });

            message.reply(`♻️ 前回の設定で中継を再開しました！${vcDetailMsg}`);
        } catch (error) { console.error(error); message.reply('❌ 再接続エラー'); }
    }
});



// 🌟 修正ポイント①: 'clientReady' から正式な 'ready' イベントへ修正
clientMain.once('ready', () => { console.log(`🚀 司令塔Botが正常に起動しました！`); });
process.on('uncaughtException', (err) => { if (!err.message.includes('Premature close') && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error(' [システム警告]:', err); });

(async () => {
    try {
        if (!TOKENS.botMain || TOKENS.subs.length === 0) { console.error('❌ 環境変数が空です。'); return; }

        // 🌟 修正ポイント②: テザリング環境でのタイムアウトを防ぐためIPv4を優先
        const dns = require('dns');
        if (dns.setDefaultResultOrder) {
            dns.setDefaultResultOrder('ipv4first');
        }

        console.log('🔗 司令塔Bot (Main) に接続中...');
        await clientMain.login(TOKENS.botMain);
        console.log('✅ 司令塔Bot (Main) オンライン。5秒後にサブBotの順次起動を開始します...');

        for (let i = 0; i < TOKENS.subs.length; i++) {
            // 🌟 修正ポイント③: 連続ログインによるブロックを防ぐため間隔を5秒に延長
            await new Promise(r => setTimeout(r, 5000));
            console.log(`🔗 聴く係Bot (${i + 1}/${TOKENS.subs.length}) に接続中...`);
            const subClient = createClient();
            
            subClient.on('error', (err) => console.error(`[Sub_${i + 1} エラー]:`, err));
            subClient.once('ready', () => { console.log(`✅ 聴く係Bot_${i + 1} オンライン。`); });
            
            await subClient.login(TOKENS.subs[i]);
            subClients.push(subClient);
        }
        console.log(`🚀 すべてのBot（合計 ${subClients.length + 1} 台）が正常に起動しました！`);
    } catch (err) { console.error('❌ ログイン接続エラー:', err); }
})();
