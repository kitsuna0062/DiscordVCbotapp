process.env.NODE_NO_WARNINGS = '1';
const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, StreamType, getVoiceConnection, VoiceConnectionStatus, EndBehaviorType } = require('@discordjs/voice');
const prism = require('prism-media');
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream'); 
const express = require('express');

// ==========================================
// 🌟 Render用のHTTPサーバー初期設定
// ==========================================
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => { res.send('Discord VC Relay Bot is running! 🚀'); });
app.get('/health', (req, res) => { res.status(200).send('OK'); });
app.listen(PORT, () => { console.log(`[HTTP Server] Render無料プラン用サーバーが起動しました（ポート: ${PORT}）`); });

// ==========================================
// 🌟 環境変数トークンの読み込み
// ==========================================
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
const PREFIX = '!'; // 💡 メッセージコマンド用のプレフィックス

const guildPlayers = new Map();       
const guildVolumes = new Map();       
const guildActiveStreams = new Map();  
const guildReverseStreams = new Map(); 

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

// 💡 メッセージ（!コマンド）を読み取るため、MessageContentインテントを追加
const createClient = () => new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildVoiceStates, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent, // 👈 ユーザーの「!コマンド」を読み取るために必須
        GatewayIntentBits.GuildMembers
    ]
});

const clientMain = createClient();
const subClients = []; 
function setupVoiceReceiverForMain(connection, sourceName, guildId, sourceIndex, mainConnection) {
    const receiver = connection.receiver;
    const activeStreams = guildActiveStreams.get(guildId);

    connection.on(VoiceConnectionStatus.Ready, () => { console.log(`📡 [Bot: ${sourceName}] 受信準備完了。`); });

    receiver.speaking.on('start', (userId) => {
        const compositeKey = `${sourceIndex}_${userId}`;
        if (activeStreams.has(compositeKey)) return; 
        
        const opusStream = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
        const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
        const passThrough = new PassThrough({ highWaterMark: 1024 * 16 });

        opusStream.on('error', () => {}); decoder.on('error', () => {}); passThrough.on('error', () => {});
        opusStream.pipe(decoder).pipe(passThrough);

        const resource = createAudioResource(passThrough, { inputType: StreamType.Raw, inlineVolume: true });
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
                if (player) player.stop(true); 
                decoder.unpipe(passThrough); opusStream.unpipe(decoder);
                passThrough.destroy(); decoder.destroy(); opusStream.destroy(); 
            } catch(e){}
            activeStreams.delete(compositeKey);
        }, 250);
    });
}

