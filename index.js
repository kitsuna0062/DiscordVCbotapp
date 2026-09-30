// --- ここから生存確認（Ping）用の簡易Webサーバー設定 ---
const http = require('http');
const port = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Server is running!');
}).listen(port, () => {
  console.log(`Listening on port ${port}`);
});

process.env.NODE_NO_WARNINGS = '1';
const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, StreamType, getVoiceConnection, VoiceConnectionStatus } = require('@discordjs/voice');
const { Transform, Readable } = require('stream');
const prism = require('prism-media');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');

// --- ⚙️ 完全サーバー仕様：OSの環境変数（process.env）から直接読み込む ----------------
const TOKENS = {
    botMain: process.env.DISCORD_TOKEN_MAIN,
    botB: process.env.DISCORD_TOKEN_B,
    botA: process.env.DISCORD_TOKEN_A
};
// ---------------------------------------------------------------------

const CONFIG_FILE = path.join(__dirname, 'config.json');

// リアルタイム直結ミキサー
class AudioMixer extends Readable {
    constructor() {
        super();
        this.bufferA = Buffer.alloc(0);
        this.bufferB = Buffer.alloc(0);
        this.frameSize = 3840;
        this.maxBufferSize = this.frameSize * 5;
        setInterval(() => this.generateFrame(), 20);
    }
    pushChunk(source, chunk) {
        if (source === 'A') {
            this.bufferA = Buffer.concat([this.bufferA, chunk]);
            if (this.bufferA.length > this.maxBufferSize) {
            	this.bufferA = this.bufferA.subarray(this.bufferA.length - this.maxBufferSize);
        	}
        }
        if (source === 'B') {
            this.bufferB = Buffer.concat([this.bufferB, chunk]);
            if (this.bufferB.length > this.maxBufferSize) {
            	this.bufferB = this.bufferB.subarray(this.bufferB.length - this.maxBufferSize);
        	}
        }
    }
    generateFrame() {
        // どちらのバッファにもデータがない場合は、完全に無音を流す
        if (this.bufferA.length === 0 && this.bufferB.length === 0) {
            this.push(Buffer.alloc(this.frameSize));
            return;
        }

        const chunkA = this.bufferA.subarray(0, this.frameSize);
        const chunkB = this.bufferB.subarray(0, this.frameSize);
        const mixed = Buffer.alloc(this.frameSize);

        for (let i = 0; i < this.frameSize; i += 2) {
            let sampleA = i < chunkA.length ? chunkA.readInt16LE(i) : 0;
            let sampleB = i < chunkB.length ? chunkB.readInt16LE(i) : 0;
            
            let mixedSample = sampleA + sampleB;
            if (mixedSample > 32767) mixedSample = 32767;
            if (mixedSample < -32768) mixedSample = -32768;
            
            mixed.writeInt16LE(mixedSample, i);
        }

        this.push(mixed);

        // 消費した分をバッファから削除
        this.bufferA = this.bufferA.subarray(chunkA.length);
        this.bufferB = this.bufferB.subarray(chunkB.length);
    }
    _read() {}
}
const mixer = new AudioMixer();
const playerMain = createAudioPlayer();

