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

// UptimeRobotなどの死活監視サービスがアクセスするエンドポイント
app.get('/', (req, res) => {
    res.send('Discord VC Relay Bot is running! 🚀');
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// サーバーの起動
app.listen(PORT, () => {
    console.log(`[HTTP Server] Renderスリープ回避用サーバーが起動しました（ポート: ${PORT}）`);
});

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

const guildPlayers = new Map();       // 各ギルドの各Botプレイヤー管理
const guildVolumes = new Map();       // 各ギルドの音量設定
const guildActiveStreams = new Map();  // 各ギルドの順方向（サブ -> メイン）ストリーム管理
const guildReverseStreams = new Map(); // 各ギルドの逆方向（メイン -> サブ）ストリーム管理

/**
 * 🌟 ギルドリソース生成ヘルパー関数
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

// 🌟 Discordクライアント生成
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
const subClients = [];
// 🌟 スラッシュコマンドの定義データ
const COMMANDS_DATA = [
    {
        name: 'setvc',
        description: 'ボイスチャンネルにボットを入室させ、中継経路を設定します。',
        options: [
            {
                name: 'main_vc',
                description: '大域Botが入るボイスチャンネルを選択してください',
                type: ApplicationCommandOptionType.Channel,
                channelTypes: [ChannelType.GuildVoice],
                required: true
            },
            {
                name: 'sub_vc_1',
                description: '聴く係Bot 1が入るボイスチャンネルを選択してください',
                type: ApplicationCommandOptionType.Channel,
                channelTypes: [ChannelType.GuildVoice],
                required: true
            },
            {
                name: 'sub_vc_2',
                description: '聴く係Bot 2が入るボイスチャンネルを選択してください（任意）',
                type: ApplicationCommandOptionType.Channel,
                channelTypes: [ChannelType.GuildVoice],
                required: false
            },
            {
                name: 'sub_vc_3',
                description: '聴く係Bot 3が入るボイスチャンネルを選択してください（任意）',
                type: ApplicationCommandOptionType.Channel,
                channelTypes: [ChannelType.GuildVoice],
                required: false
            }
        ]
    },
    {
        name: 'connect',
        description: '前回の履歴（config.json）の設定を引き継いで再接続します。'
    },
    {
        name: 'vcleave',
        description: 'すべてのボイスチャンネルからボットを退室させます。'
    },
    {
        name: 'vcon',
        description: 'メインVCから特定のサブVCへの逆方向拡声をオンにします。',
        options: [
            {
                name: 'number',
                description: '対象のサブBot番号 (1, 2, ...)',
                type: ApplicationCommandOptionType.Integer,
                required: true
            },
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
    {
        name: 'vcononly',
        description: '【自分のみ専用】メインVCから特定のサブVCへの逆方向拡声をオンにします。',
        options: [
            {
                name: 'number',
                description: '対象のサブBot番号 (1, 2, ...)',
                type: ApplicationCommandOptionType.Integer,
                required: true
            }
        ]
    },
    {
        name: 'vcoff',
        description: '指定したサブBotへの逆方向拡声をオフにします。',
        options: [
            {
                name: 'number',
                description: '対象のサブBot番号 (1, 2, ...)',
                type: ApplicationCommandOptionType.Integer,
                required: true
            }
        ]
    },
    {
        name: 'vol',
        description: '指定した元VC（サブBot）の受信音量を変更します。',
        options: [
            {
                name: 'number',
                description: '対象のサブBot番号 (1, 2, ...)',
                type: ApplicationCommandOptionType.Integer,
                required: true
            },
            {
                name: 'volume',
                description: '音量% (0〜300)',
                type: ApplicationCommandOptionType.Integer,
                required: true
            }
        ]
    },
    {
        name: 'status',
        description: '現在の中継接続ステータスとBotの稼働状況を表示します。'
    }
];
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
        }, 250);
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
        if (userId === clientMain.user?.id) return;
        const isSubBot = subClients.some(sub => sub.user?.id === userId);
        if (isSubBot) return;

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
        }, 250);
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

/**
 * 🌟 ボイスチャンネルへの一括接続処理
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
// 🌟 メインBotの起動イベント
clientMain.once('ready', async () => { 
    console.log(`🚀 司令塔Botが正常に起動しました！いつでもオンラインで待ち受け可能です。`); 

    try {
        console.log('⏳ グローバル・スラッシュコマンドをDiscordへ登録中...');
        await clientMain.application.commands.set(COMMANDS_DATA);
        console.log('✅ すべてのスラッシュコマンドの登録が正常に完了しました！');
    } catch (error) {
        console.error('❌ スラッシュコマンドの登録中にエラーが発生しました:', error);
    }
});

process.on('uncaughtException', (err) => { 
    if (!err.message.includes('Premature close') && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        console.error(' [システム警告]:', err); 
    }
});

// 🌟 起動メインプロセス
(async () => {
    try {
        if (!TOKENS.botMain || TOKENS.subs.length === 0) { 
            console.error('❌ 環境変数が空です。'); 
            return; 
        }

        console.log('🔗 司令塔Bot (Main) に接続中...');
        await clientMain.login(TOKENS.botMain);

        // 🌟 スラッシュコマンドの受付窓口（イベント）
        clientMain.on('interactionCreate', async (interaction) => {
            if (!interaction.isChatInputCommand()) return;

            const currentGuildId = interaction.guildId;
            const guild = clientMain.guilds.cache.get(currentGuildId);
            if (!guild) return;

            const { commandName, options } = interaction;

            // 📊 ステータス確認コマンド (/status)
            // 🌟 5つ目のブロックの /setvc の中身を以下に差し替え

        if (commandName === 'setvc') {
            await interaction.deferReply();

            // options.getChannel() から取得
            const mainChannelRaw = options.getChannel('main_vc');
            const channelMain = guild.channels.cache.get(mainChannelRaw?.id);

            const subChannelIds = [
                options.getChannel('sub_vc_1')?.id,
                options.getChannel('sub_vc_2')?.id,
                options.getChannel('sub_vc_3')?.id
            ].filter(Boolean);

            // キャッシュから完全なオブジェクトの配列を作成
            const sourceChannels = subChannelIds
                .map(id => guild.channels.cache.get(id))
                .filter(Boolean);

            if (!channelMain || sourceChannels.length === 0) {
                return interaction.editReply('❌ 指定されたボイスチャンネルが正しく選択されていません。');
            }

            if (sourceChannels.length > TOKENS.subs.length) {
               return interaction.editReply(`❌ 用意されているサブBotの数（最大 ${TOKENS.subs.length} 台）を超えています。`);
            }

            try {
                // 💡 ここで sourceChannels (オブジェクトの配列) を正しく渡す
                connectToVCs(currentGuildId, channelMain, sourceChannels);

                let configData = {};
                if (fs.existsSync(CONFIG_FILE)) { 
                    try { configData = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch(e){} 
                }
                configData[currentGuildId] = {
                    mainId: channelMain.id,
                    sourceIds: sourceChannels.map(c => c.id),
                    volumes: configData[currentGuildId]?.volumes || {}
                };
                fs.writeFileSync(CONFIG_FILE, JSON.stringify(configData, null, 2));

                if (!guildVolumes.has(currentGuildId)) guildVolumes.set(currentGuildId, new Map());
                const volMap = guildVolumes.get(currentGuildId);

                let vcDetailMsg = `📌 **【接続チャンネル詳細】**\n・📢 大域Bot (Main) ➔ <#${channelMain.id}>`;
                    sourceChannels.forEach((ch, idx) => {
                    const v = volMap.get(String(idx + 1)) ?? 100;
                    vcDetailMsg += `\n・🎧 聴く係Bot ${idx + 1} ➔ <#${ch.id}> (音量: **${v}%**)`;
                });

                return interaction.editReply(`🔊 中継接続ラインを開通しました！\n\n${vcDetailMsg}`);
            } catch (error) { 
                console.error(error); 
                return interaction.editReply('❌ 接続エラーが発生しました。'); 
            }
        }


            // 🎙️ 逆方向拡声オンコマンド (/vcon)
            if (commandName === 'vcon') {
                const targetIdxNum = options.getInteger('number');
                const mode = options.getString('mode') || 'all';

                if (targetIdxNum < 1) {
                    return interaction.reply({ content: '❌ 番号は1以上の数値にしてください。', ephemeral: true });
                }

                const connMain = getVoiceConnection(currentGuildId, 'botMain');
                if (!connMain) {
                    return interaction.reply({ content: '❌ メインBotがまだVCに参加していません。先に `/setvc` を実行してください。', ephemeral: true });
                }

                const isOnlyMode = (mode === 'only');
                setupReverseVoiceReceiver(connMain, currentGuildId, targetIdxNum, interaction.user.id, isOnlyMode);

                if (isOnlyMode) {
                    return interaction.reply(`🎙️ **【オンリーモード】** メインVC ➔ 聴く係Bot ${targetIdxNum} への逆方向拡声を開始。**あなたの声だけ**が指定した部屋に流れます。`);
                } else {
                    return interaction.reply(`🎙️ **【全員ミキサーモード】** メインVC ➔ 聴く係Bot ${targetIdxNum} への逆方向拡声を開始。メインVCの**全員の声がミックスされて**流れます。`);
                }
            }

            // 🎙️ 【自分のみ専用】逆方向拡声オンコマンド (/vcononly)
            if (commandName === 'vcononly') {
                const targetIdxNum = options.getInteger('number');

                if (targetIdxNum < 1) {
                    return interaction.reply({ content: '❌ 番号は1以上の数値にしてください。', ephemeral: true });
                }

                const connMain = getVoiceConnection(currentGuildId, 'botMain');
                if (!connMain) {
                    return interaction.reply({ content: '❌ メインBotがまだVCに参加していません。先に `/setvc` を実行してください。', ephemeral: true });
                }

                setupReverseVoiceReceiver(connMain, currentGuildId, targetIdxNum, interaction.user.id, true);
                return interaction.reply(`🎙️ **【オンリーモード】** メインVC ➔ 聴く係Bot ${targetIdxNum} への逆方向拡声を開始。**あなたの声だけ**が指定した部屋に流れます。`);
            }

            // 🔕 逆方向拡声オフコマンド (/vcoff)
            if (commandName === 'vcoff') {
                const targetIdxNum = options.getInteger('number');
                if (targetIdxNum < 1) {
                    return interaction.reply({ content: '❌ 番号は1以上の数値にしてください。', ephemeral: true });
                }

                stopReverseVoiceReceiver(currentGuildId, targetIdxNum);
                return interaction.reply(`🔕 聴く係Bot ${targetIdxNum} への逆方向拡声を解除（オフ）にしました。`);
            }

            // 🎵 音量変更コマンド (/vol)
            if (commandName === 'vol') {
                const targetIdxNum = options.getInteger('number');
                const value = options.getInteger('volume');

                if (targetIdxNum < 1) {
                    return interaction.reply({ content: '❌ 番号は1以上の数値にしてください。', ephemeral: true });
                }
                if (value < 0 || value > 300) {
                    return interaction.reply({ content: '❌ 音量は 0 〜 300 (%) の範囲で指定してください。', ephemeral: true });
                }

                if (!guildVolumes.has(currentGuildId)) guildVolumes.set(currentGuildId, new Map());
                guildVolumes.get(currentGuildId).set(String(targetIdxNum), value);

                const activeStreams = guildActiveStreams.get(currentGuildId);
                if (activeStreams) {
                    for (const [key, streamData] of activeStreams.entries()) {
                        if (key.startsWith(`${targetIdxNum}_`)) {
                            streamData.resource.volume.setVolume(value / 100);
                        }
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

                return interaction.reply(`🔊 元VC ${targetIdxNum} の音量を ${value}% に変更しました。（中継へ即時適用）`);
            }

            // 🚪 退出コマンド (/vcleave)
            if (commandName === 'vcleave') {
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
                                if (streamData.player) streamData.player.stop(true);
                                streamData.decoder.unpipe(streamData.passThrough);
                                streamData.opusStream.unpipe(streamData.decoder);
                                streamData.passThrough.destroy();
                                streamData.decoder.destroy();
                                streamData.opusStream.destroy();
                            } catch(e){}
                        }
                        activeStreams.clear();
                    }

                    return interaction.reply(disconnected ? '👋 ボットがすべてのVCから退出しました。' : '❓ ボットはボイスチャンネルに参加していません。');
                } catch (e) { 
                    console.error(e); 
                    return interaction.reply({ content: '❌ 退出エラーが発生しました。', ephemeral: true }); 
                }
            }
            // 接続・中継開始コマンド (/setvc)
            if (commandName === 'setvc') {
                await interaction.deferReply();

                // 💡 cache.getを引き直さず、options.getChannelから安全に取得
                const channelMain = options.getChannel('main_vc');

                const subChannelIds = [
                    options.getChannel('sub_vc_1'),
                    options.getChannel('sub_vc_2'),
                    options.getChannel('sub_vc_3')
                ].filter(Boolean);

                if (!channelMain || subChannelIds.length === 0) {
                    return interaction.editReply('❌ 指定されたボイスチャンネルが正しく選択されていません。');
                }

                if (subChannelIds.length > TOKENS.subs.length) {
                    return interaction.editReply(`❌ 用意されているサブBotの数（最大 ${TOKENS.subs.length} 台）を超えています。`);
                }

                try {
                    connectToVCs(currentGuildId, channelMain, subChannelIds);
                    
                    let configData = {};
                    if (fs.existsSync(CONFIG_FILE)) { 
                        try { configData = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch(e){} 
                    }
                    configData[currentGuildId] = {
                        mainId: channelMain.id,
                        sourceIds: subChannelIds.map(c => c.id),
                        volumes: configData[currentGuildId]?.volumes || {}
                    };
                    fs.writeFileSync(CONFIG_FILE, JSON.stringify(configData, null, 2));

                    if (!guildVolumes.has(currentGuildId)) guildVolumes.set(currentGuildId, new Map());
                    const volMap = guildVolumes.get(currentGuildId);

                    let vcDetailMsg = `📌 **【接続チャンネル詳細】**\n・📢 大域Bot (Main) ➔ <#${channelMain.id}>`;
                    subChannelIds.forEach((ch, idx) => {
                        const v = volMap.get(String(idx + 1)) ?? 100;
                        vcDetailMsg += `\n・🎧 聴く係Bot ${idx + 1} ➔ <#${ch.id}> (音量: **${v}%**)`;
                    });

                    return interaction.editReply(`🔊 中継接続ラインを開通しました！\n\n${vcDetailMsg}`);
                } catch (error) { 
                    console.error(error); 
                    return interaction.editReply('❌ 接続エラーが発生しました。'); 
                }
            }

            // ♻️ 履歴から再接続コマンド (/connect)
            if (commandName === 'connect') {
                if (!fs.existsSync(CONFIG_FILE)) return interaction.reply({ content: '❌ 接続履歴がありません。', ephemeral: true });
                
                await interaction.deferReply();

                try {
                    const configData = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
                    const guildConfig = configData[currentGuildId];
                    if (!guildConfig) return interaction.editReply('❌ このサーバーでの接続履歴がありません。');

                    await guild.channels.fetch().catch(() => null);
                    const channelMain = guild.channels.cache.get(guildConfig.mainId);
                    const sourceChannels = [];
                    for (const id of guildConfig.sourceIds) { 
                        const ch = guild.channels.cache.get(id); 
                        if (ch) sourceChannels.push(ch); 
                    }
                    
                    if (!channelMain || sourceChannels.length === 0) {
                        return interaction.editReply('❌ 履歴にあるチャンネルが見つかりません。削除された可能性があります。');
                    }

                    if (!guildVolumes.has(currentGuildId)) guildVolumes.set(currentGuildId, new Map());
                    const volMap = guildVolumes.get(currentGuildId);

                    if (guildConfig.volumes) { 
                        Object.keys(guildConfig.volumes).forEach(idx => { 
                            volMap.set(String(idx), guildConfig.volumes[idx]); 
                        }); 
                    }

                    connectToVCs(currentGuildId, channelMain, sourceChannels);

                    let vcDetailMsg = `📌 **【接続チャンネル詳細】**\n・📢 大域Bot (Main) ➔ <#${channelMain.id}>`;
                    sourceChannels.forEach((ch, idx) => {
                        const v = volMap.get(String(idx + 1)) ?? 100;
                        vcDetailMsg += `\n・🎧 聴く係Bot ${idx + 1} ➔ <#${ch.id}> (音量: **${v}%**)`;
                    });

                    return interaction.editReply(`♻️ 前回の設定・音量をロードして中継を再開しました！\n\n${vcDetailMsg}`);
                } catch (error) { 
                    console.error(error); 
                    return interaction.editReply('❌ 再接続エラーが発生しました。'); 
                }
            }
        }); // clientMain.on('interactionCreate') の閉じ

        // 🌟 サブBotを安全にログインさせ、準備完了後に配列へ追加
        for (let i = 0; i < TOKENS.subs.length; i++) {
            await new Promise(r => setTimeout(r, 5000));
            console.log(`🔗 聴く係Bot (${i + 1}/${TOKENS.subs.length}) に接続中...`);
            const subClient = createClient();
            
            subClient.on('error', (err) => console.error(`[Sub_${i + 1} エラー]:`, err));
            subClient.once('ready', () => { 
                console.log(`✅ 聴く係Bot_${i + 1} オンライン。`); 
                subClients.push(subClient); // 💡 Readyを待ってからプッシュすることで逆方向ハウリング防止の安全性を確保
            });
            
            await subClient.login(TOKENS.subs[i]);
        }
        console.log(`🚀 すべてのBot（合計 ${subClients.length + 1} 台）が正常に起動しました！同時購読中継システム稼働準備完了。`);

    } catch (err) { 
        console.error('❌ ログイン接続エラー:', err); 
    }
})();
