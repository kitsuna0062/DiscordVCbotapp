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

Configure `DISCORD_TOKEN_MAIN` and at least one secondary token (`DISCORD_TOKEN_A` through `DISCORD_TOKEN_E`) as environment variables on the host. Invite the matching bot accounts to the server and grant them permission to view, connect to, and speak in the selected voice channels.

The `/setvc` command waits for every bot's voice connection to become ready. If it fails, check the host logs for the per-bot VC state transitions and error. Set `VOICE_DEBUG=true` for additional `@discordjs/voice` diagnostics; also verify that the host permits outbound UDP voice traffic.

Use Node.js `22.22.1` or newer. The project uses `@discordjs/voice` 0.19.1, which supports Discord's required DAVE voice encryption and Voice Gateway v8.

| Command | Description |
| :--- | :--- |
| `/setvc main source1 [source2]...` | Join the selected main and source voice channels. Select channels from the command options. |
| `/connect` | Reconnect using the saved channel configuration. |
| `/vcleave` | Disconnect all bots from voice channels. |
| `/vcon number [only]` | Relay audio from the main VC to the numbered source VC. Set `only` to relay only the command author's audio. |
| `/vcononly number` | Relay only the command author's audio to the numbered source VC. |
| `/vcoff number` | Stop relaying audio to the numbered source VC. |
| `/vol number volume` | Set the source bot's relay volume from `0` to `300` percent. |
| `/status` | Show the bots' online and voice-connection status in this server. |

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
このBotは常時起動するプロセスとして動作し、HTTPサーバーは起動しません。

サーバーの環境変数に `DISCORD_TOKEN_MAIN` と、少なくとも1つのサブBot用トークン（`DISCORD_TOKEN_A`〜`DISCORD_TOKEN_E`）を設定してください。対応するBotアカウントをサーバーに招待し、使用するVCの閲覧・接続・発言権限を付与してください。

`/setvc` は全BotのVC接続がReadyになるまで待機します。接続に失敗した場合は、サーバーのログでBotごとのVC状態遷移とエラーを確認してください。`VOICE_DEBUG=true` を設定すると、`@discordjs/voice` の追加診断ログが有効になります。ホスト側で音声通信用の外向きUDP通信が許可されていることも確認してください。

Node.js `22.22.1` 以降を使用してください。`@discordjs/voice` 0.19.1 に更新し、Discordで必須となったDAVE音声暗号化とVoice Gateway v8に対応しています。

| コマンド | 説明 |
| :--- | :--- |
| `/setvc main source1 [source2]...` | 選択したメインVCと元VCにBotを接続します。VCはコマンドの選択肢から指定します。 |
| `/connect` | 保存済みのチャンネル設定で再接続します。 |
| `/vcleave` | すべてのBotをVCから切断します。 |
| `/vcon number [only]` | メインVCから番号に対応する元VCへ音声を中継します。`only` を有効にすると実行者の音声だけを中継します。 |
| `/vcononly number` | 実行者の音声だけを番号に対応する元VCへ中継します。 |
| `/vcoff number` | 指定した元VCへの音声中継を停止します。 |
| `/vol number volume` | 元VCごとの中継音量を `0`〜`300`% で設定します。 |
| `/status` | このサーバー内の各Botのオンライン状態とVC接続状態を表示します。 |
