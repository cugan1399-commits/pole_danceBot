import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient, ObjectId } from 'mongodb';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
// Отдаём статику Mini App (папка webapp/ рядом с index.js)
app.use(express.static(path.join(__dirname, 'webapp')));

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const WEBHOOK_PATH = `/webhook/${BOT_TOKEN}`;
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const ADMIN_ID = 8658993738; // ← впиши свой Telegram ID
// Публичный адрес твоего бота на Render — используется для кнопки Mini App
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://pole-dancebot.onrender.com';

// Часы работы студии для создания занятий (09:00 .. 20:00)
const WORK_HOURS = [];
for (let h = 9; h <= 20; h++) WORK_HOURS.push(String(h).padStart(2, '0') + ':00');

const ROOMS = [1, 2]; // ← позже можно добавить 3-й зал

const RU_WEEKDAYS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

// MongoDB подключение
let db;
const client = new MongoClient(MONGODB_URI);

async function connectDB() {
  try {
    await client.connect();
    db = client.db('pole_dance');
    // Уникальный индекс — одна запись на человека (старая система Mini App)
    await db.collection('bookings').createIndex({ chatId: 1 }, { unique: true });

    // Новая система: тренеры, направления, занятия
    await db.collection('trainers').createIndex({ telegramId: 1 }, { unique: true });
    await db.collection('directions').createIndex({ name: 1 }, { unique: true });
    // Не даёт создать два занятия в одном зале в одно и то же время
    await db.collection('classes').createIndex({ date: 1, time: 1, room: 1 }, { unique: true });

    // Регистрируем главного админа как тренера по умолчанию, если его ещё нет
    await db.collection('trainers').updateOne(
      { telegramId: ADMIN_ID },
      { $setOnInsert: { telegramId: ADMIN_ID, name: 'Админ (ты)', addedAt: new Date() } },
      { upsert: true }
    );

    console.log('✅ MongoDB подключена');
  } catch (err) {
    console.error('❌ Ошибка MongoDB:', err);
  }
}
connectDB();

// Расписание (старая система, используется в Mini App — не трогаем)
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

// ===================== ПРОВЕРКА TELEGRAM WEBAPP initData =====================
function verifyInitData(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');

    const dataCheckArr = [];
    for (const [key, value] of [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      dataCheckArr.push(`${key}=${value}`);
    }
    const dataCheckString = dataCheckArr.join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (computedHash !== hash) return null;

    const userJson = params.get('user');
    if (!userJson) return null;
    return JSON.parse(userJson);
  } catch (err) {
    console.error('Ошибка проверки initData:', err);
    return null;
  }
}

// ===================== API ДЛЯ MINI APP (старая система, не трогаем) =====================

app.get('/api/schedule', (req, res) => {
  res.json(schedule);
});

app.get('/api/mybooking', async (req, res) => {
  const user = verifyInitData(req.query.initData || '');
  if (!user) return res.status(401).json({ error: 'unauthorized' });

  const booking = await db.collection('bookings').findOne({ chatId: user.id });
  res.json({ booking: booking || null });
});

app.post('/api/book', async (req, res) => {
  const { initData, classId } = req.body;
  const user = verifyInitData(initData || '');
  if (!user) return res.status(401).json({ error: 'unauthorized' });

  const s = schedule.find(x => x.id === classId);
  if (!s) return res.status(400).json({ error: 'invalid_class' });

  try {
    await db.collection('bookings').insertOne({
      chatId: user.id,
      username: user.username || 'нет username',
      firstName: user.first_name || '',
      classId,
      className: s.type,
      day: s.day,
      time: s.time,
      bookedAt: new Date(),
    });
    res.json({ ok: true, booking: s });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'already_booked' });
    }
    console.error('Ошибка записи (API):', err);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/cancel', async (req, res) => {
  const { initData } = req.body;
  const user = verifyInitData(initData || '');
  if (!user) return res.status(401).json({ error: 'unauthorized' });

  await db.collection('bookings').deleteOne({ chatId: user.id });
  res.json({ ok: true });
});

// ===================== СУЩЕСТВУЮЩАЯ ЛОГИКА БОТА (без изменений) =====================

async function handleStart(chatId) {
  const buttons = {
    inline_keyboard: [
      [{ text: '🚀 Открыть приложение', web_app: { url: WEBAPP_URL } }],
      [{ text: '📅 Записаться', callback_data: 'cmd_book' }],
      [{ text: '📋 Расписание', callback_data: 'cmd_schedule' }],
      [{ text: '✅ Моя запись', callback_data: 'cmd_mybooking' }],
      [{ text: '❌ Отменить запись', callback_data: 'cmd_cancel' }],
    ]
  };

  if (chatId === ADMIN_ID) {
    buttons.inline_keyboard.push(
      [{ text: '📌 Добавить занятие', callback_data: 'ac_start' }],
      [{ text: '🗓 Календарь', callback_data: 'cal_start' }],
      [{ text: '➕ Добавить тренера', callback_data: 'admin_add_trainer' }],
      [{ text: '➕ Добавить направление', callback_data: 'admin_add_direction' }],
    );
  }

  await sendMessage(chatId, '👋 Привет! Я бот для записи на занятия pole dance.\n\nВыбери действие:', buttons);
}

