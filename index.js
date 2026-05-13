const TelegramBot = require('node-telegram-bot-api');
const express = require('express');

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token);

const app = express();
app.use(express.json());

const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
bot.setWebHook(WEBHOOK_URL);

app.post(`/bot${token}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get('/', (req, res) => {
  res.send('Bot is running!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot server listening on port ${PORT}`);
});

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Привет! 🐾 Бот работает!');
});