function setupReverseVoiceReceiver(connMain, guildId, targetSubIndex, speakerUserId, isOnly = false) {
    if (!guildReverseStreams.has(guildId)) guildReverseStreams.set(guildId, new Map());
    const reverseMap = guildReverseStreams.get(guildId);
    if (reverseMap.has(targetSubIndex)) stopReverseVoiceReceiver(guildId, targetSubIndex);

    const receiver = connMain.receiver;

    const startHandler = (userId) => {
        if (userId === clientMain.user?.id) return;
        if (subClients.some(sub => sub.user?.id === userId)) return;
        if (isOnly && userId !== speakerUserId) return; 
        
        const streamKey = `reverse_${targetSubIndex}_${userId}`;
        if (reverseMap.has(streamKey)) return;

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
                if (player) player.stop(true);
                decoder.unpipe(passThrough); opusStream.unpipe(decoder);
                passThrough.destroy(); decoder.destroy(); opusStream.destroy();
            } catch(e){}
            reverseMap.delete(streamKey);
        }, 250);
    };

    receiver.speaking.on('start', startHandler);
    receiver.speaking.on('end', endHandler);
    reverseMap.set(targetSubIndex, { startHandler, endHandler, isOnly, speakerUserId });
}

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
                passThrough.destroy(); streamData.decoder.destroy(); streamData.opusStream.destroy();
            } catch(e){}
            reverseMap.delete(key);
        }
    }
}
function connectToVCs(guildId, mainChannel, sourceChannels) {
    try { getVoiceConnection(guildId, 'botMain')?.destroy(); } catch(e){}
    sourceChannels.forEach((_, index) => { try { getVoiceConnection(guildId, `botSub_${index}`)?.destroy(); } catch(e){} });

    getOrCreateGuildResources(guildId, 0);
    sourceChannels.forEach((_, index) => { getOrCreateGuildResources(guildId, index + 1); });

    const connMain = joinVoiceChannel({ 
        channelId: mainChannel.id, guildId, 
        adapterCreator: clientMain.guilds.cache.get(guildId).voiceAdapterCreator, 
        selfMute: false, selfDeaf: false, group: 'botMain'
    });
    
    const { player: mainPlayer } = getOrCreateGuildResources(guildId, 0);
    connMain.subscribe(mainPlayer);

    sourceChannels.forEach(async (channel, index) => {
        const clientSub = subClients[index];
        if (!clientSub) return;
        
        const targetGuild = await clientSub.guilds.fetch(guildId).catch(() => null);
        if (!targetGuild) return;

        const connSub = joinVoiceChannel({ 
            channelId: channel.id, guildId, 
            adapterCreator: targetGuild.voiceAdapterCreator, 
            selfMute: false, selfDeaf: false, group: `botSub_${index}`
        });
        
        const { player: subPlayer } = getOrCreateGuildResources(guildId, index + 1);
        connSub.subscribe(subPlayer);

        setupVoiceReceiverForMain(connSub, `Sub_${index + 1}`, guildId, index + 1, connMain);
    });
}

clientMain.once('ready', async () => { 
    console.log(`🚀 司令塔Bot (Main) がテキストコマンドモードで正常に起動しました！`); 
});

