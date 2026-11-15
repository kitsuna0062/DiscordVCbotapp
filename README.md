# DiscordVCbot

A Discord bot designed to relay and connect multiple voice channels (VCs) seamlessly.

---

## 🔗 Invitation Links

### Main Bot
- [Invite Main Bot to your server](https://discord.com/oauth2/authorize?client_id=1554405530024419389&permissions=8&integration_type=0&scope=bot+applications.commands)

### Secondary Bots
To relay multiple voice channels, please invite the following secondary bots as well:
1. [Invite Secondary Bot #1](https://discord.com/oauth2/authorize?client_id=1554373444458778634&permissions=8&integration_type=0&scope=bot+applications.commands)
2. [Invite Secondary Bot #2](https://discord.com/oauth2/authorize?client_id=1554405070064459817&permissions=8&integration_type=0&scope=bot+applications.commands)

---

## 💬 Commands

Commands are Discord slash commands. The bot registers them globally when the main bot starts; newly registered or changed commands can take up to an hour to appear in every server.
This bot runs as a long-lived process and does not start an HTTP server.

Set `DISCORD_TOKEN_MAIN` and at least one secondary token (`DISCORD_TOKEN_SUB_A` through `DISCORD_TOKEN_SUB_E`) in the `.env` file next to `index.js`, or provide them as environment variables on the host. The bot loads the `.env` file automatically at startup. Invite the matching bot accounts to the server and grant them permission to view, connect to, and speak in the selected voice channels.

The `/setvc` command waits for every bot's voice connection to become ready. If it fails, check the host logs for the per-bot VC state transitions and error. Set `VOICE_DEBUG=true` for additional `@discordjs/voice` diagnostics; also verify that the host permits outbound UDP voice traffic.

Use Node.js `26.13.0` or newer. The project uses `@discordjs/voice` 0.19.1, which supports Discord's required DAVE voice encryption and Voice Gateway v8.

Reverse-relay commands can target one source bot by number or all source bots with the `all` option.

| Command | Description |
| :--- | :--- |
| `/setvc main source1 [source2]...` | Join the selected main and source voice channels. Select channels from the command options. |
| `/connect` | Reconnect using the saved channel configuration. |
| `/vcleave` | Disconnect all bots from voice channels. |
| `/vcon [number] [only] [all]` | Relay audio from the main VC to the selected source bot(s). Set `only` to relay only the command author's audio, or `all` to target every source bot. |
| `/vcononly [number] [all]` | Relay only the command author's audio to the selected source bot(s). Set `all` to target every source bot. |
| `/vcoff [number] [all]` | Stop relaying audio to the numbered source bot, or set `all` to stop relaying to every source bot. |
| `/vol number volume [number2 volume2 ...]` | Set relay volumes from `0` to `300` percent for multiple source bots in one command. |
| `/status` | Show each bot's online and voice-connection status, volume, reverse-relay status, and the number of active incoming audio streams in this server. |

# DiscordVCbot

Discordのボイスチャンネル（VC）を中継・連携するためのBotです。

---

## 🔗 ボットの招待リンク (Invitation Links)

### メインボット (Main Bot)
- [メインボットをサーバーに招待する](https://discord.com/oauth2/authorize?client_id=1554405530024419389&permissions=8&integration_type=0&scope=bot+applications.commands)

### サブボット (Secondary Bots)
ボイスチャンネルを複数中継する場合、以下のサブボットもあわせて招待してください。
1. [サブボット #1 を招待する](https://discord.com/oauth2/authorize?client_id=1554373444458778634&permissions=8&integration_type=0&scope=bot+applications.commands)
2. [サブボット #2 を招待する](https://discord.com/oauth2/authorize?client_id=1554405070064459817&permissions=8&integration_type=0&scope=bot+applications.commands)

---

## 💬 コマンド一覧 (Commands)

コマンドはDiscordのスラッシュコマンドです。メインBotの起動時にグローバル登録されます。新規登録・変更がすべてのサーバーに反映されるまで最大1時間ほどかかる場合があります。

`index.js` と同じ場所にある `.env` ファイルに `DISCORD_TOKEN_MAIN` と、少なくとも1つのサブBot用トークン（`DISCORD_TOKEN_SUB_A`〜`DISCORD_TOKEN_SUB_E`）を設定してください。起動時に `.env` は自動で読み込まれます。ホスト側の環境変数として直接設定する方法も利用できます。対応するBotアカウントをサーバーに招待し、使用するVCの閲覧・接続・発言権限を付与してください。

`/setvc` は全BotのVC接続がReadyになるまで待機します。接続に失敗した場合は、サーバーのログでBotごとのVC状態遷移とエラーを確認してください。`VOICE_DEBUG=true` を設定すると、`@discordjs/voice` の追加診断ログが有効になります。ホスト側で音声通信用の外向きUDP通信が許可されていることも確認してください。

Node.js `26.13.0` 以降を使用してください。`@discordjs/voice` 0.19.1 に更新し、Discordで必須となったDAVE音声暗号化とVoice Gateway v8に対応しています。

逆方向中継コマンドは、番号でサブBot 1台を指定するか、`all` をオンにしてすべてのサブBotを対象にできます。

| コマンド | 説明 |
| :--- | :--- |
| `/setvc main source1 [source2]...` | 選択したメインVCと元VCにBotを接続します。VCはコマンドの選択肢から指定します。 |
| `/connect` | 保存済みのチャンネル設定で再接続します。 |
| `/vcleave` | すべてのBotをVCから切断します。 |
| `/vcon [number] [only] [all]` | メインVCから指定したサブBotへ音声を中継します。`only` を有効にすると実行者の音声だけを、`all` を有効にするとすべてのサブBotを対象にします。 |
| `/vcononly [number] [all]` | 実行者の音声だけを指定したサブBotへ中継します。`all` を有効にするとすべてのサブBotを対象にします。 |
| `/vcoff [number] [all]` | 指定したサブBotへの音声中継を停止します。`all` を有効にするとすべてのサブBotへの中継を停止します。 |
| `/vol number volume [number2 volume2 ...]` | 複数の元VCの中継音量を1回のコマンドで `0`〜`300`% に設定できます。 |
| `/status` | 各Botのオンライン状態、VC接続状態、音量、逆方向中継のオン／オフ、および受信中の音声ストリーム数を表示します。 |