async function handleBook(chatId) {
    const buttons = {
        inline_keyboard: schedule.map(s => ([{
            text: `${s.day} ${s.time} – ${s.type}`,
            callback_data: `book_${s.id}`,
        }]))
    };
    await sendMessage(chatId, 'Выбери занятие:', buttons);
}

async function handleSchedule(chatId) {
  const lines = schedule.map(s => `• ${s.day} ${s.time} — ${s.type} (${s.spots} мест)`);
  await sendMessage(chatId, `📋 Расписание:\n\n${lines.join('\n')}`);
}

async function handleMyBooking(chatId) {
    const booking = await db.collection('bookings').findOne({ chatId });

    if (!booking) {
        const buttons = { inline_keyboard: [[{ text: '📝 Записаться', callback_data: 'cmd_book' }]] };
        return await sendMessage(chatId, 'У тебя нет активной записи.', buttons);
    }

    const buttons = { inline_keyboard: [[{ text: '❌ Отменить запись', callback_data: 'cmd_cancel' }]] };
    await sendMessage(chatId, `✅ Твоя запись:\n${booking.day} ${booking.time} — ${booking.className}`, buttons);
}

async function handleCancel(chatId) {
  const booking = await db.collection('bookings').findOne({ chatId });

  if (!booking) {
    const buttons = { inline_keyboard: [[{ text: '📅 Записаться', callback_data: 'cmd_book' }]] };
    return await sendMessage(chatId, 'У тебя нет активной записи.', buttons);
  }

  await db.collection('bookings').deleteOne({ chatId });
  await sendMessage(chatId, '❌ Запись отменена.');
}

async function handleAdmin(chatId) {
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
    await sendMessage(chatId, text, buttons);
}

// ===================== НОВОЕ: ТРЕНЕРЫ / НАПРАВЛЕНИЯ / ЗАНЯТИЯ =====================
// Простые пошаговые диалоги для админа храним в памяти процесса.
// Если процесс перезапустится (деплой), незавершённый диалог просто сбросится — не критично.
const adminSessions = new Map(); // chatId -> { flow: 'add_trainer' | 'add_direction', step, data }

