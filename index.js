process.env.NODE_NO_WARNINGS = '1';
const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, StreamType, getVoiceConnection, VoiceConnectionStatus, EndBehaviorType } = require('@discordjs/voice');
const prism = require('prism-media');
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

const guildPlayers = new Map();       // 各ギルドの各Botプレイヤーを個別に管理する二次元Map
const guildVolumes = new Map();       // 各ギルドの音量設定（100ベースの%値）
const guildActiveStreams = new Map();  // 各ギルドの稼働中ストリームを管理
const guildReverseStreams = new Map(); // 🌟 逆方向（メイン -> サブ）の中継ストリームを管理するマップ

/**
 * 🌟 バッファプレッシャーを回避するマルチプレイヤー生成関数
 */
function getOrCreateGuildResources(guildId, sourceIndex) {
    const idxStr = String(sourceIndex);

    if (!guildPlayers.has(guildId)) guildPlayers.set(guildId, new Map());
    if (!guildVolumes.has(guildId)) guildVolumes.set(guildId, new Map());
    if (!guildActiveStreams.has(guildId)) guildActiveStreams.set(guildId, new Map());

    const playersMap = guildPlayers.get(guildId);

    if (!playersMap.has(idxStr)) {
        const player = createAudioPlayer();
        player.on('error', (err) => { 
            if (!err.message.includes('Premature close') && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error(err); 
        });
        playersMap.set(idxStr, player);
    }

    return { player: playersMap.get(idxStr) };
}

const createClient = () => new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const clientMain = createClient();
const subClients = [];

/**
 * 🌟 サブBotからメインBotのプレイヤーへ音声を中継するセットアップ
 */
function setupVoiceReceiverForMain(connection, sourceName, guildId, sourceIndex, mainConnection) {
    const receiver = connection.receiver;
    const activeStreams = guildActiveStreams.get(guildId);

    connection.on(VoiceConnectionStatus.Ready, () => { 
        console.log(`📡 [ギルド: ${guildId} / Bot: ${sourceName}] 受信準備完了。`); 
    });

    receiver.speaking.on('start', (userId) => {
        const compositeKey = `${sourceIndex}_${userId}`;
        if (activeStreams.has(compositeKey)) return; 
        
        console.log(`🎵 [ギルド: ${guildId} / Bot: ${sourceName}] 音声検知・中継開始: ID ${userId}`);
        
        const opusStream = receiver.subscribe(userId, { 
            end: { behavior: EndBehaviorType.Manual } 
        });
        const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
        const passThrough = new PassThrough({ highWaterMark: 1024 * 16 });

        opusStream.on('error', () => {}); 
        decoder.on('error', () => {});
        passThrough.on('error', () => {});

        opusStream.pipe(decoder).pipe(passThrough);

        const resource = createAudioResource(passThrough, { 
            inputType: StreamType.Raw,
            inlineVolume: true 
        });

        const volMap = guildVolumes.get(guildId);
        const currentVolPercent = volMap?.get(String(sourceIndex)) ?? 100;
        resource.volume.setVolume(currentVolPercent / 100);

        const userSpecificPlayer = createAudioPlayer();
        userSpecificPlayer.on('error', () => {});
        
        mainConnection.subscribe(userSpecificPlayer);
        userSpecificPlayer.play(resource);

        activeStreams.set(compositeKey, { opusStream, decoder, passThrough, resource, player: userSpecificPlayer });
    });

    receiver.speaking.on('end', (userId) => {
        const compositeKey = `${sourceIndex}_${userId}`;
        const streamData = activeStreams.get(compositeKey);
        if (!streamData) return;

        const { opusStream, decoder, passThrough, player } = streamData;

        setTimeout(() => {
            try { 
                if (player) {
                    player.stop(true); 
                }
                decoder.unpipe(passThrough);
                opusStream.unpipe(decoder);
                passThrough.destroy();
                decoder.destroy(); 
                opusStream.destroy(); 
            } catch(e){}
            activeStreams.delete(compositeKey);
            console.log(`🧹 [ギルド: ${guildId} / Bot: ${sourceName}] ストリーム＆プレイヤーキャッシュ完全解放。`);
        }, 150);
    });
}

/**
 * 🌟 新・逆方向中継：メインBotの声を「サブBotのプレイヤー」へ流し込む
 */
function setupReverseVoiceReceiver(connMain, guildId, targetSubIndex, speakerUserId, isOnly = false) {
    if (!guildReverseStreams.has(guildId)) guildReverseStreams.set(guildId, new Map());
    const reverseMap = guildReverseStreams.get(guildId);
    
    if (reverseMap.has(targetSubIndex)) {
        stopReverseVoiceReceiver(guildId, targetSubIndex);
    }

    const receiver = connMain.receiver;

    console.log(`📡 [ギルド: ${guildId}] 大域Bot -> サブBot ${targetSubIndex} への逆方向音声中継を準備中... (${isOnly ? 'オンリーモード' : '全員ミキサーモード'})`);

    const startHandler = (userId) => {
        if (isOnly && userId !== speakerUserId) return; 
        
        const streamKey = `reverse_${targetSubIndex}_${userId}`;
        if (reverseMap.has(streamKey)) return;

        console.log(`📢 [ギルド: ${guildId}] メインVCの声を検知 ➔ サブBot ${targetSubIndex} へ流し込み中... (ユーザー: ${userId})`);

        const opusStream = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
        const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
        const passThrough = new PassThrough({ highWaterMark: 1024 * 16 });

        opusStream.on('error', () => {}); decoder.on('error', () => {}); passThrough.on('error', () => {});
        opusStream.pipe(decoder).pipe(passThrough);

        const resource = createAudioResource(passThrough, { inputType: StreamType.Raw, inlineVolume: false });
        
        const userSpecificReversePlayer = createAudioPlayer();
        userSpecificReversePlayer.on('error', () => {});

        const connSub = getVoiceConnection(guildId, `botSub_${targetSubIndex - 1}`);
        if (connSub) {
            connSub.subscribe(userSpecificReversePlayer);
            userSpecificReversePlayer.play(resource);
        }

        reverseMap.set(streamKey, { opusStream, decoder, passThrough, player: userSpecificReversePlayer });
    };

    const endHandler = (userId) => {
        if (isOnly && userId !== speakerUserId) return;
        const streamKey = `reverse_${targetSubIndex}_${userId}`;
        const streamData = reverseMap.get(streamKey);
        if (!streamData) return;

        const { opusStream, decoder, passThrough, player } = streamData;
        setTimeout(() => {
            try {
                if (player) {
                    player.stop(true); 
                }
                decoder.unpipe(passThrough); opusStream.unpipe(decoder);
                passThrough.destroy(); decoder.destroy(); opusStream.destroy();
            } catch(e){}
            reverseMap.delete(streamKey);
            console.log(`🧹 [ギルド: ${guildId}] 逆方向個別ストリーム解放。`);
        }, 150);
    };

    receiver.speaking.on('start', startHandler);
    receiver.speaking.on('end', endHandler);

    reverseMap.set(targetSubIndex, { startHandler, endHandler, isOnly, speakerUserId });
}

/**
 * 🌟 逆方向中継を完全に停止・解体する関数
 */
function stopReverseVoiceReceiver(guildId, targetSubIndex) {
    const reverseMap = guildReverseStreams.get(guildId);
    if (!reverseMap) return;

    const config = reverseMap.get(targetSubIndex);
    const connMain = getVoiceConnection(guildId, 'botMain');
    if (config && connMain) {
        connMain.receiver.speaking.off('start', config.startHandler);
        connMain.receiver.speaking.off('end', config.endHandler);
    }
    reverseMap.delete(targetSubIndex);

    for (const [key, streamData] of reverseMap.entries()) {
        if (key.startsWith(`reverse_${targetSubIndex}_`)) {
            try {
                if (streamData.player) streamData.player.stop(true);
                streamData.decoder.unpipe(streamData.passThrough);
                streamData.opusStream.unpipe(streamData.decoder);
                streamData.passThrough.destroy();
                streamData.decoder.destroy();
                streamData.opusStream.destroy();
            } catch(e){}
            reverseMap.delete(key);
        }
    }
    console.log(`🔕 [ギルド: ${guildId}] サブBot ${targetSubIndex} への逆方向中継（拡声機能）を完全オフにしました。`);
}

async function findVoiceChannelForce(guild, target) {
    const channels = await guild.channels.fetch().catch(() => null);
    if (!channels) return null;
    return channels.find(c => c && (c.id === target || c.name === target) && (c.type === ChannelType.GuildVoice || c.isVoiceBased()));
}
/**
 * 🌟 接続処理（グループ名を厳密に適用）
 */
function connectToVCs(guildId, mainChannel, sourceChannels) {
    try { getVoiceConnection(guildId, 'botMain')?.destroy(); } catch(e){}
    sourceChannels.forEach((_, index) => { try { getVoiceConnection(guildId, `botSub_${index}`)?.destroy(); } catch(e){} });

    getOrCreateGuildResources(guildId, 0);
    sourceChannels.forEach((_, index) => {
        getOrCreateGuildResources(guildId, index + 1);
    });

    const connMain = joinVoiceChannel({ 
        channelId: mainChannel.id, 
        guildId, 
        adapterCreator: clientMain.guilds.cache.get(guildId).voiceAdapterCreator, 
        selfMute: false, 
        selfDeaf: false, 
        group: 'botMain'
    });
    
    const { player: mainPlayer } = getOrCreateGuildResources(guildId, 0);
    connMain.subscribe(mainPlayer);

    connMain.on(VoiceConnectionStatus.Ready, () => {
        console.log(`🔊 [ギルド: ${guildId}] 大域ライン開通（独立プレイヤー駆動）。`);
    });

    sourceChannels.forEach(async (channel, index) => {
        const clientSub = subClients[index];
        if (!clientSub) return;
        
        const targetGuild = await clientSub.guilds.fetch(guildId).catch(() => null);
        if (!targetGuild) return;

        const connSub = joinVoiceChannel({ 
            channelId: channel.id, 
            guildId, 
            adapterCreator: targetGuild.voiceAdapterCreator, 
            selfMute: false, 
            selfDeaf: false, 
            group: `botSub_${index}`
        });
        
        const { player: subPlayer } = getOrCreateGuildResources(guildId, index + 1);
        connSub.subscribe(subPlayer);

        setupVoiceReceiverForMain(connSub, `Sub_${index + 1}`, guildId, index + 1, connMain);
    });
}

clientMain.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    const currentGuildId = message.guildId;
    const guild = clientMain.guilds.cache.get(currentGuildId);
    if (!guild) return;

    // 💡 メッセージを半角スペースで区切り、配列（args）にする
    const args = message.content.trim().split(/ +/);
    const command = args[0]; // 🌟 1番最初の単語文字列（/setvc や /vcoff など）を正しく抽出

    // 🔕 逆方向拡声オフコマンド (/vcoff)
    if (command === '/vcoff') {
        if (args.length < 2) return message.reply('❌ 使用法: /vcoff [対象のサブBot番号(1, 2, ...)]');
        
        const targetIndex = args[1]; 
        const targetIdxNum = parseInt(targetIndex, 10);
        
        if (isNaN(targetIdxNum) || targetIdxNum < 1) return message.reply('❌ 番号は1以上の数値にしてください。');

        stopReverseVoiceReceiver(currentGuildId, targetIdxNum);
        return message.reply(`🔕 聴く係Bot ${targetIdxNum} への逆方向拡声を設定解除（オフ）にしました。`);
    }

    // 🎙️ 逆方向拡声オンコマンド (/vcon または /vcononly)
    if (command === '/vcon' || command === '/vcononly') {
        if (args.length < 2) return message.reply('❌ 使用法:\n・全員中継: /vcon [サブBot番号]\n・自分のみ: /vcon [サブBot番号] only または /vcononly [サブBot番号]');
        
        const targetIndex = args[1]; 
        const targetIdxNum = parseInt(targetIndex, 10);
        
        if (isNaN(targetIdxNum) || targetIdxNum < 1) return message.reply('❌ 番号は1以上の数値にしてください。');

        const connMain = getVoiceConnection(currentGuildId, 'botMain');
        if (!connMain) return message.reply('❌ メインBotがまだVCに参加していません。');

        const isOnlyMode = (command === '/vcononly') || (args[2]?.toLowerCase() === 'only');

        setupReverseVoiceReceiver(connMain, currentGuildId, targetIdxNum, message.author.id, isOnlyMode);

        if (isOnlyMode) {
            return message.reply(`🎙️ 【オンリーモード】メインBot ➔ 聴く係Bot ${targetIdxNum} への逆方向拡声を開始。**あなたの声だけ**が指定した部屋に流れます。`);
        } else {
            return message.reply(`🎙️ 【全員ミキサーモード】メインBot ➔ 聴く係Bot ${targetIdxNum} への逆方向拡声を開始。メインVCにいる**全員の声がミックスされて**指定した部屋に流れます。`);
        }
    }
    // 🎵 音量変更コマンド (/vol)
    if (command === '/vol') {
        if (args.length < 3) return message.reply('❌ 使用法: /vol [元VC番号(1, 2, ...)] [音量%(0〜300)]');
        
        const targetIndex = args[1];
        const value = parseInt(args[2], 10);
        if (isNaN(parseInt(targetIndex)) || parseInt(targetIndex) < 1) return message.reply('❌ 番号は1以上の数値にしてください。');
        if (isNaN(value) || value < 0 || value > 300) return message.reply('❌ 音量は 0 〜 300 (%) の範囲で指定してください。');

        if (!guildVolumes.has(currentGuildId)) guildVolumes.set(currentGuildId, new Map());
        guildVolumes.get(currentGuildId).set(String(targetIndex), value);

        const activeStreams = guildActiveStreams.get(currentGuildId);
        if (activeStreams) {
            for (const [key, streamData] of activeStreams.entries()) {
                if (key.startsWith(`${targetIndex}_`)) {
                    streamData.resource.volume.setVolume(value / 100);
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
        return message.reply(`🔊 元VC ${targetIndex} の音量を ${value}% に変更しました。(中継ストリームへ即時適用されました)`);
    }

    // 🚪 退出コマンド (/vcleave)
    if (command === '/vcleave') {
        try {
            let disconnected = false;
            const connMain = getVoiceConnection(currentGuildId, 'botMain');
            if (connMain) { connMain.destroy(); disconnected = true; }
            for (let i = 0; i < TOKENS.subs.length; i++) {
                const connSub = getVoiceConnection(currentGuildId, `botSub_${i}`);
                if (connSub) { connSub.destroy(); disconnected = true; }
            }

            if (guildPlayers.has(currentGuildId)) guildPlayers.delete(currentGuildId);
            
            if (guildReverseStreams.has(currentGuildId)) {
                const reverseMap = guildReverseStreams.get(currentGuildId);
                for (const key of reverseMap.keys()) {
                    if (!isNaN(parseInt(key))) stopReverseVoiceReceiver(currentGuildId, key);
                }
                guildReverseStreams.delete(currentGuildId);
            }

            const activeStreams = guildActiveStreams.get(currentGuildId);
            if (activeStreams) {
                for (const streamData of activeStreams.values()) {
                    try {
                        if (streamData.player) {
                            streamData.player.stop(true);
                        }
                        streamData.decoder.unpipe(streamData.passThrough);
                        streamData.opusStream.unpipe(streamData.decoder);
                        streamData.passThrough.destroy();
                        streamData.decoder.destroy();
                        streamData.opusStream.destroy();
                    } catch(e){}
                }
                activeStreams.clear();
            }

            return message.reply(disconnected ? '👋 ボットがすべてのVCから退出しました。' : '❓ 参加していません。');
        } catch (e) { console.error(e); return message.reply('❌ 退出エラーが発生しました。'); }
    }

    // 接続・中継開始コマンド (/setvc)
    if (command === '/setvc') {
        if (args.length < 3) return message.reply('❌ 使用法: /setvc [大域VC] [元VC1] [元VC2]... (最小1個〜無限拡張対応)');
        
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

            let vcDetailMsg = `\n\n📌 **【接続チャンネル詳細】**\n・📢 大域Bot (Main) ➔ <#${channelMain.id}>`;
            sourceChannels.forEach((ch, idx) => {
                const v = volMap.get(String(idx + 1)) ?? 100;
                vcDetailMsg += `\n・🎧 聴く係Bot ${idx + 1} ➔ <#${ch.id}> (音量: **${v}%**)`;
            });

            return message.reply(`${vcDetailMsg}`);
        } catch (error) { console.error(error); return message.reply('❌ 接続エラーが発生しました。'); }
    }

    // ♻️ 履歴から再接続コマンド (/connect)
    if (command === '/connect') {
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

            let vcDetailMsg = `\n\n📌 **【接続チャンネル詳細】**\n・📢 大域Bot (Main) ➔ <#${channelMain.id}>`;
            sourceChannels.forEach((ch, idx) => {
                const v = volMap.get(String(idx + 1)) ?? 100;
                vcDetailMsg += `\n・🎧 聴く係Bot ${idx + 1} ➔ <#${ch.id}> (音量: **${v}%**)`;
            });

            return message.reply(`♻️ 前回の設定・音量をロードして中継を再開しました！${vcDetailMsg}`);
        } catch (error) { console.error(error); return message.reply('❌ 再接続エラー'); }
    }
});

