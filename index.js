import express from 'express';
import axios from 'axios';

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_PATH = `/webhook/${BOT_TOKEN}`;
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Временное хранение записей (память)
const bookings = [];

// Расписание
const schedule = [
  { id: 'mon_18', day: 'Понедельник', time: '18:00', type: 'Pole Dance', spots: 6 },
  { id: 'mon_19', day: 'Понедельник', time: '19:30', type: 'Stretching', spots: 8 },
  { id: 'wed_18', day: 'Среда', time: '18:00', type: 'Pole Dance', spots: 6 },
  { id: 'wed_19', day: 'Среда', time: '19:30', type: 'Exotic', spots: 6 },
  { id: 'fri_18', day: 'Пятница', time: '18:00', type: 'Pole Dance', spots: 6 },
  { id: 'fri_19', day: 'Пятница', time: '19:30', type: 'Stretching', spots: 8 },
];

function sendMessage(chatId, text, keyboard) {
  const data = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (keyboard) data.reply_markup = keyboard;
  return axios.post(`${API}/sendMessage`, data);
}

function answerCallback(callbackQueryId, text = '') {
  return axios.post(`${API}/answerCallbackQuery`, {
    callback_query_id: callbackQueryId,
    text,
  });
}

// /start
function handleStart(msg) {
  const keyboard = {
    inline_keyboard: [
      [{ text: '📅 Записаться', callback_data: 'book' }],
      [{ text: '📋 Расписание', callback_data: 'schedule' }],
      [{ text: 'ℹ️ О нас', callback_data: 'about' }],
    ],
  };
  return sendMessage(
    msg.chat.id,
    '🐱 Привет! Я — бот <b>CatPaws.Dance</b>\n\nЗапишись на занятие или посмотри расписание 👇',
    keyboard
  );
}

// /book — показываем расписание для записи
function handleBook(msg) {
  const buttons = schedule.map((s) => [
    { text: `${s.day} ${s.time} — ${s.type}`, callback_data: `select_${s.id}` },
  ]);
  const keyboard = { inline_keyboard: buttons };
  return sendMessage(msg.chat.id, 'Выбери занятие для записи:', keyboard);
}

// /schedule — показать расписание
function handleSchedule(msg) {
  const lines = schedule.map(
    (s) => `• <b>${s.day}</b> ${s.time} — ${s.type} (мест: ${s.spots})`
  );
  return sendMessage(msg.chat.id, `📋 Расписание:\n\n${lines.join('\n')}`);
}

// Обработка callback-кнопок
async function handleCallback(callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;

  if (data === 'book') {
    const buttons = schedule.map((s) => [
      { text: `${s.day} ${s.time} — ${s.type}`, callback_data: `select_${s.id}` },
    ]);
    const keyboard = { inline_keyboard: buttons };
    await sendMessage(chatId, 'Выбери занятие для записи:', keyboard);
    return answerCallback(callbackQuery.id);
  }

  if (data === 'schedule') {
    const lines = schedule.map(
      (s) => `• <b>${s.day}</b> ${s.time} — ${s.type} (мест: ${s.spots})`
    );
    await sendMessage(chatId, `📋 Расписание:\n\n${lines.join('\n')}`);
    return answerCallback(callbackQuery.id);
  }

  if (data === 'about') {
    await sendMessage(
      chatId,
      '🐱 <b>CatPaws.Dance</b>\n\nPole Dance, Exotic, Stretching\nЗапись через бота или в канале 👇'
    );
    return answerCallback(callbackQuery.id);
  }

  // Выбор занятия — подтверждение
  if (data.startsWith('select_')) {
    const slotId = data.replace('select_', '');
    const slot = schedule.find((s) => s.id === slotId);
    if (!slot) return answerCallback(callbackQuery.id, 'Занятие не найдено');

    const keyboard = {
      inline_keyboard: [
        [{ text: '✅ Подтвердить запись', callback_data: `confirm_${slotId}` }],
        [{ text: '← Назад', callback_data: 'book' }],
      ],
    };
    await sendMessage(
      chatId,
      `Ты выбрал:\n\n<b>${slot.day} ${slot.time} — ${slot.type}</b>\nМест: ${slot.spots}\n\nПодтверждаешь?`,
      keyboard
    );
    return answerCallback(callbackQuery.id);
  }

  // Подтверждение записи
  if (data.startsWith('confirm_')) {
    const slotId = data.replace('confirm_', '');
    const slot = schedule.find((s) => s.id === slotId);
    if (!slot) return answerCallback(callbackQuery.id, 'Занятие не найдено');

    const userId = callbackQuery.from.id;
    const existing = bookings.find((b) => b.userId === userId && b.slotId === slotId);
    if (existing) {
      await sendMessage(chatId, 'Ты уже записан на это занятие! 😼');
      return answerCallback(callbackQuery.id);
    }

    bookings.push({ userId, slotId, name: callbackQuery.from.first_name });
    await sendMessage(
      chatId,
      `✅ Записан!\n\n<b>${slot.day} ${slot.time} — ${slot.type}</b>\nДо встречи на занятии! 🐱`
    );
    return answerCallback(callbackQuery.id, 'Записано!');
  }
}

// Webhook endpoint
app.post(WEBHOOK_PATH, async (req, res) => {
  const update = req.body;

  if (update.message) {
    const msg = update.message;
    const text = msg.text || '';

    if (text === '/start') {
      await handleStart(msg);
    } else if (text === '/book') {
      await handleBook(msg);
    } else if (text === '/schedule') {
      await handleSchedule(msg);
    }
  }

  if (update.callback_query) {
    await handleCallback(update.callback_query);
  }

  res.sendStatus(200);
});

// Health check
app.get('/', (req, res) => {
  res.send('CatPaws.Dance bot is running!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot running on port ${PORT}`);
});