function getNext7Days() {
  const days = [];
  const now = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const label = `${RU_WEEKDAYS[d.getDay()]} ${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
    days.push({ iso, label });
  }
  return days;
}

// ---------- Добавить тренера ----------
async function startAddTrainer(chatId) {
  adminSessions.set(chatId, { flow: 'add_trainer', step: 'telegramId', data: {} });
  await sendMessage(chatId, 'Пришли Telegram ID тренера (число).\nУзнать ID можно через бота @userinfobot.');
}

async function handleAddTrainerText(chatId, text) {
  const session = adminSessions.get(chatId);

  if (session.step === 'telegramId') {
    const id = parseInt(text.trim(), 10);
    if (!id || isNaN(id)) {
      return await sendMessage(chatId, 'Это не похоже на ID. Пришли число ещё раз.');
    }
    session.data.telegramId = id;
    session.step = 'name';
    return await sendMessage(chatId, 'Как зовут тренера? (просто имя)');
  }

  if (session.step === 'name') {
    session.data.name = text.trim();
    try {
      await db.collection('trainers').insertOne({
        telegramId: session.data.telegramId,
        name: session.data.name,
        addedAt: new Date(),
      });
      await sendMessage(chatId, `✅ Тренер добавлен: ${session.data.name} (ID ${session.data.telegramId})`);
    } catch (err) {
      if (err.code === 11000) {
        await sendMessage(chatId, 'Тренер с таким ID уже есть в списке.');
      } else {
        console.error('Ошибка добавления тренера:', err);
        await sendMessage(chatId, 'Не получилось сохранить. Попробуй ещё раз через /start.');
      }
    }
    adminSessions.delete(chatId);
  }
}

// ---------- Добавить направление ----------
async function startAddDirection(chatId) {
  adminSessions.set(chatId, { flow: 'add_direction', step: 'name', data: {} });
  await sendMessage(chatId, 'Название нового направления? (например: Twerk)');
}

async function handleAddDirectionText(chatId, text) {
  const name = text.trim();
  try {
    await db.collection('directions').insertOne({ name, addedAt: new Date() });
    await sendMessage(chatId, `✅ Направление добавлено: ${name}`);
  } catch (err) {
    if (err.code === 11000) {
      await sendMessage(chatId, 'Такое направление уже есть.');
    } else {
      console.error('Ошибка добавления направления:', err);
      await sendMessage(chatId, 'Не получилось сохранить. Попробуй ещё раз через /start.');
    }
  }
  adminSessions.delete(chatId);
}

async function getDirections() {
  const list = await db.collection('directions').find({}).sort({ name: 1 }).toArray();
  if (list.length) return list.map(d => d.name);
  // Дефолтный набор, если ещё ничего не добавлено
  return ['Pole Dance', 'Stretching', 'Exotic'];
}

// ---------- Добавить занятие: день → время → зал → направление → тренер ----------
async function startAddClass(chatId) {
  const days = getNext7Days();
  const buttons = {
    inline_keyboard: days.map(d => ([{ text: d.label, callback_data: `ac_day_${d.iso}` }]))
  };
  await sendMessage(chatId, 'Выбери день для нового занятия:', buttons);
}

async function showTimeStep(chatId, date) {
  // Показываем занятость по каждому часу (если хотя бы один зал занят - помечаем)
  const existing = await db.collection('classes').find({ date }).toArray();
  const busyHours = new Set(existing.map(c => c.time));

  const buttons = {
    inline_keyboard: WORK_HOURS.map(h => ([{
      text: busyHours.has(h) ? `${h} (частично занято)` : `${h} (свободно)`,
      callback_data: `ac_time_${date}_${h}`,
    }]))
  };
  await sendMessage(chatId, `Дата: ${date}\nВыбери время:`, buttons);
}

async function showRoomStep(chatId, date, time) {
  const existing = await db.collection('classes').find({ date, time }).toArray();
  const busyRooms = new Set(existing.map(c => c.room));

  const buttons = {
    inline_keyboard: ROOMS.map(r => ([{
      text: busyRooms.has(r) ? `Зал ${r} — занят` : `Зал ${r} — свободен`,
      callback_data: busyRooms.has(r) ? 'ac_room_busy' : `ac_room_${date}_${time}_${r}`,
    }]))
  };
  await sendMessage(chatId, `Дата: ${date}, время: ${time}\nВыбери зал:`, buttons);
}

async function showDirectionStep(chatId, date, time, room) {
  const directions = await getDirections();
  const buttons = {
    inline_keyboard: directions.map((name, i) => ([{
      text: name,
      callback_data: `ac_dir_${date}_${time}_${room}_${i}`,
    }]))
  };
  await sendMessage(chatId, `Дата: ${date}, время: ${time}, зал ${room}\nВыбери направление:`, buttons);
}

async function showTrainerStep(chatId, date, time, room, directionName) {
  const trainers = await db.collection('trainers').find({}).toArray();
  const buttons = {
    inline_keyboard: trainers.map(t => ([{
      text: t.name,
      callback_data: `ac_confirm_${date}_${time}_${room}_${encodeURIComponent(directionName)}_${t.telegramId}`,
    }]))
  };
  await sendMessage(chatId, `Дата: ${date}, время: ${time}, зал ${room}, направление: ${directionName}\nКто ведёт?`, buttons);
}

async function createClass(chatId, callbackQueryId, date, time, room, directionName, trainerId) {
  const trainer = await db.collection('trainers').findOne({ telegramId: trainerId });
  try {
    await db.collection('classes').insertOne({
      date, time, room: Number(room),
      direction: directionName,
      trainerId: Number(trainerId),
      trainerName: trainer ? trainer.name : 'Неизвестно',
      createdAt: new Date(),
    });
    await answerCallback(callbackQueryId, '✅ Занятие создано');
    await sendMessage(chatId, `✅ Занятие создано:\n${date} ${time}, зал ${room}, ${directionName}, тренер: ${trainer ? trainer.name : '—'}`);
  } catch (err) {
    if (err.code === 11000) {
      await answerCallback(callbackQueryId, 'Этот зал уже занят на это время!');
      await sendMessage(chatId, '⚠️ Кто-то уже успел занять этот зал на это время. Начни заново: /start');
    } else {
      console.error('Ошибка создания занятия:', err);
      await answerCallback(callbackQueryId, 'Ошибка');
    }
  }
}

// ---------- Календарь ----------
async function startCalendar(chatId) {
  const days = getNext7Days();
  const buttons = {
    inline_keyboard: days.map(d => ([{ text: d.label, callback_data: `cal_day_${d.iso}` }]))
  };
  await sendMessage(chatId, 'Какой день посмотреть?', buttons);
}

async function showDayAgenda(chatId, date) {
  const classes = await db.collection('classes').find({ date }).sort({ time: 1 }).toArray();
  if (!classes.length) {
    return await sendMessage(chatId, `На ${date} занятий пока нет.`);
  }
  const buttons = {
    inline_keyboard: classes.map(c => ([{
      text: `${c.time} зал ${c.room} — ${c.direction}`,
      callback_data: `cal_view_${c._id}`,
    }]))
  };
  await sendMessage(chatId, `Занятия на ${date}:`, buttons);
}

async function showClassDetail(chatId, classId) {
  const cls = await db.collection('classes').findOne({ _id: new ObjectId(classId) });
  if (!cls) return await sendMessage(chatId, 'Занятие не найдено (возможно, удалено).');

  // Участники пока берутся из старой системы записи по classId старого расписания —
  // для новых занятий это будет подключено на следующем этапе, когда ученики
  // начнут бронировать именно эти занятия, а не старое статичное расписание.
  const participants = await db.collection('bookings').find({ classId: String(cls._id) }).toArray();
  const participantsText = participants.length
    ? participants.map((p, i) => `${i + 1}. @${p.username}`).join('\n')
    : 'пока никто не записан';

  await sendMessage(chatId,
    `📌 ${cls.date} ${cls.time}, зал ${cls.room}\n` +
    `Направление: ${cls.direction}\n` +
    `Тренер: ${cls.trainerName}\n\n` +
    `Участники:\n${participantsText}`
  );
}

// Обработка кнопок
async function handleCallback(chatId, data, callbackQueryId, fromUser) {
    // ===== АДМИНКА (старая) =====
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

    // ===== НОВОЕ: тренеры / направления / занятия / календарь (только для ADMIN_ID) =====
    if (chatId === ADMIN_ID) {
        if (data === 'admin_add_trainer') {
            await answerCallback(callbackQueryId);
            return await startAddTrainer(chatId);
        }
        if (data === 'admin_add_direction') {
            await answerCallback(callbackQueryId);
            return await startAddDirection(chatId);
        }
        if (data === 'ac_start') {
            await answerCallback(callbackQueryId);
            return await startAddClass(chatId);
        }
        if (data.startsWith('ac_day_')) {
            const date = data.replace('ac_day_', '');
            await answerCallback(callbackQueryId);
            return await showTimeStep(chatId, date);
        }
        if (data.startsWith('ac_time_')) {
            // data выглядит как: ac_time_2026-07-28_09:00
            const rest = data.replace('ac_time_', '');
            const [d, t] = rest.split('_');
            await answerCallback(callbackQueryId);
            return await showRoomStep(chatId, d, t);
        }
        if (data === 'ac_room_busy') {
            return await answerCallback(callbackQueryId, 'Этот зал уже занят в это время');
        }
        if (data.startsWith('ac_room_')) {
            const rest = data.replace('ac_room_', '');
            const [d, t, r] = rest.split('_');
            await answerCallback(callbackQueryId);
            return await showDirectionStep(chatId, d, t, r);
        }
        if (data.startsWith('ac_dir_')) {
            const rest = data.replace('ac_dir_', '');
            const [d, t, r, idx] = rest.split('_');
            const directions = await getDirections();
            const directionName = directions[Number(idx)];
            await answerCallback(callbackQueryId);
            return await showTrainerStep(chatId, d, t, r, directionName);
        }
        if (data.startsWith('ac_confirm_')) {
            const rest = data.replace('ac_confirm_', '');
            const [d, t, r, encodedDir, trainerId] = rest.split('_');
            return await createClass(chatId, callbackQueryId, d, t, r, decodeURIComponent(encodedDir), trainerId);
        }
        if (data === 'cal_start') {
            await answerCallback(callbackQueryId);
            return await startCalendar(chatId);
        }
        if (data.startsWith('cal_day_')) {
            const date = data.replace('cal_day_', '');
            await answerCallback(callbackQueryId);
            return await showDayAgenda(chatId, date);
        }
        if (data.startsWith('cal_view_')) {
            const classId = data.replace('cal_view_', '');
            await answerCallback(callbackQueryId);
            return await showClassDetail(chatId, classId);
        }
    }
    // ===== КОНЕЦ НОВОГО =====

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

      // Если у админа открыт пошаговый диалог (добавление тренера/направления) — ведём его дальше
      if (chatId === ADMIN_ID && adminSessions.has(chatId) && !msg.text.startsWith('/')) {
        const session = adminSessions.get(chatId);
        if (session.flow === 'add_trainer') await handleAddTrainerText(chatId, msg.text);
        else if (session.flow === 'add_direction') await handleAddDirectionText(chatId, msg.text);
        return res.sendStatus(200);
      }

      if (msg.text === '/start') await handleStart(chatId);
      else if (msg.text === '/book') await handleBook(chatId);
      else if (msg.text === '/schedule') await handleSchedule(chatId);
      else if (msg.text === '/mybooking') await handleMyBooking(chatId);
      else if (msg.text === '/cancel') await handleCancel(chatId);
      else if (msg.text === '/admin') await handleAdmin(chatId);
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
