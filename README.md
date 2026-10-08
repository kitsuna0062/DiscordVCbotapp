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

Commands are text commands using `!` by default (not slash commands). Set `COMMAND_PREFIX` in Render to use another prefix. The bot requires the **Message Content Intent** to be enabled in the Discord Developer Portal.

For Render, configure `DISCORD_TOKEN_MAIN` and at least one secondary token (`DISCORD_TOKEN_A` through `DISCORD_TOKEN_E`) as environment variables. Invite the matching bot accounts to the server and grant them permission to view, connect to, and speak in the selected voice channels.

The `!setvc` command waits for every bot's voice connection to become ready. If it fails, check the Render logs for the per-bot VC state transitions and error. Set `VOICE_DEBUG=true` in Render for additional `@discordjs/voice` diagnostics; also verify that the host permits outbound UDP voice traffic.

| Command | Description |
| :--- | :--- |
| `!setvc [main VC] [source VC 1] [source VC 2]...` | Join the specified main and source voice channels. Use channel names or IDs. |
| `!connect` | Reconnect using the saved channel configuration. |
| `!vcleave` | Disconnect all bots from voice channels. |
| `!vcon [number] [only]` | Relay audio from the main VC to the numbered source VC. Add `only` to relay only the command author's audio. |
| `!vcononly [number]` | Same as `!vcon [number] only`. |
| `!vcoff [number]` | Stop relaying audio to the numbered source VC. |
| `!vol [number] [volume]` | Set the source bot's relay volume from `0` to `300` percent. |

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

コマンドは既定で `!` から始まるテキストコマンドです（スラッシュコマンドではありません）。Renderで `COMMAND_PREFIX` を設定すると別の接頭辞を使えます。Discord Developer Portalで **Message Content Intent** を有効にしてください。

Renderの環境変数に `DISCORD_TOKEN_MAIN` と、少なくとも1つのサブBot用トークン（`DISCORD_TOKEN_A`〜`DISCORD_TOKEN_E`）を設定してください。対応するBotアカウントをサーバーに招待し、使用するVCの閲覧・接続・発言権限を付与してください。

`!setvc` は全BotのVC接続がReadyになるまで待機します。接続に失敗した場合は、RenderログのBotごとのVC状態遷移とエラーを確認してください。Renderに `VOICE_DEBUG=true` を設定すると、`@discordjs/voice` の追加診断ログが有効になります。ホスト側で音声通信用の外向きUDP通信が許可されていることも確認してください。

| コマンド | 説明 |
| :--- | :--- |
| `!setvc [メインVC] [元VC 1] [元VC 2]...` | 指定したメインVCと元VCにBotを接続します。VC名またはIDを指定します。 |
| `!connect` | 保存済みのチャンネル設定で再接続します。 |
| `!vcleave` | すべてのBotをVCから切断します。 |
| `!vcon [番号] [only]` | メインVCから番号に対応する元VCへ音声を中継します。`only` を付けると実行者の音声だけを中継します。 |
| `!vcononly [番号]` | `!vcon [番号] only` と同じです。 |
| `!vcoff [番号]` | 指定した元VCへの音声中継を停止します。 |
| `!vol [番号] [音量]` | 元VCごとの中継音量を `0`〜`300`% で設定します。 |
