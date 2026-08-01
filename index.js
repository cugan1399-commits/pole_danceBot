import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient, ObjectId } from 'mongodb';
import cron from 'node-cron';

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
const GROUPS = ['Новичок', 'Standard', 'Pro']; // группы для анкеты-заявки

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
    // Не даёт создать два занятия в одном зале в одно и то же время (по дням недели, без привязки к дате)
    await db.collection('classes').createIndex({ day: 1, time: 1, room: 1 }, { unique: true });
    // Бронирования именно новых занятий — используется анкетой-заявкой ниже
    await db.collection('classBookings').createIndex({ classId: 1, chatId: 1 }, { unique: true });
    // Заявки от обычных участников ("хочу записаться")
    await db.collection('applications').createIndex({ chatId: 1, status: 1 });

    // Регистрируем главного админа как тренера по умолчанию — имя обновляем при каждом старте,
    // чтобы поправить, если раньше уже была сохранена другая надпись
    await db.collection('trainers').updateOne(
      { telegramId: ADMIN_ID },
      { $set: { name: 'Рома' }, $setOnInsert: { telegramId: ADMIN_ID, addedAt: new Date() } },
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

// ===================== API ДЛЯ MINI APP — НОВАЯ СИСТЕМА (тренеры/направления/занятия/календарь) =====================
// Всё это видно в Mini App только тому, чей Telegram ID совпадает с ADMIN_ID.

function getVerifiedAdmin(initData) {
  const user = verifyInitData(initData || '');
  if (!user || user.id !== ADMIN_ID) return null;
  return user;
}

// Кто открыл приложение — обычный ученик или админ
app.get('/api/me', (req, res) => {
  const user = verifyInitData(req.query.initData || '');
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  res.json({ id: user.id, username: user.username || null, isAdmin: user.id === ADMIN_ID });
});

// Список направлений — доступен всем (нужен и для формы создания занятия)
app.get('/api/directions', async (req, res) => {
  res.json(await getDirections());
});

app.post('/api/admin/directions', async (req, res) => {
  const admin = getVerifiedAdmin(req.body.initData);
  if (!admin) return res.status(403).json({ error: 'forbidden' });

  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name_required' });

  try {
    await db.collection('directions').insertOne({ name, addedAt: new Date() });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'already_exists' });
    console.error('Ошибка добавления направления (API):', err);
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/admin/trainers', async (req, res) => {
  const admin = getVerifiedAdmin(req.query.initData);
  if (!admin) return res.status(403).json({ error: 'forbidden' });

  const trainers = await db.collection('trainers').find({}).sort({ addedAt: 1 }).toArray();
  res.json(trainers);
});

app.post('/api/admin/trainers', async (req, res) => {
  const admin = getVerifiedAdmin(req.body.initData);
  if (!admin) return res.status(403).json({ error: 'forbidden' });

  const telegramId = parseInt(req.body.telegramId, 10);
  const name = (req.body.name || '').trim();
  if (!telegramId || !name) return res.status(400).json({ error: 'invalid_input' });

  try {
    await db.collection('trainers').insertOne({ telegramId, name, addedAt: new Date() });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'already_exists' });
    console.error('Ошибка добавления тренера (API):', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// Список занятий — можно за конкретный день недели (?day=mon) или все сразу
app.get('/api/admin/classes', async (req, res) => {
  const admin = getVerifiedAdmin(req.query.initData);
  if (!admin) return res.status(403).json({ error: 'forbidden' });

  const filter = req.query.day ? { day: req.query.day } : {};
  const classes = await db.collection('classes').find(filter).sort({ time: 1 }).toArray();
  res.json(classes);
});

app.post('/api/admin/classes', async (req, res) => {
  const admin = getVerifiedAdmin(req.body.initData);
  if (!admin) return res.status(403).json({ error: 'forbidden' });

  const { day, time, room, direction, trainerId, group, applicationId } = req.body;
  if (!day || !time || !room || !direction || !trainerId) {
    return res.status(400).json({ error: 'invalid_input' });
  }

  const trainer = await db.collection('trainers').findOne({ telegramId: Number(trainerId) });

  try {
    const result = await db.collection('classes').insertOne({
      day, time, room: Number(room),
      direction,
      trainerId: Number(trainerId),
      trainerName: trainer ? trainer.name : 'Неизвестно',
      group: group || null,
      createdAt: new Date(),
    });

    if (applicationId) {
      const application = await db.collection('applications').findOne({ _id: new ObjectId(applicationId) });
      if (application) await bindApplicationToClass(application, result.insertedId);
    }

    res.json({ ok: true, id: result.insertedId, classId: result.insertedId });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'slot_taken' });
    console.error('Ошибка создания занятия (API):', err);
    res.status(500).json({ error: 'server_error' });
  }
});

