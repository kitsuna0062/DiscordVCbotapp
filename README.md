# DiscordVCbot

A Discord bot designed to relay and connect multiple voice channels (VCs) seamlessly.

---

## 🔗 Invitation Links

### Main Bot
- [Invite Main Bot to your server](https://discord.com)

### Secondary Bots
To relay multiple voice channels, please invite the following secondary bots as well:
1. [Invite Secondary Bot #1](https://discord.com)
2. [Invite Secondary Bot #2](https://discord.com)

---

## 💬 Commands

> 💡 The list of commands can also be found in the Main Bot's profile description.

| Command | Description |
| :--- | :--- |
| `!setvc [IDorName] [IDorName]...` | **Enter Room (Initial Setup)**<br>• 1st argument: The global VC ID or name.<br>• Subsequent arguments: The VC IDs or names for the relay path, in order. |
| `!connect` | **Connect with Previous Settings**<br>Makes the bot enter the room while carrying over the settings from the last `!setvc` command. |
| `!vcleave` | **Leave Room**<br>Disconnects the bot from the voice channels. |
| `!vcon [number] {only}` | **Enable Speaking to Specific Channel**<br>Allows you to speak to an individual voice channel from the main voice channel.<br>※ The channel numbers correspond to the order in which the sub-bots were invited using `!setvc`.<br>※ Adding `only` restricts speaking privileges exclusively to the user who executed the command. |
| `!vcononly [number]` | Same as `!vcon [number] only`. |
| `!vcoff [number]` | Disables voice chat for channels where it was previously enabled via `!vcon`. |
| `!vol [number] [volume]` | **Volume Adjustments**<br>Sets the microphone input level for each sub-bot.<br>※ Adjustable range: `0%` to `300%` |

# DiscordVCbot

Discordのボイスチャンネル（VC）を中継・連携するためのBotです。

---

## 🔗 ボットの招待リンク (Invitation Links)

### メインボット (Main Bot)
- [メインボットをサーバーに招待する](https://discord.com/oauth2/authorize?client_id=1554405530024419389&permissions=8&integration_type=0&scope=bot)

### サブボット (Secondary Bots)
ボイスチャンネルを複数中継する場合、以下のサブボットもあわせて招待してください。
1. [サブボット #1 を招待する](https://discord.com/oauth2/authorize?client_id=1554373444458778634&permissions=8&integration_type=0&scope=bot)
2. [サブボット #2 を招待する](https://discord.com/oauth2/authorize?client_id=1554405070064459817&permissions=8&integration_type=0&scope=bot)

---

## 💬 コマンド一覧 (Commands)

> 💡 コマンドの一覧は、メインボットの「プロフィール（詳細説明）」にも記載されています。

| コマンド | 説明 |
| :--- | :--- |
| `!setvc [IDorName] [IDorName]...` | **入室コマンド（初期設定）**<br>・第1引数：全体の基準となるVCのIDまたは名前<br>・第2引数以降：中継ルートとなる各VCのIDまたは名前を順番に指定します。 |
| `!connect` | **前回設定での入室コマンド**<br>前回の `!setvc` の設定を引き継いだまま、ボットをボイスチャンネルに入室させます。 |
| `!vcleave` | **退室コマンド**<br>ボットをボイスチャンネルから退室させます。 |
| `!vcon [番号] {only}` | **特定チャンネルへの発言有効化**<br>メインのVCから、特定のサブVCに対して個別に話しかけられるようにします。<br>※`[番号]` は、`!setvc` で設定（招待）されたサブボットの順番に対応します。<br>※末尾に `only` をつけると、**このコマンドを実行したユーザーだけ**に発言権限を制限します。 |
| `!vcononly [番号]` | `!vcon [番号] only` と全く同じ機能です。 |
| `!vcoff [番号]` | `!vcon` によって有効化されていた特定チャンネルへの音声送信を無効化します。 |
| `!vol [番号] [音量]` | **マイク入力レベルの設定**<br>サブボットごとのマイク入力音量を変更します。<br>※設定可能な範囲：`0%` 〜 `300%` |

