import express from 'express';
import axios from 'axios';
import { MongoClient } from 'mongodb';

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const WEBHOOK_PATH = `/webhook/${BOT_TOKEN}`;
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// MongoDB подключение
let db;
const client = new MongoClient(MONGODB_URI);

async function connectDB() {
  try {
    await client.connect();
    db = client.db('pole_dance');
    // Уникальный индекс — одна запись на человека
    await db.collection('bookings').createIndex({ chatId: 1 }, { unique: true });
    console.log('✅ MongoDB подключена');
  } catch (err) {
    console.error('❌ Ошибка MongoDB:', err);
  }
}
connectDB();

// Расписание
const schedule = [
  { id: 'mon_18', day: 'Понедельник', time: '18:00', type: 'Pole Dance', spots: 6 },
  { id: 'mon_19', day: 'Понедельник', time: '19:30', type: 'Stretching', spots: 8 },
  { id: 'wed_18', day: 'Среда', time: '18:00', type: 'Pole Dance', spots: 6 },
  { id: 'wed_19', day: 'Среда', time: '19:30', type: 'Exotic', spots: 5 },
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
async function handleStart(chatId) {
  const buttons = {
    inline_keyboard: [
      [{ text: '📅 Записаться', callback_data: 'cmd_book' }],
      [{ text: '📋 Расписание', callback_data: 'cmd_schedule' }],
      [{ text: '✅ Моя запись', callback_data: 'cmd_mybooking' }],
      [{ text: '❌ Отменить запись', callback_data: 'cmd_cancel' }],
    ]
  };
  await sendMessage(chatId, '👋 Привет! Я бот для записи на занятия pole dance.\n\nВыбери действие:', buttons);
}


// /book
async function handleBook(chatId) {
  const buttons = {
    inline_keyboard: schedule.map(s => ([{
      text: `${s.day} ${s.time} — ${s.type}`,
      callback_data: `book_${s.id}`,
    }]))
  };
  await sendMessage(chatId, '📅 Выбери занятие:', buttons);
}

// /schedule
async function handleSchedule(chatId) {
  const lines = schedule.map(s => `• ${s.day} ${s.time} — ${s.type} (${s.spots} мест)`);
  await sendMessage(chatId, `📋 Расписание:\n\n${lines.join('\n')}`);
}

// /mybooking
async function handleMyBooking(chatId) {
  try {
    const booking = await db.collection('bookings').findOne({ chatId });
    if (!booking) {
      await sendMessage(chatId, 'У тебя нет активной записи. Запишись через /book');
      return;
    }
    const s = schedule.find(x => x.id === booking.classId);
    await sendMessage(chatId, `✅ Ты записан(а): ${s.day} ${s.time} — ${s.type}`);
  } catch (err) {
    console.error('Ошибка mybooking:', err);
    await sendMessage(chatId, 'Ошибка при проверке записи. Попробуй позже.');
  }
}

// /cancel
async function handleCancel(chatId) {
  try {
    const result = await db.collection('bookings').deleteOne({ chatId });
    if (result.deletedCount === 0) {
      await sendMessage(chatId, 'У тебя нет активной записи.');
    } else {
      await sendMessage(chatId, '❌ Запись отменена.');
    }
  } catch (err) {
    console.error('Ошибка cancel:', err);
    await sendMessage(chatId, 'Ошибка при отмене. Попробуй позже.');
  }
}

// Обработка кнопок записи
async function handleCallback(chatId, data) {
  if (data === 'cmd_book') return await handleBook(chatId);
  if (data === 'cmd_schedule') return await handleSchedule(chatId);
  if (data === 'cmd_mybooking') return await handleMyBooking(chatId);
  if (data === 'cmd_cancel') return await handleCancel(chatId);

  const classId = data.replace('book_', '');
  const s = schedule.find(x => x.id === classId);
  if (!s) return;

  try {
    await db.collection('bookings').insertOne({
      chatId,
      classId,
      className: s.type,
      day: s.day,
      time: s.time,
      bookedAt: new Date(),
    });
    await answerCallback(chatId, `✅ Записан(а) на ${s.type}!`);
    await sendMessage(chatId, `✅ Ты записан(а) на ${s.day} ${s.time} — ${s.type}\n\nОтменить: /cancel\nПроверить: /mybooking`);
  } catch (err) {
    if (err.code === 11000) {
      await answerCallback(chatId, 'Ты уже записан(а)! Отмени текущую через /cancel');
    } else {
      console.error('Ошибка записи:', err);
      await answerCallback(chatId, 'Ошибка при записи. Попробуй позже.');
    }
  }
}


// Webhook
app.post(WEBHOOK_PATH, async (req, res) => {
  const update = req.body;
  const msg = update.message;
  const cb = update.callback_query;

  try {
    if (msg?.text) {
      const chatId = msg.chat.id;
      if (msg.text === '/start') await handleStart(chatId);
      else if (msg.text === '/book') await handleBook(chatId);
      else if (msg.text === '/schedule') await handleSchedule(chatId);
      else if (msg.text === '/mybooking') await handleMyBooking(chatId);
      else if (msg.text === '/cancel') await handleCancel(chatId);
    }
    if (cb) {
      await handleCallback(cb.from.id, cb.data);
    }
  } catch (err) {
    console.error('Webhook error:', err);
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bot running on port ${PORT}`));