playerMain.on('error', (err) => {
    if (err.message.includes('Premature close') || err.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
    console.error('[大域Botプレイヤー警告]:', err);
});

const createClient = () => new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const clientA = createClient();
const clientB = createClient();
const clientMain = createClient();
function setupVoiceReceiver(connection, sourceName) {
    const receiver = connection.receiver;
    const activeStreams = new Map();
    
    const POST_SILENCE_MS = 400;
    const silenceBytes = Math.floor((48000 * 2 * 2 * POST_SILENCE_MS) / 1000);
    const flushSilenceBuffer = Buffer.alloc(silenceBytes);

    connection.on(VoiceConnectionStatus.Ready, () => {
        console.log(`📡 [Bot${sourceName}] 接続確立。リアルタイム受信スタンバイ。`);
    });

    receiver.speaking.on('start', (userId) => {
        if (activeStreams.has(userId)) return;
        console.log(`🎵 [Bot${sourceName}] 音声検知: ID ${userId}`);

        const opusStream = receiver.subscribe(userId, { end: { behavior: 'afterSilence', duration: 0 } });
        
        // ffmpegの引数をリアルタイム配信用に最適化
	const ffmpegProcess = spawn(ffmpegPath, [
	    '-loglevel', 'quiet',               // ログ出力を抑制して処理軽量化
	    '-noautorotate',                    // 余計な処理の無効化
	    '-fflags', 'nobuffer+flush_packets',// バッファリングを極限までオフ
	    '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0',
	    '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'
	], { stdio: ['pipe', 'pipe', 'ignore'] });


        activeStreams.set(userId, { opusStream, ffmpegProcess });
        
        const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
        
        opusStream.on('error', (err) => { if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error(err); });
        decoder.on('error', (err) => { if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error(err); });

        opusStream.pipe(decoder).pipe(ffmpegProcess.stdin).on('error', () => {});

        ffmpegProcess.stdout.on('data', (chunk) => {
            mixer.pushChunk(sourceName, chunk);
        });

        ffmpegProcess.on('error', () => {});
        ffmpegProcess.stdin.on('error', () => {});
        ffmpegProcess.stdout.on('error', () => {});

        const cleanup = () => {
            if (activeStreams.has(userId)) {
                try { ffmpegProcess.kill(); } catch(e){}
                try { decoder.destroy(); } catch(e){}
                try { opusStream.destroy(); } catch(e){}
                activeStreams.delete(userId);
                
                mixer.pushChunk(sourceName, flushSilenceBuffer);
                console.log(`🧹 [Bot${sourceName}] ストリームリセット（無音パディングによるバッファ押し流し完了）`);
            }
        };

        opusStream.on('end', cleanup);
        opusStream.on('error', cleanup);
    });
}

async function findVoiceChannelForce(guild, target) {
    const channels = await guild.channels.fetch().catch(() => null);
    if (!channels) return null;
    return channels.find(c => c && (c.id === target || c.name === target) && (c.type === ChannelType.GuildVoice || c.isVoiceBased()));
}

function connectToVCs(guildId, mainChannel, vcaChannel, vcbChannel) {
    try { getVoiceConnection(guildId, 'botA')?.destroy(); } catch(e){}
    try { getVoiceConnection(guildId, 'botB')?.destroy(); } catch(e){}
    try { getVoiceConnection(guildId, 'botMain')?.destroy(); } catch(e){}

    const connA = joinVoiceChannel({ channelId: vcaChannel.id, guildId, adapterCreator: clientA.guilds.cache.get(guildId).voiceAdapterCreator, selfMute: false, selfDeaf: false, group: 'botA' });
    setupVoiceReceiver(connA, 'A');

    const connB = joinVoiceChannel({ channelId: vcbChannel.id, guildId, adapterCreator: clientB.guilds.cache.get(guildId).voiceAdapterCreator, selfMute: false, selfDeaf: false, group: 'botB' });
    setupVoiceReceiver(connB, 'B');

    const connMain = joinVoiceChannel({ channelId: mainChannel.id, guildId, adapterCreator: clientMain.guilds.cache.get(guildId).voiceAdapterCreator, group: 'botMain' });
    connMain.on(VoiceConnectionStatus.Ready, () => {
        console.log(`🔊 [大域Bot] 送信ライン開通。リアルタイム中継を開始します。`);
        const resource = createAudioResource(mixer, { inputType: StreamType.Raw, inlineVolume: true });
        connMain.subscribe(playerMain);
        playerMain.play(resource);
    });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ guildId, mainId: mainChannel.id, vcaId: vcaChannel.id, vcbId: vcbChannel.id }, null, 2));
}

