process.env.NODE_NO_WARNINGS = '1';
const { Client, GatewayIntentBits, ChannelType, ApplicationCommandOptionType } = require('discord.js');
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

const createClient = () => new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildVoiceStates, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

const clientMain = createClient();
const subClients = []; // 💡 ログイン完了したサブBotのインスタンスが動的に格納される
const COMMANDS_DATA = [
    {
        name: 'setvc',
        description: 'ボイスチャンネルにボットを入室させ、中継経路を設定します。',
        options: [
            { name: 'main_vc', description: '大域Botが入るボイスチャンネルを選択してください', type: ApplicationCommandOptionType.Channel, channelTypes: [ChannelType.GuildVoice], required: true },
            { name: 'sub_vc_1', description: '聴く係Bot 1が入るボイスチャンネルを選択してください', type: ApplicationCommandOptionType.Channel, channelTypes: [ChannelType.GuildVoice], required: true },
            { name: 'sub_vc_2', description: '聴く係Bot 2が入るボイスチャンネルを選択してください（任意）', type: ApplicationCommandOptionType.Channel, channelTypes: [ChannelType.GuildVoice], required: false },
            { name: 'sub_vc_3', description: '聴く係Bot 3が入るボイスチャンネルを選択してください（任意）', type: ApplicationCommandOptionType.Channel, channelTypes: [ChannelType.GuildVoice], required: false }
        ]
    },
    { name: 'connect', description: '前回の履歴（config.json）の設定を引き継いで再接続します。' },
    { name: 'vcleave', description: 'すべてのボイスチャンネルからボットを退室させます。' },
    {
        name: 'vcon',
        description: 'メインVCから特定のサブVCへの逆方向拡声をオンにします。',
        options: [
            { name: 'number', description: '対象のサブBot番号 (1, 2, ...)', type: ApplicationCommandOptionType.Integer, required: true },
            {
                name: 'mode',
                description: '拡声モード（全員ミキサー or コマンド実行者のみ）',
                type: ApplicationCommandOptionType.String,
                required: false,
                choices: [
                    { name: '全員ミックス (all)', value: 'all' },
                    { name: '自分のみ (only)', value: 'only' }
                ]
            }
        ]
    },
    { name: 'vcononly', description: '【自分のみ専用】メインVCから特定のサブVCへの逆方向拡声をオンにします。', options: [ { name: 'number', description: '対象のサブBot番号 (1, 2, ...)', type: ApplicationCommandOptionType.Integer, required: true } ] },
    { name: 'vcoff', description: '指定したサブBotへの逆方向拡声をオフにします。', options: [ { name: 'number', description: '対象のサブBot番号 (1, 2, ...)', type: ApplicationCommandOptionType.Integer, required: true } ] },
    {
        name: 'vol',
        description: '指定した元VC（サブBot）の受信音量を変更します。',
        options: [
            { name: 'number', description: '対象のサブBot番号 (1, 2, ...)', type: ApplicationCommandOptionType.Integer, required: true },
            { name: 'volume', description: '音量% (0〜300)', type: ApplicationCommandOptionType.Integer, required: true }
        ]
    },
    { name: 'status', description: '現在の中継接続ステータスとBotの稼働状況を表示します。' }
];
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
                streamData.passThrough.destroy(); streamData.decoder.destroy(); streamData.opusStream.destroy();
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
    console.log(`🚀 司令塔Bot (Main) が正常に起動しました！無料プラン最適化モード稼働中。`); 
    try {
        await clientMain.application.commands.set(COMMANDS_DATA);
        console.log('✅ スラッシュコマンド登録完了！');
    } catch (error) { console.error('❌ コマンド登録エラー:', error); }
});

