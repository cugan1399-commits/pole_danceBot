import express from 'express';
import axios from 'axios';

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const bookings = {};
const SLOTS = ['10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00','18:00','19:00'];

function getDates() {
  const dates = [];
  const now = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    dates.push(d.toISOString().split('T')[0]);
  }
  return dates;
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const days = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
  const months = ['янв','фев','мар','апр','мая','июн','июл','авг','сен','окт','ноя','дек'];
  return `${d.getDate()} ${months[d.getMonth()]} (${days[d.getDay()]})`;
}

async function sendMessage(chatId, text, keyboard) {
  await axios.post(`${API}/sendMessage`, {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML',
    reply_markup: keyboard || undefined
  });
}

async function handleStart(chatId) {
  const keyboard = {
    inline_keyboard: [
      [{ text: '📅 Записаться', callback_data: 'book' }],
      [{ text: '📋 Мои записи', callback_data: 'my_bookings' }],
      [{ text: '🗓 Расписание', callback_data: 'schedule' }]
    ]
  };
  await sendMessage(chatId, '👋 Привет! Я бот для записи.\n\nВыбери действие:', keyboard);
}

async function handleBook(chatId) {
  const dates = getDates();
  const keyboard = {
    inline_keyboard: dates.map(d => ([{ text: formatDate(d), callback_data: `date_${d}` }]))
  };
  await sendMessage(chatId, 'Выбери дату:', keyboard);
}

async function handleDateSelect(chatId, date) {
  const taken = bookings[date] || [];
  const available = SLOTS.filter(s => !taken.includes(s));
  if (available.length === 0) {
    await sendMessage(chatId, `На ${formatDate(date)} все слоты заняты 😔`);
    return;
  }
  const keyboard = {
    inline_keyboard: available.map(s => ([{ text: s, callback_data: `time_${date}_${s}` }]))
  };
  await sendMessage(chatId, `Свободные слоты на ${formatDate(date)}:`, keyboard);
}

async function handleTimeSelect(chatId, date, time) {
  if (!bookings[date]) bookings[date] = [];
  bookings[date].push(time);
  await sendMessage(chatId, `✅ Записано!\n📅 ${formatDate(date)}\n🕐 ${time}\n\nЖду тебя!`);
}

async function handleMyBookings(chatId) {
  const dates = getDates();
  let text = '📋 Твои записи:\n\n';
  let found = false;
  for (const date of dates) {
    const taken = bookings[date] || [];
    if (taken.length > 0) {
      found = true;
      text += `<b>${formatDate(date)}</b>: ${taken.join(', ')}\n`;
    }
  }
  if (!found) text += 'Пока записей нет';
  await sendMessage(chatId, text);
}

async function handleSchedule(chatId) {
  const dates = getDates();
  let text = '🗓 Расписание на неделю:\n\n';
  for (const date of dates) {
    const taken = bookings[date] || [];
    const available = SLOTS.filter(s => !taken.includes(s));
    text += `<b>${formatDate(date)}</b>\n`;
    if (taken.length > 0) {
      text += `  ❌ Занято: ${taken.join(', ')}\n  ✅ Свободно: ${available.join(', ')}\n\n`;
    } else {
      text += `  ✅ Все слоты свободны\n\n`;
    }
  }
  await sendMessage(chatId, text);
}

app.post(`/webhook/${BOT_TOKEN}`, async (req, res) => {
  const { message, callback_query } = req.body;
  try {
    if (message && message.text && message.text.startsWith('/start')) {
      await handleStart(message.chat.id);
    } else if (message && message.text && message.text.startsWith('/book')) {
      await handleBook(message.chat.id);
    } else if (message && message.text && message.text.startsWith('/schedule')) {
      await handleSchedule(message.chat.id);
    }
    if (callback_query) {
      const chatId = callback_query.message.chat.id;
      const data = callback_query.data;
      await axios.post(`${API}/answerCallbackQuery`, { callback_query_id: callback_query.id });
      if (data === 'book') await handleBook(chatId);
      else if (data === 'my_bookings') await handleMyBookings(chatId);
      else if (data === 'schedule') await handleSchedule(chatId);
      else if (data.startsWith('date_')) await handleDateSelect(chatId, data.slice(5));
      else if (data.startsWith('time_')) {
        const parts = data.split('_');
        await handleTimeSelect(chatId, parts[1], parts[2]);
      }
    }
  } catch (err) {
    console.error('Error:', err.message);
  }
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
