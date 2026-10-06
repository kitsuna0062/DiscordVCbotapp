##DiscordVCbot
This is the invite link for the main bot.
*https://discord.com/oauth2/authorize?client_id=1554405530024419389&permissions=8&integration_type=0&scope=bot
The links below are invitation links for the secondary bot.
1.https://discord.com/oauth2/authorize?client_id=1554373444458778634&permissions=8&integration_type=0&scope=bot
2.https://discord.com/oauth2/authorize?client_id=1554405070064459817&permissions=8&integration_type=0&scope=bot
The commands are listed in the main bot's description.
#The commands are listed in the main bot's description.
!setvc [IDorName] [IDorName]... :Command for entering the room. The first argument is the global VCid or VCname; subsequent arguments are the VCids or VCnames for the relay path, in order.
!connect :The user will enter the room with the previous settings carried over.
!vcleave :Exit command
!vcon [number] {only} :You can speak to individual voice channels from the main voice channel. The channel numbers correspond to the order in which the sub-bots were invited using `!setvc`. Using the command `!vcon [number] only` restricts speaking privileges to the person who executed the command.
!vcononly [number] :It is the same as !vcon [number] only.
!vcoff [number] :This disables voice chat for channels where it was enabled via !vcon.
!vol [number] [volume] :Set the microphone input level for each sub-bot. The range is 0% to 300%.