app.delete('/api/admin/classes/:id', async (req, res) => {
  const admin = getVerifiedAdmin(req.query.initData);
  if (!admin) return res.status(403).json({ error: 'forbidden' });

  const classId = req.params.id;
  await db.collection('classes').deleteOne({ _id: new ObjectId(classId) });
  await db.collection('classBookings').deleteMany({ classId });
  // Если на это занятие была назначена заявка — возвращаем её в статус ожидания
  await db.collection('applications').updateMany(
    { confirmedClassId: new ObjectId(classId) },
    { $unset: { confirmedClassId: '', confirmedAt: '' }, $set: { status: 'pending' } }
  );
  res.json({ ok: true });
});

// Календарь: по конкретной дате находим день недели и отдаём занятия этого дня недели + участников
const CALENDAR_WEEKDAY_MAP = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']; // JS getDay(): 0=Вс

app.get('/api/admin/calendar', async (req, res) => {
  const admin = getVerifiedAdmin(req.query.initData);
  if (!admin) return res.status(403).json({ error: 'forbidden' });

  const dateStr = req.query.date; // YYYY-MM-DD
  if (!dateStr) return res.status(400).json({ error: 'date_required' });

  const jsDate = new Date(dateStr + 'T00:00:00');
  const dayKey = CALENDAR_WEEKDAY_MAP[jsDate.getDay()];

  const classes = await db.collection('classes').find({ day: dayKey }).sort({ time: 1 }).toArray();

  const withParticipants = await Promise.all(classes.map(async (c) => {
    // Участники подключим сюда, когда ученики начнут бронировать именно новые занятия
    const participants = await db.collection('classBookings').find({ classId: String(c._id) }).toArray();
    return { ...c, participants: participants.map(p => ({ username: p.username, chatId: p.chatId })) };
  }));

  res.json({ date: dateStr, day: dayKey, classes: withParticipants });
});

app.delete('/api/admin/class-bookings/:id', async (req, res) => {
  const admin = getVerifiedAdmin(req.query.initData);
  if (!admin) return res.status(403).json({ error: 'forbidden' });

  await db.collection('classBookings').deleteOne({ _id: new ObjectId(req.params.id) });
  res.json({ ok: true });
});

// ===================== АНКЕТА-ЗАЯВКА ДЛЯ ОБЫЧНЫХ УЧАСТНИКОВ =====================

// Список тренеров — публичный (нужен на шаге выбора тренера в анкете)
app.get('/api/trainers', async (req, res) => {
  const trainers = await db.collection('trainers').find({}).sort({ addedAt: 1 }).toArray();
  res.json(trainers.map(t => ({ telegramId: t.telegramId, name: t.name })));
});

function formatAvailability(list) {
  const byDay = {};
  list.forEach(({ day, time }) => {
    (byDay[day] = byDay[day] || []).push(time);
  });
  return WEEKDAYS
    .map(d => (byDay[d.key] ? `${d.label}: ${byDay[d.key].sort().join(', ')}` : null))
    .filter(Boolean)
    .join('\n') || '—';
}

