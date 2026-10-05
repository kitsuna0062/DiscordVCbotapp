process.env.NODE_NO_WARNINGS = '1';
const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, StreamType, getVoiceConnection, VoiceConnectionStatus, EndBehaviorType } = require('@discordjs/voice');
const prism = require('prism-media');
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream'); 
const { Mixer } = require('audio-mixer'); // 🌟 オーディオミキサーライブラリを追加

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

const guildPlayers = new Map();       // 各ギルドの各Botプレイヤーを管理する二次元Map
const guildMixers = new Map();        // 各ギルドの各Botマスターミキサーを管理する二次元Map
const guildVolumes = new Map();       // 各ギルドの音量設定
const guildActiveStreams = new Map();  // 各ギルドの稼働中ストリームを管理

/**
 * 🌟 バッファプレッシャー対策版 リソース管理関数
 * 1つの共有プレイヤーではなく、ソースIndex（Bot）ごとに「独立したミキサーとプレイヤー」を生成します。
 */
function getOrCreateGuildResources(guildId, sourceIndex) {
    const idxStr = String(sourceIndex);

    // 1. ギルド用のベースMapがなければ作成
    if (!guildPlayers.has(guildId)) guildPlayers.set(guildId, new Map());
    if (!guildMixers.has(guildId)) guildMixers.set(guildId, new Map());
    if (!guildVolumes.has(guildId)) guildVolumes.set(guildId, new Map());
    if (!guildActiveStreams.has(guildId)) guildActiveStreams.set(guildId, new Map());

    const playersMap = guildPlayers.get(guildId);
    const mixersMap = guildMixers.get(guildId);

    // 2. このBot専用のプレイヤーとマスターミキサーがなければ常時起動モードで作成
    if (!playersMap.has(idxStr)) {
        const player = createAudioPlayer();
        player.on('error', (err) => { 
            if (!err.message.includes('Premature close') && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error(err); 
        });
        playersMap.set(idxStr, player);

        // 🌟 バックプレッシャー（詰まり）を内部で定期クリアする設定のマスターミキサー
        const mixer = new Mixer({
            channels: 2,
            bitDepth: 16,
            sampleRate: 48000,
            clearInterval: 250 
        });
        mixersMap.set(idxStr, mixer);

        // ミキサーの生の音声出力を、途切れることなくプレイヤーに流し続ける
        const mixerResource = createAudioResource(mixer, {
            inputType: StreamType.Raw,
            inlineVolume: false
        });
        player.play(mixerResource);
    }

    return { 
        player: playersMap.get(idxStr),
        mixer: mixersMap.get(idxStr)
    };
}

const createClient = () => new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const clientMain = createClient();
const subClients = [];
/**
 * 🌟 バッファプレッシャー・フリーズ完全対策版 音声受信セットアップ
 */
function setupVoiceReceiver(connection, sourceName, guildId, sourceIndex) {
    const receiver = connection.receiver;
    const { mixer } = getOrCreateGuildResources(guildId, sourceIndex); // このBot専用の常時起動ミキサーを取得
    const activeStreams = guildActiveStreams.get(guildId);

    connection.on(VoiceConnectionStatus.Ready, () => { 
        console.log(`📡 [ギルド: ${guildId} / Bot: ${sourceName}] 受信準備完了。`); 
    });

    // 🌟 誰かが喋り始めたときの処理
    receiver.speaking.on('start', (userId) => {
        const compositeKey = `${sourceIndex}_${userId}`;
        if (activeStreams.has(compositeKey)) return; 
        
        console.log(`🎵 [ギルド: ${guildId} / Bot: ${sourceName}] 音声検知・ミキサー合流: ID ${userId}`);
        
        const opusStream = receiver.subscribe(userId, { 
            end: { behavior: EndBehaviorType.Manual } 
        });
        const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
        const passThrough = new PassThrough({ highWaterMark: 1024 * 16 });

        opusStream.on('error', () => {}); 
        decoder.on('error', () => {});
        passThrough.on('error', () => {});

        // 音声のデコードラインを結合
        opusStream.pipe(decoder).pipe(passThrough);

        // 🌟 対策：ミキサー内部に、このユーザーのこの発言のためだけの「一時的な入力口」を動的作成
        const mixerInput = mixer.makeNewInput({
            channels: 2,
            bitDepth: 16,
            sampleRate: 48000,
            volume: 100 // デフォルト100%
        });

        // 保存されている音量設定を適用
        const volMap = guildVolumes.get(guildId);
        const currentVol = volMap?.get(String(sourceIndex)) ?? 1.0;
        mixerInput.setVolume(currentVol * 100); // 1.0倍なら100%

        // デコードされたストリームを入力口へパイプ結合
        passThrough.pipe(mixerInput);

        // キャッシュパージの際に追えるよう、生成された全てのオブジェクトをマップに記憶
        activeStreams.set(compositeKey, { opusStream, decoder, passThrough, mixerInput });
    });

    // 🌟 話し終えた瞬間の処理（★ここでキャッシュとバッファを跡形もなく完全パージする）
    receiver.speaking.on('end', (userId) => {
        const compositeKey = `${sourceIndex}_${userId}`;
        const streamData = activeStreams.get(compositeKey);
        if (!streamData) return;

        const { opusStream, decoder, passThrough, mixerInput } = streamData;

        // 音声の語尾のプツプツ切れ（クリッピング）を防ぐために80msの極小バッファ猶予を持たせる
        setTimeout(() => {
            try { 
                // ① ストリーム同士のパイプ結合を完全に引き抜く（unpipe）
                passThrough.unpipe(mixerInput);
                decoder.unpipe(passThrough);
                opusStream.unpipe(decoder);

                // ② 🌟 フリーズ対策：ミキサーの親ノードからこの入力口を削除し、完全に破壊する
                mixer.removeInput(mixerInput);
                mixerInput.destroy(); 

                // ③ バックプレッシャーの原因となるNode.jsの内部メモリバッファを強制解放
                passThrough.destroy();
                decoder.destroy(); 
                opusStream.destroy(); 
            } catch(e){
                console.error("🧹 [システム警告] ストリーム解体中にエラーが発生しました:", e);
            }

            activeStreams.delete(compositeKey);
            console.log(`🧹 [ギルド: ${guildId} / Bot: ${sourceName}] ミキサーキャッシュ完全パージ完了。`);
        }, 80);
    });
}

async function findVoiceChannelForce(guild, target) {
    const channels = await guild.channels.fetch().catch(() => null);
    if (!channels) return null;
    return channels.find(c => c && (c.id === target || c.name === target) && (c.type === ChannelType.GuildVoice || c.isVoiceBased()));
}

/**
 * 🌟 接続処理（マルチプレイヤー同時吸い上げ方式）
 */
function connectToVCs(guildId, mainChannel, sourceChannels) {
    // 古い接続を完全にクリーンアップ
    try { getVoiceConnection(guildId, 'botMain')?.destroy(); } catch(e){}
    sourceChannels.forEach((_, index) => { try { getVoiceConnection(guildId, `botSub_${index}`)?.destroy(); } catch(e){} });

    // 大域（Main）Botの接続
    const connMain = joinVoiceChannel({ channelId: mainChannel.id, guildId, adapterCreator: clientMain.guilds.cache.get(guildId).voiceAdapterCreator, group: 'botMain' });
    
    connMain.on(VoiceConnectionStatus.Ready, () => {
        console.log(`🔊 [ギルド: ${guildId}] 大域ライン開通（マルチプレイヤーミキシングパイプ駆動）。`);
        
        // 🌟 修正ポイント：各サブBot（チャンネル）ごとに独立して作ったプレイヤーを、すべてメインBotの通話に同時にアタッチ！
        // Discord.js内部で綺麗にすべての部屋の音が合流（ミックス）して再生されます。
        sourceChannels.forEach((_, index) => {
            const { player } = getOrCreateGuildResources(guildId, index + 1);
            connMain.subscribe(player); 
        });
    });

    // 聴く係（Sub）Botたちの接続とダイレクト受信開始
    sourceChannels.forEach((channel, index) => {
        const clientSub = subClients[index];
        if (!clientSub) return;
        const connSub = joinVoiceChannel({ channelId: channel.id, guildId, adapterCreator: clientSub.guilds.cache.get(guildId).voiceAdapterCreator, selfMute: false, selfDeaf: false, group: `botSub_${index}` });
        setupVoiceReceiver(connSub, `Sub_${index + 1}`, guildId, index + 1);
    });
}
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

        // 🌟 ミキサー入力へのリアルタイム音量反映
        const activeStreams = guildActiveStreams.get(currentGuildId);
        if (activeStreams) {
            for (const [key, streamData] of activeStreams.entries()) {
                if (key.startsWith(`${targetIndex}_`)) {
                    // mixerInputの音量を更新 (1.0倍なら100)
                    streamData.mixerInput.setVolume(value * 100);
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
        return message.reply(`🔊 元VC ${targetIndex} の音量を ${value}倍 に変更しました。(ミキサーへ即時適用されました)`);
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

            // 🌟 プレイヤーとミキサーのマップキャッシュをクリーンアップ
            if (guildPlayers.has(currentGuildId)) guildPlayers.delete(currentGuildId);
            if (guildMixers.has(currentGuildId)) guildMixers.delete(currentGuildId);
            
            // 🌟 稼働中ストリームの完全一斉物理解体
            const activeStreams = guildActiveStreams.get(currentGuildId);
            if (activeStreams) {
                for (const streamData of activeStreams.values()) {
                    try {
                        streamData.passThrough.unpipe(streamData.mixerInput);
                        streamData.decoder.unpipe(streamData.passThrough);
                        streamData.opusStream.unpipe(streamData.decoder);
                        
                        streamData.mixerInput.destroy();
                        streamData.passThrough.destroy();
                        streamData.decoder.destroy();
                        streamData.opusStream.destroy();
                    } catch(e){}
                }
                activeStreams.clear();
            }

            message.reply(disconnected ? '👋 ボットがすべてのVCから退出しました。残存キャッシュとバッファを完全に消去しました。' : '❓ 参加していません。');
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

            let vcDetailMsg = `\n\n📌 **【接続チャンネル詳細 / ミキサー駆動】**\n・📢 大域Bot (Main) ➔ <#${channelMain.id}>`;
            sourceChannels.forEach((ch, idx) => {
                const v = volMap.get(String(idx + 1)) ?? 1.0;
                vcDetailMsg += `\n・🎧 聴く係Bot ${idx + 1} ➔ <#${ch.id}> (音量: **${v}倍**)`;
            });

            message.reply(`✅ 各部屋の独立ミキサー中継を開始しました！${vcDetailMsg}`);
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

            let vcDetailMsg = `\n\n📌 **【接続チャンネル詳細 / ミキサー駆動】**\n・📢 大域Bot (Main) ➔ <#${channelMain.id}>`;
            sourceChannels.forEach((ch, idx) => {
                const v = volMap.get(String(idx + 1)) ?? 1.0;
                vcDetailMsg += `\n・🎧 聴く係Bot ${idx + 1} ➔ <#${ch.id}> (音量: **${v}倍**)`;
            });

            message.reply(`♻️ 前回の設定・音量をロードして中継を再開しました！${vcDetailMsg}`);
        } catch (error) { console.error(error); message.reply('❌ 再接続エラー'); }
    }
});

clientMain.once('ready', () => { console.log(`🚀 司令塔Botが正常に起動しました！`); });
process.on('uncaughtException', (err) => { if (!err.message.includes('Premature close') && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error(' [システム警告]:', err); });

(async () => {
    try {
        if (!TOKENS.botMain || TOKENS.subs.length === 0) { console.error('❌ 環境変数が空です。'); return; }

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
            subClient.once('ready', () => { console.log(`✅ 聴く係Bot_${i + 1} オンライン。`); });
            
            await subClient.login(TOKENS.subs[i]);
            subClients.push(subClient);
        }
        console.log(`🚀 すべてのBot（合計 ${subClients.length + 1} 台）が正常に起動しました！ミキサーコア稼働準備完了。`);
    } catch (err) { console.error('❌ ログイン接続エラー:', err); }
})();