clientMain.on('messageCreate', async (message) => {
    if (message.author.bot || (!message.content.startsWith('!setvc') && message.content !== '!connect' && message.content !== '!vcleave')) return;
    const currentGuildId = message.guildId;
    const guild = clientMain.guilds.cache.get(currentGuildId);
    if (!guild) return;

    if (message.content === '!vcleave') {
        try {
            let disconnected = false;
            ['botMain', 'botA', 'botB'].forEach(g => { const c = getVoiceConnection(currentGuildId, g); if (c) { c.destroy(); disconnected = true; } });
            message.reply(disconnected ? '👋 すべてのボットがボイスチャンネルから退出しました。' : '❓ ボットは参加していません。');
        } catch (e) { console.error(e); message.reply('❌ 退出エラー'); }
        return;
    }
    if (message.content.startsWith('!setvc')) {
        const args = message.content.split(' ');
        if (args.length < 4) return message.reply('❌ 使用法: `!setvc [大域VC] [VCa] [VCb]`');
        const [_, targetMain, targetA, targetB] = args;
        message.channel.sendTyping();
        const channelMain = await findVoiceChannelForce(guild, targetMain);
        const channelA = await findVoiceChannelForce(guild, targetA);
        const channelB = await findVoiceChannelForce(guild, targetB);
        if (!channelMain || !channelA || !channelB) return message.reply('❌ VC紛失');
        try { connectToVCs(currentGuildId, channelMain, channelA, channelB); message.reply('✅ 中継を開始しました！'); } catch (e) { console.error(e); message.reply('❌ 接続エラー'); }
    }
    if (message.content === '!connect') {
        if (!fs.existsSync(CONFIG_FILE)) return message.reply('❌ 履歴なし');
        try {
            const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
            const targetGuild = clientMain.guilds.cache.get(config.guildId);
            await targetGuild.channels.fetch().catch(() => null);
            const channelMain = targetGuild.channels.cache.get(config.mainId);
            const channelA = targetGuild.channels.cache.get(config.vcaId);
            const channelB = targetGuild.channels.cache.get(config.vcbId);
            if (!channelMain || !channelA || !channelB) return message.reply('❌ チャンネル紛失');
            connectToVCs(config.guildId, channelMain, channelA, channelB); message.reply('♻️ 前回の設定で再開しました！');
        } catch (e) { console.error(e); message.reply('❌ 再接続エラー'); }
    }
});

clientMain.once('clientReady', () => { console.log(`🚀 すべてのBotが正常に起動しました！`); });

process.on('uncaughtException', (err) => {
    if (err.code === 'ERR_STREAM_PREMATURE_CLOSE' || err.message.includes('Premature close')) return;
    console.error(' [システム警告]:', err);
});

// 順次ログイン処理（完全環境変数オンリー仕様）
(async () => {
    try {
        if (!TOKENS.botMain || !TOKENS.botA || !TOKENS.botB) {
            console.error('❌ 【エラー】環境変数が正しく設定されていません。');
            console.error('PowerShellで以下の3つのコマンドを実行してトークンを登録してください：');
            console.error('\$env:DISCORD_TOKEN_MAIN="（司令塔トークン）"');
            console.error('\$env:DISCORD_TOKEN_A="（BotAトークン）"');
            console.error('\$env:DISCORD_TOKEN_B="（BotBトークン）"');
            return;
        }

        console.log('🔗 司令塔Botに接続中...');
        await clientMain.login(TOKENS.botMain);
        await new Promise(r => setTimeout(r, 1000));
        console.log('🔗 BotAに接続中...');
        await clientA.login(TOKENS.botA);
        await new Promise(r => setTimeout(r, 1000));
        console.log('🔗 BotBに接続中...');
        await clientB.login(TOKENS.botB);
    } catch (err) {
        console.error('❌ ログイン接続エラー:', err);
    }
})();