// Отправка анкеты-заявки
app.post('/api/apply', async (req, res) => {
  const user = verifyInitData(req.body.initData || '');
  if (!user) return res.status(401).json({ error: 'unauthorized' });

  const { direction, trainerId, group, availability, name, phone } = req.body;
  if (!direction || !group || !name || !phone || !Array.isArray(availability) || !availability.length) {
    return res.status(400).json({ error: 'invalid_input' });
  }
  if (!GROUPS.includes(group)) return res.status(400).json({ error: 'invalid_group' });

  let trainer = null;
  if (trainerId) {
    trainer = await db.collection('trainers').findOne({ telegramId: Number(trainerId) });
  }

  const doc = {
    chatId: user.id,
    username: user.username || null,
    firstName: user.first_name || '',
    name: String(name).trim(),
    phone: String(phone).trim(),
    direction,
    trainerId: trainer ? trainer.telegramId : null,
    trainerName: trainer ? trainer.name : null,
    group,
    availability,
    status: 'pending',
    createdAt: new Date(),
  };

  const result = await db.collection('applications').insertOne(doc);

  const target = trainer ? trainer.telegramId : ADMIN_ID;
  try {
    await sendMessage(
      target,
      `📝 <b>Новая заявка на запись</b>\n\n` +
        `Имя: ${doc.name}\n` +
        `Ник: ${doc.username ? '@' + doc.username : '—'}\n` +
        `Телефон: ${doc.phone}\n` +
        `Направление: ${doc.direction}\n` +
        `Группа: ${doc.group}\n` +
        `Тренер: ${trainer ? trainer.name : 'не выбран (главный админ)'}\n\n` +
        `Доступное время:\n${formatAvailability(availability)}`,
      { inline_keyboard: [[{ text: '🗓 Открыть заявку в приложении', web_app: { url: `${WEBAPP_URL}/?app=${result.insertedId}` } }]] }
    );
  } catch (err) {
    console.error('Не удалось уведомить о заявке:', err.message);
  }

  res.json({ ok: true, id: result.insertedId });
});

// Заявки текущего участника (посмотреть статус)
app.get('/api/myapplications', async (req, res) => {
  const user = verifyInitData(req.query.initData || '');
  if (!user) return res.status(401).json({ error: 'unauthorized' });

  const apps = await db.collection('applications').find({ chatId: user.id }).sort({ createdAt: -1 }).toArray();
  res.json(apps);
});

// Подтверждённые занятия участника ("Моё расписание")
app.get('/api/myschedule', async (req, res) => {
  const user = verifyInitData(req.query.initData || '');
  if (!user) return res.status(401).json({ error: 'unauthorized' });

  const bookings = await db.collection('classBookings').find({ chatId: user.id }).toArray();
  const classIds = bookings.map(b => new ObjectId(b.classId));
  const classes = classIds.length
    ? await db.collection('classes').find({ _id: { $in: classIds } }).toArray()
    : [];

  const merged = classes.map(c => ({
    ...c,
    dayLabel: WEEKDAYS.find(d => d.key === c.day)?.label || c.day,
  }));
  res.json(merged);
});

// ---------- Админ: список заявок и назначение конкретного занятия ----------

app.get('/api/admin/applications', async (req, res) => {
  const admin = getVerifiedAdmin(req.query.initData);
  if (!admin) return res.status(403).json({ error: 'forbidden' });

  const status = req.query.status || 'pending';
  const apps = await db.collection('applications').find({ status }).sort({ createdAt: 1 }).toArray();
  res.json(apps);
});

// Общая функция: привязать заявку к конкретному занятию (просто бронь + пометка, каким занятием закрыта заявка).
// Уведомление участнику НЕ отправляется здесь — это отдельное явное действие админа (см. /send-confirmation ниже),
// чтобы можно было сначала спокойно всё проверить и поправить.
async function bindApplicationToClass(application, classId) {
  const cls = await db.collection('classes').findOne({ _id: new ObjectId(classId) });
  if (!cls) return null;

  try {
    await db.collection('classBookings').insertOne({
      classId: String(cls._id),
      chatId: application.chatId,
      username: application.username,
      firstName: application.firstName,
      group: application.group,
      applicationId: application._id,
      bookedAt: new Date(),
    });
  } catch (err) {
    if (err.code !== 11000) throw err; // уже был записан на это же занятие — не критично
  }

  await db.collection('applications').updateOne(
    { _id: application._id },
    { $set: { confirmedClassId: cls._id } }
  );

  return cls;
}

