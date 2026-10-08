process.env.NODE_NO_WARNINGS = '1';
const { Client, GatewayIntentBits, ChannelType, ApplicationCommandOptionType, PermissionFlagsBits } = require('discord.js');
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

// 💡 スラッシュコマンド化に伴い、不要になった GuildMessages と MessageContent インテントを除外
const createClient = () => new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
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
 * 🌟 新・逆方向中継：メインBotの声を「サブBotのプレイヤー」へ流し込む（全員ミックス or 特定の人のみ）
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
        // ハウリング対策：喋ったのがメインBot自身、またはサブBotたちの場合は絶対に中継しない
        if (userId === clientMain.user?.id) return;
        const isSubBot = subClients.some(sub => sub.user?.id === userId);
        if (isSubBot) return;

        // isOnlyがtrueなら、コマンド実行者以外の声は完全に無視（オンリーモード）
        if (isOnly && userId !== speakerUserId) return; 
        
        // ユーザーごとに独立したストリームキーを作成
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
                    player.stop(true); // 内部キャッシュを完全解放
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

    // 停止コマンドのためにイベントハンドラを記憶
    reverseMap.set(targetSubIndex, { startHandler, endHandler, isOnly, speakerUserId });
}

/**
 * 🌟 逆方向中継を完全に停止・解体する関数（メモリリーク・安全削除対策版）
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

    // 安全削除対策：一度削除対象のキーを配列に抽出してから一括解体する
    const keysToDelete = [];
    for (const key of reverseMap.keys()) {
        if (typeof key === 'string' && key.startsWith(`reverse_${targetSubIndex}_`)) {
            keysToDelete.push(key);
        }
    }

    keysToDelete.forEach(key => {
        const streamData = reverseMap.get(key);
        if (streamData) {
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
    });

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
clientMain.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const currentGuildId = interaction.guildId;
    const guild = clientMain.guilds.cache.get(currentGuildId);
    if (!guild) return;

    const command = interaction.commandName;

    // 📊 ステータス確認コマンド (/status)
    if (command === 'status') {
        const connMain = getVoiceConnection(currentGuildId, 'botMain');
        const activeStreams = guildActiveStreams.get(currentGuildId);
        const reverseMap = guildReverseStreams.get(currentGuildId);
        const volMap = guildVolumes.get(currentGuildId);

        let statusMsg = `📊 **【中継システム稼働ステータス】**\n\n`;

        if (connMain) {
            statusMsg += `🟢 **メインBot (司令塔)**\n`;
            statusMsg += `・接続先: 🔊 <#${connMain.joinConfig.channelId}>\n`;
            
            let reverseActiveInfo = '💤 なし (待機中)';
            let reverseSpeakingUsers = [];

            if (reverseMap) {
                for (let i = 1; i <= TOKENS.subs.length; i++) {
                    if (reverseMap.has(i)) {
                        const config = reverseMap.get(i);
                        reverseActiveInfo = `稼働中 (対象: 🎧 聴く係Bot ${i} ➔ ${config.isOnly ? '**オンリーモード**' : '**全員ミキサーモード**'})`;
                        
                        for (const key of reverseMap.keys()) {
                            if (typeof key === 'string' && key.startsWith(`reverse_${i}_`)) {
                                const userId = key.split('_')[2];
                                reverseSpeakingUsers.push(`<@${userId}>`);
                            }
                        }
                    }
                }
            }
            statusMsg += `・逆方向拡声: ${reverseActiveInfo}\n`;
            if (reverseSpeakingUsers.length > 0) {
                statusMsg += `  └ 🎙️ 現在発言中: ${reverseSpeakingUsers.join(', ')}\n`;
            }
        } else {
            statusMsg += `🔴 **メインBot (司令塔)**: ❌ 未接続\n`;
        }

        statusMsg += `\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

        for (let i = 0; i < TOKENS.subs.length; i++) {
            const connSub = getVoiceConnection(currentGuildId, `botSub_${i}`);
            const botNumber = i + 1;

            if (connSub) {
                const currentVol = volMap?.get(String(botNumber)) ?? 100;
                statusMsg += `🎧 **聴く係Bot ${botNumber} (Sub_${botNumber})**\n`;
                statusMsg += `・接続先: 🔊 <#${connSub.joinConfig.channelId}>\n`;
                statusMsg += `・現在の音量: **${currentVol}%**\n`;

                let speakingUsers = [];
                if (activeStreams) {
                    for (const key of activeStreams.keys()) {
                        if (key.startsWith(`${botNumber}_`)) {
                            const userId = key.split('_')[1];
                            speakingUsers.push(`<@${userId}>`);
                        }
                    }
                }

                if (speakingUsers.length > 0) {
                    statusMsg += `・アクティブ中継: 🎙️ ${speakingUsers.join(', ')} が発言中\n`;
                } else {
                    statusMsg += `・アクティブ中継: 💤 なし (待機中)\n`;
                }
            } else {
                statusMsg += `🎧 **聴く係Bot ${botNumber} (Sub_${botNumber})**: ❌ 未接続\n`;
            }
            statusMsg += `\n`;
        }

        return interaction.reply({ content: statusMsg });
    }

    // 🚪 退出コマンド (/vcleave)
    if (command === 'vcleave') {
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
                for (let i = 1; i <= TOKENS.subs.length; i++) {
                    stopReverseVoiceReceiver(currentGuildId, i);
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

            return interaction.reply({ content: disconnected ? '👋 ボットがすべてのVCから退出しました。' : '❓ 参加していません。' });
        } catch (e) { console.error(e); return interaction.reply({ content: '❌ 退出エラーが発生しました。', ephemeral: true }); }
    }

    // 接続・中継開始コマンド (/setvc)
    if (command === 'setvc') {
        await interaction.deferReply();
        const channelMain = interaction.options.getChannel('main_vc');
        
        const sourceChannels = [];
        for (let i = 1; i <= TOKENS.subs.length; i++) {
            const ch = interaction.options.getChannel(`sub_vc_${i}`);
            if (ch) sourceChannels.push(ch);
        }

        if (sourceChannels.length === 0) {
            return interaction.editReply({ content: '❌ 聴く係Bot用のボイスチャンネルを少なくとも1つ以上指定してください。' });
        }

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

            return interaction.editReply({ content: `接続を完了しました！${vcDetailMsg}` });
        } catch (error) { console.error(error); return interaction.editReply({ content: '❌ 接続エラーが発生しました。' }); }
    }

    // ♻️ 履歴から再接続コマンド (/connect)
    if (command === 'connect') {
        if (!fs.existsSync(CONFIG_FILE)) return interaction.reply({ content: '❌ 履歴なし', ephemeral: true });
        await interaction.deferReply();
        try {
            const configData = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
            const guildConfig = configData[currentGuildId];
            if (!guildConfig) return interaction.editReply({ content: '❌ このサーバーの履歴がありません。' });

            await guild.channels.fetch().catch(() => null);
            const channelMain = guild.channels.cache.get(guildConfig.mainId);
            const sourceChannels = [];
            for (const id of guildConfig.sourceIds) { const ch = guild.channels.cache.get(id); if (ch) sourceChannels.push(ch); }
            if (!channelMain || sourceChannels.length === 0) return interaction.editReply({ content: '❌ チャンネルが見つかりません。' });

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

            return interaction.editReply({ content: `♻️ 前回の設定・音量をロードして中継を再開しました！${vcDetailMsg}` });
        } catch (error) { console.error(error); return interaction.editReply({ content: '❌ 再接続エラー' }); }
    }
    // 🎙️ 逆方向拡声オンコマンド (/vcon)
    if (command === 'vcon') {
        const targetIdxNum = interaction.options.getInteger('bot_number');
        const modeInput = interaction.options.getString('mode') || 'all';
        const isOnlyMode = (modeInput === 'only');

        const connMain = getVoiceConnection(currentGuildId, 'botMain');
        if (!connMain) return interaction.reply({ content: '❌ メインBotがまだVCに参加していません。', ephemeral: true });

        setupReverseVoiceReceiver(connMain, currentGuildId, targetIdxNum, interaction.user.id, isOnlyMode);

        if (isOnlyMode) {
            return interaction.reply({ content: `🎙️ 【オンリーモード】メインBot ➔ 聴く係Bot ${targetIdxNum} への逆方向拡声を開始。**あなたの声だけ**が指定した部屋に流れます。` });
        } else {
            return interaction.reply({ content: `🎙️ 【全員ミキサーモード】メインBot ➔ 聴く係Bot ${targetIdxNum} への逆方向拡声を開始。メインVCにいる**全員の声がミックスされて**指定した部屋に流れます。` });
        }
    }

    // 🔕 逆方向拡声オフコマンド (/vcoff)
    if (command === 'vcoff') {
        const targetIdxNum = interaction.options.getInteger('bot_number');

        stopReverseVoiceReceiver(currentGuildId, targetIdxNum);
        return interaction.reply({ content: `🔕 聴く係Bot ${targetIdxNum} への逆方向拡声を設定解除（オフ）にしました。` });
    }

    // 🎵 音量変更コマンド (/vol)
    if (command === 'vol') {
        const targetIndex = String(interaction.options.getInteger('bot_number'));
        const value = interaction.options.getInteger('percentage');

        if (!guildVolumes.has(currentGuildId)) guildVolumes.set(currentGuildId, new Map());
        guildVolumes.get(currentGuildId).set(targetIndex, value);

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
        return interaction.reply({ content: `🔊 元VC ${targetIndex} の音量を ${value}% に変更しました。(中継ストリームへ即時適用されました)` });
    }
});

clientMain.once('ready', async () => { 
    console.log(`🚀 司令塔Botが正常に起動しました！`); 

    // 🌟 スラッシュコマンドの定義（サーバー管理者が権限設定できる最新の形式にアップデート）
    const commandsData = [
        {
            name: 'status',
            description: '中継システムの現在の稼働ステータスや発言中のユーザーを表示します。'
        },
        {
            name: 'vcleave',
            description: 'ボットをすべてのボイスチャンネルから退出させ、中継を停止します。'
        },
        {
            name: 'connect',
            description: 'config.jsonの履歴から前回の設定と音量をロードして中継を再開します。'
        },
        {
            name: 'setvc',
            description: '中継を開始します。大域（メイン）VCと、聴く係Botが参加する各元VCを指定します。',
            options: [
                {
                    name: 'main_vc',
                    description: 'メイン（大域）Botが参加するボイスチャンネル',
                    type: ApplicationCommandOptionType.Channel,
                    channelTypes: [ChannelType.GuildVoice],
                    required: true
                },
                ...TOKENS.subs.map((_, idx) => ({
                    name: `sub_vc_${idx + 1}`,
                    description: `聴く係Bot ${idx + 1} が参加するボイスチャンネル`,
                    type: ApplicationCommandOptionType.Channel,
                    channelTypes: [ChannelType.GuildVoice],
                    required: idx === 0 // 最初の1つだけ必須、2つ目以降は任意
                }))
            ]
        },
        {
            name: 'vcon',
            description: 'メインVCの音声を指定したサブBotの部屋へ逆方向拡声（中継）します。',
            options: [
                {
                    name: 'bot_number',
                    description: '中継先のサブBot番号 (1, 2, ...)',
                    type: ApplicationCommandOptionType.Integer,
                    required: true
                },
                {
                    name: 'mode',
                    description: '中継モードの選択（デフォルトは全員ミックス）',
                    type: ApplicationCommandOptionType.String,
                    choices: [
                        { name: '全員ミキサー（全員の声を届ける）', value: 'all' },
                        { name: 'オンリーモード（あなたの声だけ届ける）', value: 'only' }
                    ],
                    required: false
                }
            ]
        },
        {
            name: 'vcoff',
            description: '指定したサブBotへの逆方向拡声を解除（オフ）にします。',
            options: [
                {
                    name: 'bot_number',
                    description: '設定を解除するサブBot番号 (1, 2, ...)',
                    type: ApplicationCommandOptionType.Integer,
                    required: true
                }
            ]
        },
        {
            name: 'vol',
            description: '指定した元VCから中継される音声の音量パーセンテージを変更します。',
            options: [
                {
                    name: 'bot_number',
                    description: '音量を変更したい元VCのサブBot番号 (1, 2, ...)',
                    type: ApplicationCommandOptionType.Integer,
                    required: true
                },
                {
                    name: 'percentage',
                    description: '音量パーセンテージ (0〜300%)',
                    type: ApplicationCommandOptionType.Integer,
                    minValue: 0,
                    maxValue: 300,
                    required: true
                }
            ]
        }
    ];

    try {
        console.log('⏳ グローバル・スラッシュコマンドをDiscordへ登録（同期）中...');
        await clientMain.application.commands.set(commandsData);
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