process.on('uncaughtException', (err) => { 
    if (!err.message.includes('Premature close') && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error('Warning:', err); 
});

(async () => {
    try {
        if (!TOKENS.botMain || TOKENS.subs.length === 0) return console.error('❌ 環境変数が空です。'); 
        await clientMain.login(TOKENS.botMain);

        // 🌟 メッセージ受信イベント（テキストコマンド判定）
        clientMain.on('messageCreate', async (message) => {
            if (message.author.bot || !message.content.startsWith(PREFIX)) return;

            const args = message.content.slice(PREFIX.length).trim().split(/ +/);
            const command = args.shift().toLowerCase();
            const currentGuildId = message.guildId;
            const guild = message.guild;
            if (!guild) return;

            // 📊 !status コマンド
            if (command === 'status') {
                let statusMsg = `📊 **【中継システム現在状況】**\n`;
                const connMain = getVoiceConnection(currentGuildId, 'botMain');
                statusMsg += connMain ? `・📢 大域Bot (Main): 🟢 接続中 (<#${connMain.joinConfig.channelId}>)\n` : `・📢 大域Bot (Main): 🔴 未接続\n`;

                for (let i = 0; i < TOKENS.subs.length; i++) {
                    const connSub = getVoiceConnection(currentGuildId, `botSub_${i}`);
                    if (connSub) {
                        const v = guildVolumes.get(currentGuildId)?.get(String(i + 1)) ?? 100;
                        statusMsg += `・🎧 聴く係Bot ${i + 1}: 🟢 接続中 (<#${connSub.joinConfig.channelId}>) [音量: ${v}%]\n`;
                    } else {
                        statusMsg += `・🎧 聴く係Bot ${i + 1}: 🔴 未接続\n`;
                    }
                }
                return message.reply(statusMsg).catch(() => {});
            }

            // 🔊 !setvc コマンド [フォーマット: !setvc VC名1 VC名2...]
            if (command === 'setvc') {
                console.log(`📥 コマンド受信 (!setvc): ${message.content}`);

                if (args.length < 2) {
                    return message.reply('❌ 使用方法: `!setvc [メインVC名] [サブVC名1] [サブVC名2]...`').catch(() => {});
                }

                const statusNotice = await message.reply('⏳ ボイスチャンネルを探索中... サブBot群の初期化を開始します。').catch(() => null);

                try {
                    // キャッシュを最新にするため、一度ギルド内のすべてのチャンネル情報を強制取得
                    const channels = await guild.channels.fetch().catch(() => null);
                    if (!channels) {
                        console.error('❌ サーバーのチャンネル一覧の取得に失敗しました。');
                        if (statusNotice) statusNotice.edit('❌ サーバーのチャンネル一覧の取得に失敗しました。').catch(() => {});
                        return;
                    }

                    // 引数の文字列（チャンネル名、またはID）から対応するボイスチャンネルを特定
                    const findVoiceChannel = (targetStr) => {
                        return channels.find(c => c && (c.id === targetStr || c.name === targetStr) && (c.type === ChannelType.GuildVoice || c.isVoiceBased()));
                    };

                    // 💡 【バグ修正】argsから文字列として正確にファースト引数を抽出
                    const mainVCName = args[0];
                    const subVCNames = args.slice(1);

                    console.log(`🔍 探索ターゲット - メインVC: [${mainVCName}], サブVC群: [${subVCNames.join(', ')}]`);

                    const channelMain = findVoiceChannel(mainVCName);
                    const sourceChannels = subVCNames.map(name => findVoiceChannel(name)).filter(Boolean);

                    if (!channelMain) {
                        console.error(`❌ メインVC [${mainVCName}] が見つかりませんでした。`);
                        if (statusNotice) statusNotice.edit(`❌ メインVC [${mainVCName}] が見つかりません。名前が完全に一致しているか確認してください。`).catch(() => {});
                        return;
                    }

                    if (sourceChannels.length === 0) {
                        console.error(`❌ 有効なサブVCが1つも見つかりませんでした。入力値: ${subVCNames.join(', ')}`);
                        if (statusNotice) statusNotice.edit('❌ 指定された名前のサブボイスチャンネルが見つかりません。').catch(() => {});
                        return;
                    }

                    console.log(`✅ チャンネル特定成功: メインID=${channelMain.id}, サブ台数=${sourceChannels.length}`);

                    // 選ばれたサブBotの数だけ、その場で初めてオンデマンドにバックグラウンドログインさせる
                    for (let i = 0; i < sourceChannels.length; i++) {
                        if (!subClients[i]) {
                            console.log(`🔗 聴く係Bot_${i + 1} をオンデマンドログイン中...`);
                            if (statusNotice) statusNotice.edit(`🔗 聴く係Bot_${i + 1} をオンデマンドログイン中...`).catch(() => {});
                            const subClient = createClient();
                            await new Promise((resolve, reject) => {
                                subClient.once('ready', () => { subClients[i] = subClient; resolve(); });
                                subClient.login(TOKENS.subs[i]).catch(reject);
                            });
                        }
                    }

                    if (statusNotice) statusNotice.edit('🔊 ボイスチャンネルへの一括接続ラインを開通しています...').catch(() => {});

                    // ボイスチャンネルへ一括接続
                    connectToVCs(currentGuildId, channelMain, sourceChannels);
                    
                    let configData = {};
                    if (fs.existsSync(CONFIG_FILE)) { try { configData = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch(e){} }
                    configData[currentGuildId] = { mainId: channelMain.id, sourceIds: sourceChannels.map(c => c.id), volumes: configData[currentGuildId]?.volumes || {} };
                    fs.writeFileSync(CONFIG_FILE, JSON.stringify(configData, null, 2));

                    let vcDetailMsg = `📌 **【接続チャンネル詳細】**\n・📢 大域Bot (Main) ➔ <#${channelMain.id}>`;
                    sourceChannels.forEach((ch, idx) => {
                        const v = guildVolumes.get(currentGuildId)?.get(String(idx + 1)) ?? 100;
                        vcDetailMsg += `\n・🎧 聴く係Bot ${idx + 1} ➔ <#${ch.id}> (音量: **${v}%**)`;
                    });
                    
                    if (statusNotice) statusNotice.edit(`✅ **中継接続ラインを開通しました！**\n\n${vcDetailMsg}`).catch(() => {});
                    console.log(`🎉 ギルド [${currentGuildId}] での中継開通が正常に完了しました。`);
                } catch (error) { 
                    console.error("❌ セットアップエラー:", error); 
                    if (statusNotice) statusNotice.edit('❌ ボットの一括初期化、またはVC接続中にエラーが発生しました。').catch(() => {});
                }
            }

            // 🎙️ !vcon コマンド [フォーマット: !vcon 番号 モード(任意)]
            if (command === 'vcon') {
                const targetIdxNum = parseInt(args[0], 10);
                const mode = args[1] || 'all';

                if (isNaN(targetIdxNum) || targetIdxNum < 1) {
                    return message.reply('❌ 使用方法: `!vcon [サブBot番号(1, 2...)] [all または only (任意)]`').catch(() => {});
                }

                const connMain = getVoiceConnection(currentGuildId, 'botMain');
                if (!connMain) return message.reply('❌ メインBotがまだVCに参加していません。先に `!setvc` を実行してください。').catch(() => {});

                setupReverseVoiceReceiver(connMain, currentGuildId, targetIdxNum, message.author.id, (mode === 'only'));
                return message.reply(`🎙️ サブBot ${targetIdxNum} への逆方向拡声を開始しました。(${mode === 'only' ? '自分のみ専用モード' : '全員ミキサーモード'})`).catch(() => {});
            }

            // 🎙️ !vcononly コマンド [フォーマット: !vcononly 番号]
            if (command === 'vcononly') {
                const targetIdxNum = parseInt(args[0], 10);

                if (isNaN(targetIdxNum) || targetIdxNum < 1) {
                    return message.reply('❌ 使用方法: `!vcononly [サブBot番号(1, 2...)]`').catch(() => {});
                }

                const connMain = getVoiceConnection(currentGuildId, 'botMain');
                if (!connMain) return message.reply('❌ メインBotがまだVCに参加していません。').catch(() => {});

                setupReverseVoiceReceiver(connMain, currentGuildId, targetIdxNum, message.author.id, true);
                return message.reply(`🎙️ 【自分のみ専用】サブBot ${targetIdxNum} への逆方向拡声を開始しました。`).catch(() => {});
            }

            // 🔕 !vcoff コマンド [フォーマット: !vcoff 番号]
            if (command === 'vcoff') {
                const targetIdxNum = parseInt(args[0], 10);

                if (isNaN(targetIdxNum) || targetIdxNum < 1) {
                    return message.reply('❌ 使用方法: `!vcoff [サブBot番号(1, 2...)]`').catch(() => {});
                }

                stopReverseVoiceReceiver(currentGuildId, targetIdxNum);
                return message.reply(`🔕 サブBot ${targetIdxNum} への逆方向拡声をオフにしました。`).catch(() => {});
            }

            // 🎵 !vol コマンド [フォーマット: !vol 番号 音量%]
            if (command === 'vol') {
                const targetIdxNum = parseInt(args[0], 10);
                const value = parseInt(args[1], 10);

                if (isNaN(targetIdxNum) || targetIdxNum < 1 || isNaN(value) || value < 0 || value > 300) {
                    return message.reply('❌ 使用方法: `!vol [サブBot番号] [音量(0〜300)]`').catch(() => {});
                }

                if (!guildVolumes.has(currentGuildId)) guildVolumes.set(currentGuildId, new Map());
                guildVolumes.get(currentGuildId).set(String(targetIdxNum), value);

                const activeStreams = guildActiveStreams.get(currentGuildId);
                if (activeStreams) {
                    for (const [key, streamData] of activeStreams.entries()) {
                        if (key.startsWith(`${targetIdxNum}_`)) streamData.resource.volume.setVolume(value / 100);
                    }
                }

                try {
                    let configData = {};
                    if (fs.existsSync(CONFIG_FILE)) configData = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
                    if (!configData[currentGuildId]) configData[currentGuildId] = {};
                    if (!configData[currentGuildId].volumes) configData[currentGuildId].volumes = {};
                    configData[currentGuildId].volumes[targetIdxNum] = value;
                    fs.writeFileSync(CONFIG_FILE, JSON.stringify(configData, null, 2));
                } catch (e) { console.error(e); }

                return message.reply(`🔊 元VC ${targetIdxNum} の音量を ${value}% に変更しました。`).catch(() => {});
            }
            // 🚪 !vcleave コマンド
            if (command === 'vcleave') {
                const connMain = getVoiceConnection(currentGuildId, 'botMain');
                if (connMain) connMain.destroy();
                for (let i = 0; i < TOKENS.subs.length; i++) {
                    const connSub = getVoiceConnection(currentGuildId, `botSub_${i}`);
                    if (connSub) { try { connSub.destroy(); } catch(e){} }
                }
                return message.reply('👋 すべてのボイスチャンネルから退出しました。').catch(() => {});
            }

            // ♻️ !connect コマンド（前回履歴からの再接続）
            if (command === 'connect') {
                if (!fs.existsSync(CONFIG_FILE)) return message.reply('❌ 接続履歴がありません。').catch(() => {});
                
                const statusNotice = await message.reply('♻️ 前回の設定・音量をロードして中継の再開を準備中...').catch(() => null);

                try {
                    const configData = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
                    const guildConfig = configData[currentGuildId];
                    if (!guildConfig) {
                        if (statusNotice) statusNotice.edit('❌ このサーバーでの接続履歴がありません。').catch(() => {});
                        return;
                    }

                    const channels = await guild.channels.fetch().catch(() => null);
                    if (!channels) {
                        if (statusNotice) statusNotice.edit('❌ チャンネル情報の取得に失敗しました。').catch(() => {});
                        return;
                    }

                    const channelMain = channels.get(guildConfig.mainId);
                    const sourceChannels = guildConfig.sourceIds.map(id => channels.get(id)).filter(Boolean);
                    
                    if (!channelMain || sourceChannels.length === 0) {
                        if (statusNotice) statusNotice.edit('❌ 履歴にあるチャンネルが見つかりません。削除された可能性があります。').catch(() => {});
                        return;
                    }

                    if (!guildVolumes.has(currentGuildId)) guildVolumes.set(currentGuildId, new Map());
                    const volMap = guildVolumes.get(currentGuildId);

                    if (guildConfig.volumes) { 
                        Object.keys(guildConfig.volumes).forEach(idx => { 
                            volMap.set(String(idx), guildConfig.volumes[idx]); 
                        }); 
                    }

                    // サブBotが未初期化の場合はオンデマンドログイン
                    for (let i = 0; i < sourceChannels.length; i++) {
                        if (!subClients[i]) {
                            const subClient = createClient();
                            await new Promise((res, rej) => {
                                subClient.once('ready', () => { subClients[i] = subClient; res(); });
                                subClient.login(TOKENS.subs[i]).catch(rej);
                            });
                        }
                    }

                    connectToVCs(currentGuildId, channelMain, sourceChannels);

                    let vcDetailMsg = `📌 **【接続チャンネル詳細】**\n・📢 大域Bot (Main) ➔ <#${channelMain.id}>`;
                    sourceChannels.forEach((ch, idx) => {
                        const v = volMap.get(String(idx + 1)) ?? 100;
                        vcDetailMsg += `\n・🎧 聴く係Bot ${idx + 1} ➔ <#${ch.id}> (音量: **${v}%**)`;
                    });

                    if (statusNotice) statusNotice.edit(`♻️ 前回の設定・音量をロードして中継を再開しました！\n\n${vcDetailMsg}`).catch(() => {});
                } catch (e) { 
                    console.error(e);
                    if (statusNotice) statusNotice.edit('❌ 再接続エラーが発生しました。').catch(() => {});
                }
            }
        }); // clientMain.on('messageCreate') の閉じ
    } catch (err) { console.error('❌ 接続エラー:', err); }
})();