// Отправить участнику подтверждение по уже назначенному занятию — отдельная явная кнопка у админа
app.post('/api/admin/applications/:id/send-confirmation', async (req, res) => {
  const admin = getVerifiedAdmin(req.body.initData);
  if (!admin) return res.status(403).json({ error: 'forbidden' });

  const application = await db.collection('applications').findOne({ _id: new ObjectId(req.params.id) });
  if (!application || !application.confirmedClassId) return res.status(400).json({ error: 'not_bound' });

  const cls = await db.collection('classes').findOne({ _id: application.confirmedClassId });
  if (!cls) return res.status(404).json({ error: 'class_not_found' });

  try {
    const dayLbl = WEEKDAYS.find(d => d.key === cls.day)?.label || cls.day;
    await sendMessage(
      application.chatId,
      `✅ <b>Вас записали на занятие!</b>\n\n${dayLbl}, ${cls.time}, зал ${cls.room}\nНаправление: ${cls.direction}\nТренер: ${cls.trainerName}`
    );
  } catch (err) {
    console.error('Не удалось уведомить участника о назначении:', err.message);
    return res.status(500).json({ error: 'send_failed' });
  }

  await db.collection('applications').updateOne(
    { _id: application._id },
    { $set: { status: 'confirmed', confirmedAt: new Date() } }
  );

  res.json({ ok: true });
});

// Одна заявка целиком (актуальные данные — например, после привязки к занятию)
app.get('/api/admin/applications/:id', async (req, res) => {
  const admin = getVerifiedAdmin(req.query.initData);
  if (!admin) return res.status(403).json({ error: 'forbidden' });

  const application = await db.collection('applications').findOne({ _id: new ObjectId(req.params.id) });
  if (!application) return res.status(404).json({ error: 'not_found' });
  res.json(application);
});

// Удалить заявку целиком (например, участник ошибся при заполнении анкеты)
app.delete('/api/admin/applications/:id', async (req, res) => {
  const admin = getVerifiedAdmin(req.query.initData);
  if (!admin) return res.status(403).json({ error: 'forbidden' });

  await db.collection('applications').deleteOne({ _id: new ObjectId(req.params.id) });
  res.json({ ok: true });
});

// Агенда конкретного дня и зала — все часы, с уже созданными занятиями и их участниками
app.get('/api/admin/agenda', async (req, res) => {
  const admin = getVerifiedAdmin(req.query.initData);
  if (!admin) return res.status(403).json({ error: 'forbidden' });

  const { day, room } = req.query;
  if (!day || !room) return res.status(400).json({ error: 'invalid_input' });

  const classes = await db.collection('classes').find({ day, room: Number(room) }).toArray();
  const classIds = classes.map(c => String(c._id));
  const bookings = classIds.length
    ? await db.collection('classBookings').find({ classId: { $in: classIds } }).toArray()
    : [];

  res.json(classes.map(c => ({
    ...c,
    participants: bookings
      .filter(b => b.classId === String(c._id))
      .map(b => ({
        chatId: b.chatId,
        name: b.firstName || (b.username ? '@' + b.username : 'Без имени'),
        username: b.username,
        group: b.group || null,
      })),
  })));
});

// Точечное изменение занятия: группа / направление / тренер
app.patch('/api/admin/classes/:id', async (req, res) => {
  const admin = getVerifiedAdmin(req.body.initData);
  if (!admin) return res.status(403).json({ error: 'forbidden' });

  const updates = {};
  if (req.body.group !== undefined) updates.group = req.body.group;
  if (req.body.direction !== undefined) updates.direction = req.body.direction;
  if (req.body.trainerId !== undefined) {
    const trainer = await db.collection('trainers').findOne({ telegramId: Number(req.body.trainerId) });
    updates.trainerId = Number(req.body.trainerId);
    updates.trainerName = trainer ? trainer.name : 'Неизвестно';
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'invalid_input' });

  await db.collection('classes').updateOne({ _id: new ObjectId(req.params.id) }, { $set: updates });
  res.json({ ok: true });
});

