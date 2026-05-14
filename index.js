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
            text: `${s.day} ${s.time} – ${s.type}`,
            callback_data: `book_${s.id}`,
        }]))
    };
    await sendMessage(chatId, 'Выбери занятие:', buttons);
}


// /schedule
async function handleSchedule(chatId) {
  const lines = schedule.map(s => `• ${s.day} ${s.time} — ${s.type} (${s.spots} мест)`);
  await sendMessage(chatId, `📋 Расписание:\n\n${lines.join('\n')}`);
}

// /mybooking
async function handleMyBooking(chatId) {
    const booking = await db.collection('bookings').findOne({ chatId });
    
    if (!booking) {
        const buttons = {
            inline_keyboard: [
                [{ text: '📝 Записаться', callback_data: 'cmd_book' }]
            ]
        };
        return await sendMessage(chatId, 'У тебя нет активной записи.', buttons);
    }

    const buttons = {
        inline_keyboard: [
            [{ text: '❌ Отменить запись', callback_data: 'cmd_cancel' }]
        ]
    };
    await sendMessage(chatId, `✅ Твоя запись:\n${booking.day} ${booking.time} — ${booking.className}`, buttons);
}



// /cancel
async function handleCancel(chatId) {
  const booking = await db.collection('bookings').findOne({ chatId });

  if (!booking) {
    const buttons = {
      inline_keyboard: [
        [{ text: '📅 Записаться', callback_data: 'cmd_book' }]
      ]
    };
    return await sendMessage(chatId, 'У тебя нет активной записи.', buttons);
  }

  await db.collection('bookings').deleteOne({ chatId });
  await sendMessage(chatId, '❌ Запись отменена.');
}


// Обработка кнопок записи
async function handleCallback(chatId, data, callbackQueryId, fromUser) {
  // ===== АДМИНКА =====
    if (data === 'admin_refresh') {
        const bookings = await db.collection('bookings').find({}).sort({ bookedAt: -1 }).toArray();
        if (!bookings.length) {
            await answerCallback(callbackQueryId, '📭 Записей нет');
            return await sendMessage(chatId, '📭 Записей пока нет.');
        }
        const grouped = {};
        bookings.forEach(b => {
            const key = `${b.day} ${b.time} — ${b.className}`;
            if (!grouped[key]) grouped[key] = [];
            grouped[key].push(b);
        });
        let text = '📋 Все записи:\n\n';
        for (const [slot, list] of Object.entries(grouped)) {
            text += `🗓 ${slot} — ${list.length} чел.\n`;
            list.forEach((b, i) => {
                const date = b.bookedAt.toLocaleString('ru-RU', { timeZone: 'Europe/Minsk' });
                text += `  ${i + 1}. @${b.username} (${b.firstName}) | ${date}\n`;
            });
            text += '\n';
        }
        text += `\nВсего записей: ${bookings.length}`;
        const buttons = {
            inline_keyboard: [
                [{ text: '🔄 Обновить', callback_data: 'admin_refresh' }],
                [{ text: '🗑 Очистить все', callback_data: 'admin_clear' }]
            ]
        };
        await answerCallback(callbackQueryId, 'Обновлено');
        await sendMessage(chatId, text, buttons);
        return;
    }

    if (data === 'admin_clear') {
        const count = await db.collection('bookings').countDocuments({});
        await db.collection('bookings').deleteMany({});
        await answerCallback(callbackQueryId, `Удалено: ${count}`);
        await sendMessage(chatId, `🗑 Удалено записей: ${count}`);
        return;
    }
    // ===== КОНЕЦ АДМИНКИ =====
    if (data === 'cmd_book') return await handleBook(chatId);
    if (data === 'cmd_schedule') return await handleSchedule(chatId);
    if (data === 'cmd_mybooking') return await handleMyBooking(chatId);
    if (data === 'cmd_cancel') return await handleCancel(chatId);

    const classId = data.replace('book_', '');
    const s = schedule.find(x => x.id === classId);
    if (!s) return;

    const menuButtons = {
        inline_keyboard: [
            [{ text: '✅ Моя запись', callback_data: 'cmd_mybooking' }],
            [{ text: '❌ Отменить запись', callback_data: 'cmd_cancel' }]
        ]
    };

    try {
        await db.collection('bookings').insertOne({
      await db.collection('bookings').insertOne({
    chatId,
    username: fromUser.username || 'нет username',
    firstName: fromUser.first_name || '',
    classId,
    className: s.type,
    day: s.day,
    time: s.time,
    bookedAt: new Date(),
});

        await answerCallback(callbackQueryId, '✅ Запись произведена!');
        await sendMessage(chatId, `✅ Запись произведена!\n${s.day} ${s.time} — ${s.type}`, menuButtons);
    } catch (err) {
        if (err.code === 11000) {
            await answerCallback(callbackQueryId, 'Ты уже записан(а)!');
            await sendMessage(chatId, 'Ты уже записан(а) на это занятие.', menuButtons);
        } else {
            console.error('Ошибка записи:', err);
            await answerCallback(callbackQueryId, 'Ошибка. Попробуй позже.');
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
    const chatId = cb.message.chat.id;
    const callbackQueryId = cb.id;
    await handleCallback(chatId, cb.data, callbackQueryId, cb.from);
}


  } catch (err) {
    console.error('Webhook error:', err);
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bot running on port ${PORT}`));

// ==================== АДМИНКА ====================

const ADMIN_ID = 8658993738; // ← впиши свой Telegram ID

bot.onText(/\/admin/, async (msg) => {
    const chatId = msg.chat.id;
    if (chatId !== ADMIN_ID) return;

    const bookings = await db.collection('bookings').find({}).sort({ bookedAt: -1 }).toArray();

    if (!bookings.length) {
        return await sendMessage(chatId, '📭 Записей пока нет.');
    }

    const grouped = {};
    bookings.forEach(b => {
        const key = `${b.day} ${b.time} — ${b.className}`;
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(b);
    });

    let text = '📋 Все записи:\n\n';
    for (const [slot, list] of Object.entries(grouped)) {
        text += `🗓 ${slot} — ${list.length} чел.\n`;
        list.forEach((b, i) => {
            const date = b.bookedAt.toLocaleString('ru-RU', { timeZone: 'Europe/Minsk' });
            text += `  ${i + 1}. ID: ${b.chatId} | ${date}\n`;
        });
        text += '\n';
    }

    text += `\nВсего записей: ${bookings.length}`;

    const buttons = {
        inline_keyboard: [
            [{ text: '🔄 Обновить', callback_data: 'admin_refresh' }],
            [{ text: '🗑 Очистить все', callback_data: 'admin_clear' }]
        ]
    };

    await sendMessage(chatId, text, buttons);
});