clientMain.once('ready', () => { 
    console.log(`🚀 司令塔Botが正常に起動しました！`); 
});

process.on('uncaughtException', (err) => { 
    if (!err.message.includes('Premature close') && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        console.error(' [システム警告]:', err); 
    }
});

(async () => {
    try {
        if (!TOKENS.botMain || TOKENS.subs.length === 0) { 
            console.error('❌ 環境変数が空です。'); 
            return; 
        }

        const dns = require('dns');
        if (dns.setDefaultResultOrder) {
            dns.setDefaultResultOrder('ipv4first');
        }

        console.log('🔗 司令塔Bot (Main) に接続中...');
        await clientMain.login(TOKENS.botMain);
        console.log('✅ 司令塔Bot (Main) オンライン。5秒後にサブBotの順次起動を開始します...');

        for (let i = 0; i < TOKENS.subs.length; i++) {
            await new Promise(r => setTimeout(r, 5000));
            console.log(`🔗 聴く係Bot (${i + 1}/${TOKENS.subs.length}) に接続中...`);
            const subClient = createClient();
            
            subClient.on('error', (err) => console.error(`[Sub_${i + 1} エラー]:`, err));
            subClient.once('ready', () => { 
                console.log(`✅ 聴く係Bot_${i + 1} オンライン。`); 
            });
            
            await subClient.login(TOKENS.subs[i]);
            subClients.push(subClient);
        }
        console.log(`🚀 すべてのBot（合計 ${subClients.length + 1} 台）が正常に起動しました！同時購読中継システム稼働準備完了。`);
    } catch (err) { 
        console.error('❌ ログイン接続エラー:', err); 
    }
})();