// Добавить заявителя в участники существующего занятия
app.post('/api/admin/classes/:id/participants', async (req, res) => {
  const admin = getVerifiedAdmin(req.body.initData);
  if (!admin) return res.status(403).json({ error: 'forbidden' });

  const application = await db.collection('applications').findOne({ _id: new ObjectId(req.body.applicationId) });
  if (!application) return res.status(404).json({ error: 'not_found' });

  await bindApplicationToClass(application, req.params.id);
  res.json({ ok: true });
});

// Убрать участника из занятия
app.delete('/api/admin/classes/:id/participants/:chatId', async (req, res) => {
  const admin = getVerifiedAdmin(req.query.initData);
  if (!admin) return res.status(403).json({ error: 'forbidden' });

  await db.collection('classBookings').deleteOne({ classId: req.params.id, chatId: Number(req.params.chatId) });
  res.json({ ok: true });
});

// ===================== НАПОМИНАНИЯ О ТРЕНИРОВКЕ (за 1 час, с подтверждением Да/Нет) =====================

const STUDIO_TIMEZONE = 'Europe/Minsk'; // ← поменяй, если студия в другом часовом поясе
const sentReminders = new Set(); // ключ `${classId}_${dateStr}`, чтобы не слать напоминание дважды
const reminderReplySessions = new Map(); // chatId -> { classId } — ждём от участника причину отказа

function pad2(n) { return String(n).padStart(2, '0'); }

function nowInStudioTZ() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: STUDIO_TIMEZONE,
    weekday: 'short', hour: '2-digit', minute: '2-digit',
    year: 'numeric', month: '2-digit', day: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const map = {};
  parts.forEach(p => { map[p.type] = p.value; });
  const weekdayMap = { Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat', Sun: 'sun' };
  return {
    day: weekdayMap[map.weekday],
    time: `${map.hour}:${map.minute}`,
    dateStr: `${map.year}-${map.month}-${map.day}`,
  };
}

function subtractOneHour(time) {
  let [h, m] = time.split(':').map(Number);
  h -= 1;
  if (h < 0) h += 24;
  return `${pad2(h)}:${pad2(m)}`;
}

cron.schedule('* * * * *', async () => {
  if (!db) return;
  try {
    const { day, time, dateStr } = nowInStudioTZ();
    const classesToday = await db.collection('classes').find({ day }).toArray();

    for (const cls of classesToday) {
      if (subtractOneHour(cls.time) !== time) continue;

      const key = `${cls._id}_${dateStr}`;
      if (sentReminders.has(key)) continue;
      sentReminders.add(key);

      const bookings = await db.collection('classBookings').find({ classId: String(cls._id) }).toArray();
      for (const b of bookings) {
        try {
          await sendMessage(
            b.chatId,
            `⏰ Сегодня у вас тренировка в ${cls.time} (${cls.direction}, зал ${cls.room}).\nВы будете?`,
            {
              inline_keyboard: [[
                { text: '✅ Да', callback_data: `rem_yes_${cls._id}` },
                { text: '❌ Нет', callback_data: `rem_no_${cls._id}` },
              ]],
            }
          );
        } catch (err) {
          console.error('Не удалось отправить напоминание:', err.message);
        }
      }
    }
  } catch (err) {
    console.error('Ошибка планировщика напоминаний:', err);
  }
});

// ===================== СУЩЕСТВУЮЩАЯ ЛОГИКА БОТА (без изменений) =====================

