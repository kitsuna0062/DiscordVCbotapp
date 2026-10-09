process.env.NODE_NO_WARNINGS = '1';
const { Client, GatewayIntentBits, ChannelType, SlashCommandBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, StreamType, getVoiceConnection, VoiceConnectionStatus, EndBehaviorType } = require('@discordjs/voice');
const prism = require('prism-media');
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream'); 
const { PcmMixer } = require('./pcm-mixer');

// ==========================================
// 🌟 環境変数トークンの読み込み
// ==========================================
const TOKENS = {
    botMain: process.env.DISCORD_TOKEN_MAIN,
    subs: Object.keys(process.env)
        // 1. 環境変数のうち、名前が「DISCORD_TOKEN_SUB_」で始まるものだけを抜き出す
        .filter(key => key.startsWith('DISCORD_TOKEN_SUB_'))
        // 2. その環境変数の「値（トークン文字列）」の配列に変換する
        .map(key => process.env[key])
        // 3. 空文字や未定義のものを除外する
        .filter(t => t && t !== '')
};


const CONFIG_FILE = path.join(__dirname, 'config.json');

const guildPlayers = new Map();       // 各ギルドの各Botプレイヤーを個別に管理する二次元Map
const guildVolumes = new Map();       // 各ギルドの音量設定（100ベースの%値）
const guildActiveStreams = new Map();  // 各ギルドの稼働中ストリームを管理
const guildReverseStreams = new Map(); // 逆方向（メイン -> サブ）の中継ストリームを管理するマップ
const guildMixers = new Map();
const guildReverseMixers = new Map();

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

function monitorVoiceConnection(connection, label) {
    connection.on('stateChange', (oldState, newState) => {
        console.log(`[${label}] VC接続状態: ${oldState.status} -> ${newState.status}`);
    });
    connection.on('error', error => {
        console.error(`[${label}] VC接続エラー:`, error);
    });
}

function waitForVoiceReady(connection, label, timeoutMs = 45000) {
    if (connection.state.status === VoiceConnectionStatus.Ready) return Promise.resolve();

    return new Promise((resolve, reject) => {
        const cleanup = () => {
            clearTimeout(timeout);
            connection.off('stateChange', onStateChange);
            connection.off('error', onError);
        };
        const onError = error => {
            cleanup();
            reject(new Error(`${label} のVC接続中にエラーが発生しました: ${error.message}`, { cause: error }));
        };
        const onStateChange = (_oldState, newState) => {
            if (newState.status === VoiceConnectionStatus.Ready) {
                cleanup();
                const { ws, udp } = connection.ping;
                console.log(`[${label}] VC接続完了 (WebSocket ping: ${ws ?? '未計測'} ms, UDP ping: ${udp ?? '未計測'} ms)`);
                resolve();
            } else if (newState.status === VoiceConnectionStatus.Destroyed) {
                cleanup();
                reject(new Error(`${label} のVC接続が破棄されました。`));
            }
        };
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error(`${label} が${timeoutMs / 1000}秒以内にReadyになりませんでした (現在: ${connection.state.status})。ホストのUDP通信、BotのVC権限、Discord側のVC状態を確認してください。`));
        }, timeoutMs);
        connection.on('stateChange', onStateChange);
        connection.on('error', onError);
    });
}

const createClient = () => new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildVoiceStates
    ]
});