process.on('uncaughtException', (err) => { 
    if (!err.message.includes('Premature close') && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error('Warning:', err); 
});

(async () => {
    try {
        if (!TOKENS.botMain || TOKENS.subs.length === 0) return console.error('❌ 環境変数が空です。'); 
        await clientMain.login(TOKENS.botMain);

        clientMain.on('interactionCreate', async (interaction) => {
            if (!interaction.isChatInputCommand()) return;

            const currentGuildId = interaction.guildId;
            const guild = clientMain.guilds.cache.get(currentGuildId);
            if (!guild) return;

            const { commandName, options } = interaction;

            // 📊 status
            if (commandName === 'status') {
                let statusMsg = `📊 **【中継システム現在状況】**\n`;
                const connMain = getVoiceConnection(currentGuildId, 'botMain');
                statusMsg += connMain ? `・📢 大域Bot (Main): 🟢 接続中 (<#${connMain.joinConfig.channelId}>)\n` : `・📢 大域Bot (Main): 🔴 未接続\n`;

                for (let i = 0; i < TOKENS.subs.length; i++) {
                    const connSub = getVoiceConnection(currentGuildId, `botSub_${i}`);
                    if (connSub) {
                        const v = guildVolumes.get(currentGuildId)?.get(String(i + 1)) ?? 100;
                        statusMsg += `=・🎧 聴く係Bot ${i + 1}: 🟢 接続中 (<#${connSub.joinConfig.channelId}>) [音量: ${v}%]\n`;
                    } else {
                        statusMsg += `・🎧 聴く係Bot ${i + 1}: 🔴 未接続\n`;
                    }
                }
                return interaction.reply({ content: statusMsg }).catch(() => {});
            }

            // 接続・中継開始コマンド (/setvc)
            if (commandName === 'setvc') {
                // 💡 【核心の修正】Renderの復帰遅延による3秒超過を想定し、通常のreplyをスキップして即座に非同期処理をスケジュール
                setImmediate(async () => {
                    let statusNotice = null;
                    try {
                        // 制限時間のないWebhook経由で、現在の進捗をチャンネルへテキスト送信
                        statusNotice = await interaction.channel.send('⏳ Renderサーバーが応答しました。接続中継ラインを検出中。サブBot群の起動を開始します...');
                    } catch (e) { console.error("通知の送信に失敗しました:", e); }

                    try {
                        const mainChannelRaw = options.getChannel('main_vc');
                        const channelMain = guild.channels.cache.get(mainChannelRaw?.id);

                        const subChannelIds = [
                            options.getChannel('sub_vc_1')?.id,
                            options.getChannel('sub_vc_2')?.id,
                            options.getChannel('sub_vc_3')?.id
                        ].filter(Boolean);

                        const sourceChannels = subChannelIds.map(id => guild.channels.cache.get(id)).filter(Boolean);

                        if (!channelMain || sourceChannels.length === 0) {
                            if (statusNotice) statusNotice.edit('❌ 指定されたボイスチャンネルが正しく選択されていません。').catch(() => {});
                            return;
                        }

                        // サブBotを順番にバックグラウンドログイン
                        for (let i = 0; i < sourceChannels.length; i++) {
                            if (!subClients[i]) {
                                if (statusNotice) statusNotice.edit(`🔗 聴く係Bot_${i + 1} を初期化中（サーバー復帰後のセットアップ）...`).catch(() => {});
                                const subClient = createClient();
                                await new Promise((resolve, reject) => {
                                    subClient.once('ready', () => {
                                        subClients[i] = subClient;
                                        resolve();
                                    });
                                    subClient.login(TOKENS.subs[i]).catch(reject);
                                });
                            }
                        }

                        if (statusNotice) statusNotice.edit('🔊 ボイスチャンネルへの一括接続ラインを開通しています...').catch(() => {});

                        // ボイスチャンネルへの一括接続処理
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
                        
                        // すべての中継セットアップが完了したら、メッセージを完了に更新
                        if (statusNotice) {
                            await statusNotice.edit(`✅ **中継接続ラインを開通しました！**\n\n${vcDetailMsg}`).catch(() => {});
                        }
                    } catch (error) { 
                        console.error("セットアップエラー:", error); 
                        if (statusNotice) statusNotice.edit('❌ ボットの一括初期化、またはVC接続中にエラーが発生しました。').catch(() => {});
                    }
                });
            }

            // 🎙️ vcon
            if (commandName === 'vcon') {
                const targetIdxNum = options.getInteger('number');
                const mode = options.getString('mode') || 'all';
                const connMain = getVoiceConnection(currentGuildId, 'botMain');
                if (!connMain) return interaction.reply({ content: '❌ メインBotが未参加です。先に `/setvc` を実行してください。', ephemeral: true });
                setupReverseVoiceReceiver(connMain, currentGuildId, targetIdxNum, interaction.user.id, (mode === 'only'));
                return interaction.reply(`🎙️ サブBot ${targetIdxNum} への逆方向拡声を開始しました。`);
            }
            
            // 🎙️ vcononly
            if (commandName === 'vcononly') {
                const targetIdxNum = options.getInteger('number');
                const connMain = getVoiceConnection(currentGuildId, 'botMain');
                if (!connMain) return interaction.reply({ content: '❌ メインBotが未参加です。', ephemeral: true });
                setupReverseVoiceReceiver(connMain, currentGuildId, targetIdxNum, interaction.user.id, true);
                return interaction.reply(`🎙️ 【自分のみ】サブBot ${targetIdxNum} への拡声を開始しました。`);
            }
            
            // 🔕 vcoff
            if (commandName === 'vcoff') {
                const targetIdxNum = options.getInteger('number');
                stopReverseVoiceReceiver(currentGuildId, targetIdxNum);
                return interaction.reply(`🔕 サブBot ${targetIdxNum} への逆方向拡声をオフにしました。`);
            }
            
            // 🎵 vol
            if (commandName === 'vol') {
                const targetIdxNum = options.getInteger('number');
                const value = options.getInteger('volume');
                if (!guildVolumes.has(currentGuildId)) guildVolumes.set(currentGuildId, new Map());
                guildVolumes.get(currentGuildId).set(String(targetIdxNum), value);
                const activeStreams = guildActiveStreams.get(currentGuildId);
                if (activeStreams) {
                    for (const [key, streamData] of activeStreams.entries()) {
                        if (key.startsWith(`${targetIdxNum}_`)) streamData.resource.volume.setVolume(value / 100);
                    }
                }
                return interaction.reply(`🔊 元VC ${targetIdxNum} の音量を ${value}% に変更しました。`);
            }
            
            // 🚪 vcleave
            if (commandName === 'vcleave') {
                const connMain = getVoiceConnection(currentGuildId, 'botMain');
                if (connMain) connMain.destroy();
                for (let i = 0; i < TOKENS.subs.length; i++) {
                    const connSub = getVoiceConnection(currentGuildId, `botSub_${i}`);
                    if (connSub) { try { connSub.destroy(); } catch(e){} }
                }
                return interaction.reply('👋 すべてのVCから退出しました。');
            }
            
            // ♻️ connect
            if (commandName === 'connect') {
                if (!fs.existsSync(CONFIG_FILE)) return interaction.reply({ content: '❌ 接続履歴がありません。', ephemeral: true });
                await interaction.deferReply();
                try {
                    const configData = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
                    const guildConfig = configData[currentGuildId];
                    if (!guildConfig) return interaction.editReply('❌ 履歴がありません。');
                    const channelMain = guild.channels.cache.get(guildConfig.mainId);
                    const sourceChannels = guildConfig.sourceIds.map(id => guild.channels.cache.get(id)).filter(Boolean);
                    
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
                    return interaction.editReply(`♻️ 前回の設定で再接続しました！`);
                } catch (e) { return interaction.editReply('❌ 再接続エラー。'); }
            }
        });
    } catch (err) { console.error('❌ 接続エラー:', err); }
})();