async function handleStart(chatId) {
  // Создаем пустую разметку, чтобы удалить старую обычную клавиатуру, если она где-то осталась
  const removeMarkup = {
    remove_keyboard: true
  };

  await sendMessage(
    chatId, 
    '👋 Привет! Я бот для записи на занятияe.\n\nВсё управление и запись теперь находятся внутри нашего мини-приложения.\n\nНажми кнопку «Запись» в самом низу экрана (слева от поля ввода), чтобы войти!', 
    { reply_markup: removeMarkup }
  );
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

const WEEKDAYS = [
  { key: 'mon', label: 'Понедельник' },
  { key: 'tue', label: 'Вторник' },
  { key: 'wed', label: 'Среда' },
  { key: 'thu', label: 'Четверг' },
  { key: 'fri', label: 'Пятница' },
  { key: 'sat', label: 'Суббота' },
  { key: 'sun', label: 'Воскресенье' },
];

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
  const buttons = {
    inline_keyboard: WEEKDAYS.map(d => ([{ text: d.label, callback_data: `ac_day_${d.key}` }]))
  };
  await sendMessage(chatId, 'Выбери день недели для нового занятия:', buttons);
}

async function showTimeStep(chatId, day) {
  // Показываем занятость по каждому часу (если хотя бы один зал занят - помечаем)
  const existing = await db.collection('classes').find({ day }).toArray();
  const busyHours = new Set(existing.map(c => c.time));

  const dayLabel = WEEKDAYS.find(d => d.key === day)?.label || day;
  const buttons = {
    inline_keyboard: WORK_HOURS.map(h => ([{
      text: busyHours.has(h) ? `${h} (частично занято)` : `${h} (свободно)`,
      callback_data: `ac_time_${day}_${h}`,
    }]))
  };
  await sendMessage(chatId, `День: ${dayLabel}\nВыбери время:`, buttons);
}

async function showRoomStep(chatId, day, time) {
  const existing = await db.collection('classes').find({ day, time }).toArray();
  const busyRooms = new Set(existing.map(c => c.room));

  const dayLabel = WEEKDAYS.find(d => d.key === day)?.label || day;
  const buttons = {
    inline_keyboard: ROOMS.map(r => ([{
      text: busyRooms.has(r) ? `Зал ${r} — занят` : `Зал ${r} — свободен`,
      callback_data: busyRooms.has(r) ? 'ac_room_busy' : `ac_room_${day}_${time}_${r}`,
    }]))
  };
  await sendMessage(chatId, `День: ${dayLabel}, время: ${time}\nВыбери зал:`, buttons);
}

async function showDirectionStep(chatId, day, time, room) {
  const directions = await getDirections();
  const dayLabel = WEEKDAYS.find(d => d.key === day)?.label || day;
  const buttons = {
    inline_keyboard: directions.map((name, i) => ([{
      text: name,
      callback_data: `ac_dir_${day}_${time}_${room}_${i}`,
    }]))
  };
  await sendMessage(chatId, `День: ${dayLabel}, время: ${time}, зал ${room}\nВыбери направление:`, buttons);
}

async function showTrainerStep(chatId, day, time, room, directionName) {
  const trainers = await db.collection('trainers').find({}).toArray();
  const dayLabel = WEEKDAYS.find(d => d.key === day)?.label || day;
  const buttons = {
    inline_keyboard: trainers.map(t => ([{
      text: t.name,
      callback_data: `ac_confirm_${day}_${time}_${room}_${encodeURIComponent(directionName)}_${t.telegramId}`,
    }]))
  };
  await sendMessage(chatId, `День: ${dayLabel}, время: ${time}, зал ${room}, направление: ${directionName}\nКто ведёт?`, buttons);
}