const clientMain = createClient();
const subClients = []; // 💡 起動時にインデックス順に美しく詰め込まれる実績のあるグローバル配列
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

        const volMap = guildVolumes.get(guildId);
        const currentVolPercent = volMap?.get(String(sourceIndex)) ?? 100;
        const mixer = guildMixers.get(guildId);
        if (!mixer) {
            opusStream.destroy();
            decoder.destroy();
            passThrough.destroy();
            console.error(`[ギルド: ${guildId}] 出力ミキサーがありません。先に /setvc を実行してください。`);
            return;
        }
        mixer.addSource(compositeKey, passThrough, currentVolPercent / 100);
        activeStreams.set(compositeKey, { opusStream, decoder, passThrough, mixer, mixerKey: compositeKey });
    });

    receiver.speaking.on('end', (userId) => {
        const compositeKey = `${sourceIndex}_${userId}`;
        const streamData = activeStreams.get(compositeKey);
        if (!streamData) return;

        const { opusStream, decoder, passThrough, mixer, mixerKey } = streamData;

        setTimeout(() => {
            try { 
                mixer?.removeSource(mixerKey);
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
    if (!guildReverseMixers.has(guildId)) guildReverseMixers.set(guildId, new Map());
    
    if (reverseMap.has(targetSubIndex)) {
        stopReverseVoiceReceiver(guildId, targetSubIndex);
    }

    const connSub = getVoiceConnection(guildId, `botSub_${targetSubIndex - 1}`);
    if (!connSub) throw new Error(`サブBot ${targetSubIndex} がボイスチャンネルに接続していません。`);
    const mixer = new PcmMixer();
    const player = createAudioPlayer();
    player.on('error', error => console.error(`[ギルド: ${guildId} / サブBot ${targetSubIndex}] 音声出力エラー:`, error));
    connSub.subscribe(player);
    player.play(createAudioResource(mixer.output, { inputType: StreamType.Raw }));
    guildReverseMixers.get(guildId).set(targetSubIndex, { mixer, player });

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

        const targetMixer = guildReverseMixers.get(guildId)?.get(targetSubIndex)?.mixer;
        if (targetMixer) {
            targetMixer.addSource(streamKey, passThrough);
        } else {
            opusStream.destroy();
            decoder.destroy();
            passThrough.destroy();
            console.error(`[ギルド: ${guildId}] サブBot ${targetSubIndex} の逆方向出力ミキサーがありません。`);
            return;
        }

        reverseMap.set(streamKey, { opusStream, decoder, passThrough, mixer: targetMixer, mixerKey: streamKey });
    };

    const endHandler = (userId) => {
        if (isOnly && userId !== speakerUserId) return;
        const streamKey = `reverse_${targetSubIndex}_${userId}`;
        const streamData = reverseMap.get(streamKey);
        if (!streamData) return;

        const { opusStream, decoder, passThrough, mixer, mixerKey } = streamData;
        setTimeout(() => {
            try {
                mixer?.removeSource(mixerKey);
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
    const reverseOutput = guildReverseMixers.get(guildId)?.get(targetSubIndex);
    reverseOutput?.player.stop(true);
    reverseOutput?.mixer.destroy();
    guildReverseMixers.get(guildId)?.delete(targetSubIndex);

    for (const [key, streamData] of reverseMap.entries()) {
        if (key.startsWith(`reverse_${targetSubIndex}_`)) {
            try {
                streamData.mixer?.removeSource(streamData.mixerKey);
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
 * 🌟 接続処理（受信音声をミキサー経由でメインBotへ中継）
 */
async function connectToVCs(guildId, mainChannel, sourceChannels) {
    const existingReverseStreams = guildReverseStreams.get(guildId);
    if (existingReverseStreams) {
        for (const key of existingReverseStreams.keys()) {
            if (typeof key === 'number') stopReverseVoiceReceiver(guildId, key);
        }
    }
    const existingActiveStreams = guildActiveStreams.get(guildId);
    if (existingActiveStreams) {
        for (const streamData of existingActiveStreams.values()) {
            streamData.mixer?.removeSource(streamData.mixerKey);
            streamData.passThrough.destroy();
            streamData.decoder.destroy();
            streamData.opusStream.destroy();
        }
        existingActiveStreams.clear();
    }
    const existingPlayer = guildPlayers.get(guildId)?.get('0');
    existingPlayer?.stop(true);
    guildMixers.get(guildId)?.destroy();

    try { getVoiceConnection(guildId, 'botMain')?.destroy(); } catch(e){}
    sourceChannels.forEach((_, index) => { try { getVoiceConnection(guildId, `botSub_${index}`)?.destroy(); } catch(e){} });

    getOrCreateGuildResources(guildId, 0);
    const connMain = joinVoiceChannel({
        channelId: mainChannel.id, 
        guildId, 
        adapterCreator: clientMain.guilds.cache.get(guildId).voiceAdapterCreator, 
        selfMute: false, 
        selfDeaf: false, 
        group: 'botMain',
        debug: process.env.VOICE_DEBUG === 'true'
    });
    monitorVoiceConnection(connMain, `ギルド ${guildId} / Main`);
    const connections = [{ connection: connMain, label: `ギルド ${guildId} / Main` }];
    
    const { player: mainPlayer } = getOrCreateGuildResources(guildId, 0);
    connMain.subscribe(mainPlayer);
    const mainMixer = new PcmMixer();
    guildMixers.set(guildId, mainMixer);
    mainPlayer.play(createAudioResource(mainMixer.output, { inputType: StreamType.Raw }));

    try {
        for (const [index, channel] of sourceChannels.entries()) {
            const clientSub = subClients[index];
            if (!clientSub) {
                throw new Error(`聴く係Bot_${index + 1} のクライアントがログインしていません。`);
            }

            console.log(`🔎 聴く係Bot_${index + 1} のサーバー情報を取得中...`);
            const targetGuild = await clientSub.guilds.fetch(guildId);

            console.log(`🔊 聴く係Bot_${index + 1} がボイスチャンネル [${channel.name}] (${channel.id}) への接続を開始します。`);

            const connSub = joinVoiceChannel({
                channelId: channel.id,
                guildId,
                adapterCreator: targetGuild.voiceAdapterCreator,
                selfMute: false,
                selfDeaf: false,
                group: `botSub_${index}`,
                debug: process.env.VOICE_DEBUG === 'true'
            });
            const subLabel = `ギルド ${guildId} / Sub_${index + 1}`;
            monitorVoiceConnection(connSub, subLabel);
            connections.push({ connection: connSub, label: subLabel });
            setupVoiceReceiverForMain(connSub, `Sub_${index + 1}`, guildId, index + 1, connMain);
        }

        await Promise.all(connections.map(({ connection, label }) => waitForVoiceReady(connection, label)));
    } catch (error) {
        for (const { connection } of connections) connection.destroy();
        mainPlayer.stop(true);
        mainMixer.destroy();
        guildMixers.delete(guildId);
        throw error;
    }
    console.log(`🔊 [ギルド: ${guildId}] すべてのBotがVCに接続し、音声中継を開始できます。`);
}
const setVcCommand = new SlashCommandBuilder()
    .setName('setvc')
    .setDescription('中継するメインVCと元VCを設定します')
    .addChannelOption(option => option.setName('main').setDescription('メインVC').addChannelTypes(ChannelType.GuildVoice).setRequired(true));

for (let index = 0; index < TOKENS.subs.length; index++) {
    setVcCommand.addChannelOption(option => option
        .setName(`source${index + 1}`)
        .setDescription(`元VC ${index + 1}`)
        .addChannelTypes(ChannelType.GuildVoice)
        .setRequired(index === 0));
}

const commandDefinitions = [
    setVcCommand,
    new SlashCommandBuilder().setName('connect').setDescription('保存済みの設定でVC中継を再開します'),
    new SlashCommandBuilder().setName('vcleave').setDescription('すべてのBotをVCから退出させます'),
    new SlashCommandBuilder()
        .setName('vcon')
        .setDescription('メインVCの音声を元VCへ中継します')
        .addIntegerOption(option => option.setName('number').setDescription('元VCの番号').setMinValue(1).setMaxValue(Math.max(TOKENS.subs.length, 1)).setRequired(true))
        .addBooleanOption(option => option.setName('only').setDescription('自分の音声だけを中継する')),
    new SlashCommandBuilder()
        .setName('vcononly')
        .setDescription('自分の音声だけを元VCへ中継します')
        .addIntegerOption(option => option.setName('number').setDescription('元VCの番号').setMinValue(1).setMaxValue(Math.max(TOKENS.subs.length, 1)).setRequired(true)),
    new SlashCommandBuilder()
        .setName('vcoff')
        .setDescription('元VCへの逆方向中継を停止します')
        .addIntegerOption(option => option.setName('number').setDescription('元VCの番号').setMinValue(1).setMaxValue(Math.max(TOKENS.subs.length, 1)).setRequired(true)),
    new SlashCommandBuilder()
        .setName('vol')
        .setDescription('元VCの中継音量を設定します')
        .addIntegerOption(option => option.setName('number').setDescription('元VCの番号').setMinValue(1).setMaxValue(Math.max(TOKENS.subs.length, 1)).setRequired(true))
        .addIntegerOption(option => option.setName('volume').setDescription('音量（%）').setMinValue(0).setMaxValue(300).setRequired(true)),
    new SlashCommandBuilder().setName('status').setDescription('このサーバーのBotとVC接続状態を表示します')
];

function makeVoiceChannelSummary(guildId, mainChannel, sourceChannels) {
    let summary = `\n\n📌 **【接続チャンネル詳細】**\n・📢 メインBot ➔ <#${mainChannel.id}>`;
    const volumeMap = guildVolumes.get(guildId);
    sourceChannels.forEach((channel, index) => {
        const volume = volumeMap?.get(String(index + 1)) ?? 100;
        summary += `\n・🎧 サブBot ${index + 1} ➔ <#${channel.id}> (音量: **${volume}%**)`;
    });
    return summary;
}

clientMain.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand() || !interaction.guild) return;

    const guildId = interaction.guildId;
    const guild = interaction.guild;
    const command = interaction.commandName;
    let deferred = false;

    try {
        await interaction.deferReply();
        deferred = true;
        const respond = content => interaction.editReply(content);

        if (command === 'status') {
            const mainConnection = getVoiceConnection(guildId, 'botMain');
            const lines = [
                `🤖 **Bot状態**`,
                `・メインBot: ${clientMain.isReady() ? 'オンライン' : 'オフライン'}${mainConnection ? ` / ${mainConnection.state.status} (<#${mainConnection.joinConfig.channelId}>)` : ' / VC未接続'}`
            ];
            for (let index = 0; index < TOKENS.subs.length; index++) {
                const connection = getVoiceConnection(guildId, `botSub_${index}`);
                const subClient = subClients[index];
                lines.push(`・サブBot ${index + 1}: ${subClient?.isReady() ? 'オンライン' : 'オフライン'}${connection ? ` / ${connection.state.status} (<#${connection.joinConfig.channelId}>)` : ' / VC未接続'}`);
            }
            const activeSourceCount = guildActiveStreams.get(guildId)?.size ?? 0;
            lines.push(`・受信中の音声ストリーム: ${activeSourceCount}`);
            return await respond(lines.join('\n'));
        }

        if (command === 'vcoff') {
            const targetIndex = interaction.options.getInteger('number', true);
            if (targetIndex > TOKENS.subs.length) return await respond(`❌ サブBot番号は1〜${TOKENS.subs.length}の範囲で指定してください。`);
            stopReverseVoiceReceiver(guildId, targetIndex);
            return await respond(`🔕 聴く係Bot ${targetIndex} への逆方向拡声を設定解除（オフ）にしました。`);
        }

        if (command === 'vcon' || command === 'vcononly') {
            const targetIndex = interaction.options.getInteger('number', true);
            if (targetIndex > TOKENS.subs.length) return await respond(`❌ サブBot番号は1〜${TOKENS.subs.length}の範囲で指定してください。`);
            const mainConnection = getVoiceConnection(guildId, 'botMain');
            if (!mainConnection) return await respond('❌ メインBotがまだVCに参加していません。');

            const isOnlyMode = command === 'vcononly' || interaction.options.getBoolean('only') === true;
            try {
                setupReverseVoiceReceiver(mainConnection, guildId, targetIndex, interaction.user.id, isOnlyMode);
            } catch (error) {
                console.error(`[ギルド: ${guildId}] 逆方向中継の開始に失敗しました:`, error);
                return await respond(`❌ 逆方向中継を開始できませんでした: ${error.message}`);
            }

            return await respond(isOnlyMode
                ? `🎙️ 【オンリーモード】メインBot ➔ 聴く係Bot ${targetIndex} への逆方向拡声を開始。**あなたの声だけ**が指定した部屋に流れます。`
                : `🎙️ 【全員ミキサーモード】メインBot ➔ 聴く係Bot ${targetIndex} への逆方向拡声を開始。メインVCにいる**全員の声がミックスされて**指定した部屋に流れます。`);
        }

        if (command === 'vol') {
            const targetIndex = interaction.options.getInteger('number', true);
            const value = interaction.options.getInteger('volume', true);
            if (targetIndex > TOKENS.subs.length) return await respond(`❌ サブBot番号は1〜${TOKENS.subs.length}の範囲で指定してください。`);

            if (!guildVolumes.has(guildId)) guildVolumes.set(guildId, new Map());
            guildVolumes.get(guildId).set(String(targetIndex), value);

            const activeStreams = guildActiveStreams.get(guildId);
            if (activeStreams) {
                for (const [key, streamData] of activeStreams.entries()) {
                    if (key.startsWith(`${targetIndex}_`)) {
                        streamData.mixer.setSourceVolume(streamData.mixerKey, value / 100);
                    }
                }
            }

            try {
                const configData = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) : {};
                if (!configData[guildId]) configData[guildId] = {};
                if (!configData[guildId].volumes) configData[guildId].volumes = {};
                configData[guildId].volumes[targetIndex] = value;
                fs.writeFileSync(CONFIG_FILE, JSON.stringify(configData, null, 2));
            } catch (error) {
                console.error(`[ギルド: ${guildId}] 音量設定の保存に失敗しました:`, error);
                return await respond(`❌ 音量は変更しましたが、設定ファイルへの保存に失敗しました: ${error.message}`);
            }
            return await respond(`🔊 元VC ${targetIndex} の音量を ${value}% に変更しました。(中継ストリームへ即時適用されました)`);
        }

        if (command === 'vcleave') {
            let disconnected = false;
            const mainConnection = getVoiceConnection(guildId, 'botMain');
            if (mainConnection) { mainConnection.destroy(); disconnected = true; }
            guildPlayers.get(guildId)?.get('0')?.stop(true);
            for (let index = 0; index < TOKENS.subs.length; index++) {
                const connection = getVoiceConnection(guildId, `botSub_${index}`);
                if (connection) { connection.destroy(); disconnected = true; }
            }

            guildMixers.get(guildId)?.destroy();
            guildMixers.delete(guildId);
            const reverseOutputs = guildReverseMixers.get(guildId);
            if (reverseOutputs) {
                for (const { mixer, player } of reverseOutputs.values()) {
                    player.stop(true);
                    mixer.destroy();
                }
                guildReverseMixers.delete(guildId);
            }
            guildPlayers.delete(guildId);

            const reverseMap = guildReverseStreams.get(guildId);
            if (reverseMap) {
                for (const key of reverseMap.keys()) {
                    if (typeof key === 'number') stopReverseVoiceReceiver(guildId, key);
                }
                guildReverseStreams.delete(guildId);
            }

            const activeStreams = guildActiveStreams.get(guildId);
            if (activeStreams) {
                for (const streamData of activeStreams.values()) {
                    try {
                        streamData.mixer?.removeSource(streamData.mixerKey);
                        streamData.decoder.unpipe(streamData.passThrough);
                        streamData.opusStream.unpipe(streamData.decoder);
                        streamData.passThrough.destroy();
                        streamData.decoder.destroy();
                        streamData.opusStream.destroy();
                    } catch (error) {
                        console.error(`[ギルド: ${guildId}] 中継ストリームの解放に失敗しました:`, error);
                    }
                }
                activeStreams.clear();
            }
            return await respond(disconnected ? '👋 ボットがすべてのVCから退出しました。' : '❓ 参加していません。');
        }

        if (command === 'setvc') {
            const mainChannel = interaction.options.getChannel('main', true);
            const sourceChannels = [];
            let missingSource = false;
            for (let index = 0; index < TOKENS.subs.length; index++) {
                const channel = interaction.options.getChannel(`source${index + 1}`);
                if (!channel) {
                    missingSource = true;
                    continue;
                }
                if (missingSource) return await respond('❌ 元VCは番号の小さい順に、連続して指定してください。');
                sourceChannels.push(channel);
            }
            if (sourceChannels.length === 0) return await respond('❌ 元VCを1つ以上指定してください。');
            if (mainChannel.type !== ChannelType.GuildVoice || sourceChannels.some(channel => channel.type !== ChannelType.GuildVoice)) {
                return await respond('❌ メインVCと元VCには通常のボイスチャンネルを指定してください。');
            }

            console.log(`🔍 接続先 - メインVC: [${mainChannel.name}], 元VC群: [${sourceChannels.map(channel => channel.name).join(', ')}]`);
            try {
                await connectToVCs(guildId, mainChannel, sourceChannels);
                const configData = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) : {};
                configData[guildId] = {
                    mainId: mainChannel.id,
                    sourceIds: sourceChannels.map(channel => channel.id),
                    volumes: configData[guildId]?.volumes || {}
                };
                fs.writeFileSync(CONFIG_FILE, JSON.stringify(configData, null, 2));

                if (!guildVolumes.has(guildId)) guildVolumes.set(guildId, new Map());
                return await respond(`✅ **中継接続ラインを開通しました！**${makeVoiceChannelSummary(guildId, mainChannel, sourceChannels)}`);
            } catch (error) {
                console.error(`[ギルド: ${guildId}] 接続エラー:`, error);
                return await respond(`❌ VC接続エラー: ${error.message}`);
            }
        }

        if (command === 'connect') {
            try {
                if (!fs.existsSync(CONFIG_FILE)) return await respond('❌ 履歴なし');
                const configData = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
                const guildConfig = configData[guildId];
                if (!guildConfig) return await respond('❌ このサーバーの履歴がありません。');

                await guild.channels.fetch();
                const mainChannel = guild.channels.cache.get(guildConfig.mainId);
                const sourceChannels = guildConfig.sourceIds
                    .map(id => guild.channels.cache.get(id))
                    .filter(channel => channel?.type === ChannelType.GuildVoice);
                if (mainChannel?.type !== ChannelType.GuildVoice || sourceChannels.length === 0) {
                    return await respond('❌ チャンネルが見つかりません。');
                }

                if (!guildVolumes.has(guildId)) guildVolumes.set(guildId, new Map());
                const volumeMap = guildVolumes.get(guildId);
                for (const [index, volume] of Object.entries(guildConfig.volumes || {})) {
                    volumeMap.set(String(index), volume);
                }
                await connectToVCs(guildId, mainChannel, sourceChannels);
                return await respond(`♻️ 前回の設定・音量をロードして中継を再開しました！${makeVoiceChannelSummary(guildId, mainChannel, sourceChannels)}`);
            } catch (error) {
                console.error(`[ギルド: ${guildId}] 再接続エラー:`, error);
                return await respond(`❌ 再接続エラー: ${error.message}`);
            }
        }
    } catch (error) {
        console.error(`[ギルド: ${guildId}] /${command} の処理に失敗しました:`, error);
        const response = `❌ コマンド処理中にエラーが発生しました: ${error.message}`;
        if (deferred || interaction.deferred || interaction.replied) {
            await interaction.editReply(response).catch(replyError => console.error('コマンドエラーの返信に失敗しました:', replyError));
        } else {
            await interaction.reply({ content: response, ephemeral: true }).catch(replyError => console.error('コマンドエラーの返信に失敗しました:', replyError));
        }
    }
});

clientMain.once('ready', async () => {
    try {
        await clientMain.application.commands.set(commandDefinitions.map(command => command.toJSON()));
        console.log('✅ Slash Commandを登録しました。');
    } catch (error) {
        console.error('❌ Slash Commandの登録に失敗しました:', error);
    }
    console.log(`🚀 司令塔Botが正常に起動しました！`);
});

process.on('uncaughtException', (err) => { 
    if (!err.message.includes('Premature close') && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        console.error(' [システム警告]:', err); 
    }
});

// 🌟 【本物の事前起動プロセス】起動と同時にあらかじめ全Botを同期させて subClients に格納
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
            subClients.push(subClient); // 💡 確実に事前にインデックス順に詰め込まれます
        }
        console.log(`🚀 すべてのBot（合計 ${subClients.length + 1} 台）が正常に起動しました！同時購読中継システム稼働準備完了。`);
    } catch (err) { 
        console.error('❌ ログイン接続エラー:', err); 
    }
})();