async function createClass(chatId, callbackQueryId, day, time, room, directionName, trainerId) {
  const trainer = await db.collection('trainers').findOne({ telegramId: Number(trainerId) });
  const dayLabel = WEEKDAYS.find(d => d.key === day)?.label || day;
  try {
    await db.collection('classes').insertOne({
      day, time, room: Number(room),
      direction: directionName,
      trainerId: Number(trainerId),
      trainerName: trainer ? trainer.name : 'Неизвестно',
      createdAt: new Date(),
    });
    await answerCallback(callbackQueryId, '✅ Занятие создано');
    await sendMessage(chatId, `✅ Занятие создано:\n${dayLabel} ${time}, зал ${room}, ${directionName}, тренер: ${trainer ? trainer.name : '—'}`);
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
  const buttons = {
    inline_keyboard: WEEKDAYS.map(d => ([{ text: d.label, callback_data: `cal_day_${d.key}` }]))
  };
  await sendMessage(chatId, 'Какой день недели посмотреть?', buttons);
}

async function showDayAgenda(chatId, day) {
  const classes = await db.collection('classes').find({ day }).sort({ time: 1 }).toArray();
  const dayLabel = WEEKDAYS.find(d => d.key === day)?.label || day;
  if (!classes.length) {
    return await sendMessage(chatId, `На ${dayLabel} занятий пока нет.`);
  }
  const buttons = {
    inline_keyboard: classes.map(c => ([{
      text: `${c.time} зал ${c.room} — ${c.direction}`,
      callback_data: `cal_view_${c._id}`,
    }]))
  };
  await sendMessage(chatId, `Занятия по ${dayLabel}м:`, buttons);
}

async function showClassDetail(chatId, classId) {
  const cls = await db.collection('classes').findOne({ _id: new ObjectId(classId) });
  if (!cls) return await sendMessage(chatId, 'Занятие не найдено (возможно, удалено).');

  const dayLabel = WEEKDAYS.find(d => d.key === cls.day)?.label || cls.day;

  // Участники пока берутся из старой системы записи по classId старого расписания —
  // для новых занятий это будет подключено на следующем этапе, когда ученики
  // начнут бронировать именно эти занятия, а не старое статичное расписание.
  const participants = await db.collection('bookings').find({ classId: String(cls._id) }).toArray();
  const participantsText = participants.length
    ? participants.map((p, i) => `${i + 1}. @${p.username}`).join('\n')
    : 'пока никто не записан';

  await sendMessage(chatId,
    `📌 ${dayLabel} ${cls.time}, зал ${cls.room}\n` +
    `Направление: ${cls.direction}\n` +
    `Тренер: ${cls.trainerName}\n\n` +
    `Участники:\n${participantsText}`
  );
}

// Обработка кнопок
async function handleCallback(chatId, data, callbackQueryId, fromUser) {
    // ===== Напоминание о тренировке: подтверждение Да/Нет =====
    if (data.startsWith('rem_yes_')) {
        await answerCallback(callbackQueryId, 'Отлично, ждём вас!');
        await sendMessage(chatId, '👍 Записали, что вы будете. До встречи на тренировке!');
        return;
    }
    if (data.startsWith('rem_no_')) {
        const classId = data.replace('rem_no_', '');
        reminderReplySessions.set(chatId, { classId });
        await answerCallback(callbackQueryId);
        await sendMessage(chatId, 'Жаль! Напишите, пожалуйста, одним сообщением причину — передам тренеру.');
        return;
    }

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
            const day = data.replace('ac_day_', '');
            await answerCallback(callbackQueryId);
            return await showTimeStep(chatId, day);
        }
        if (data.startsWith('ac_time_')) {
            // data выглядит как: ac_time_mon_09:00
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
            const day = data.replace('cal_day_', '');
            await answerCallback(callbackQueryId);
            return await showDayAgenda(chatId, day);
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

      // Участник только что нажал "Нет" на напоминание — это сообщение является причиной отказа
      if (reminderReplySessions.has(chatId)) {
        const { classId } = reminderReplySessions.get(chatId);
        reminderReplySessions.delete(chatId);

        const cls = await db.collection('classes').findOne({ _id: new ObjectId(classId) });
        await sendMessage(chatId, 'Спасибо, передал(а) тренеру.');
        if (cls) {
          const dayLbl = WEEKDAYS.find(d => d.key === cls.day)?.label || cls.day;
          const notifyTarget = cls.trainerId || ADMIN_ID;
          await sendMessage(
            notifyTarget,
            `❌ <b>Отмена участия в занятии</b>\n${dayLbl} ${cls.time}, ${cls.direction}, зал ${cls.room}\n` +
              `Участник: ${msg.from.username ? '@' + msg.from.username : msg.from.first_name}\n` +
              `Причина: ${msg.text}`
          );
        }
        return res.sendStatus(200);
      }

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
