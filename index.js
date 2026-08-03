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
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'webapp')));

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const WEBHOOK_PATH = `/webhook/${BOT_TOKEN}`;
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const ADMIN_ID = 8658993738; // Telegram ID главного админа
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://pole-dancebot.onrender.com';

const WORK_HOURS = [];
for (let h = 9; h <= 20; h++) WORK_HOURS.push(String(h).padStart(2, '0') + ':00');

const ROOMS = [1, 2];
const GROUPS = ['Новичок', 'Standard', 'Pro'];

const STUDIO_ADDRESS = 'г. Орша, ул. Островского 11';
const STUDIO_MAPS_URL = 'https://maps.google.com/?q=' + encodeURIComponent(STUDIO_ADDRESS);
const OWNER_PHONE = '+375259125478';

function studioAddressHtml() {
  return `<a href="${STUDIO_MAPS_URL}">${STUDIO_ADDRESS}</a>`;
}

function formatTrainerName(name, username) {
  if (!name) return 'Неизвестно';
  const cleanUsername = username ? username.replace(/^@/, '') : null;
  return cleanUsername ? `${name} (@${cleanUsername})` : name;
}

function normalizeTime(time) {
  if (time == null || time === '') return null;
  const parts = String(time).trim().split(':');
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1] || '0', 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return String(time).trim();
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function normalizeRoom(room) {
  const n = Number(room);
  return Number.isFinite(n) ? n : null;
}

function isSameSlot(cls, day, time, room) {
  return cls.day === day
    && normalizeTime(cls.time) === normalizeTime(time)
    && normalizeRoom(cls.room) === normalizeRoom(room);
}

function parseObjectId(value) {
  if (!value) return null;
  if (typeof value === 'object' && value.$oid) return new ObjectId(value.$oid);
  return new ObjectId(String(value));
}

function trainerLinkHtml(name, username) {
  const cleanUsername = username ? username.replace(/^@/, '') : null;
  if (!name) return 'Неизвестно';
  const displayName = formatTrainerName(name, cleanUsername);
  return cleanUsername ? `<a href="https://t.me/${cleanUsername}">${displayName}</a>` : displayName;
}

let db;
const client = new MongoClient(MONGODB_URI);

async function connectDB() {
  try {
    await client.connect();
    db = client.db('pole_dance');
    
    await db.collection('bookings').createIndex({ chatId: 1 }, { unique: true });
    await db.collection('trainers').createIndex({ telegramId: 1 }, { unique: true });
    await db.collection('directions').createIndex({ name: 1 }, { unique: true });
    await db.collection('classes').createIndex({ day: 1, time: 1, room: 1 }, { unique: true });
    await db.collection('classBookings').createIndex({ classId: 1, chatId: 1 }, { unique: true });
    await db.collection('applications').createIndex({ chatId: 1, status: 1 });
    await db.collection('events').createIndex({ date: 1 });

    // Главный админ с возможностью обновления его username/имени
    await db.collection('trainers').updateOne(
      { telegramId: ADMIN_ID },
      { 
        $setOnInsert: { telegramId: ADMIN_ID, name: 'Владелец', username: null, isOwner: true, addedAt: new Date() },
        $set: { isOwner: true },
      },
      { upsert: true }
    );

    console.log('✅ MongoDB подключена');
  } catch (err) {
    console.error('❌ Ошибка MongoDB:', err);
  }
}
connectDB();

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

async function sendPhoto(chatId, imageData, caption) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) {
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
  }
  const ext = (imageData.mime.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
  form.append('photo', new Blob([imageData.buffer], { type: imageData.mime }), `photo.${ext}`);

  const resp = await fetch(`${API}/sendPhoto`, { method: 'POST', body: form });
  const json = await resp.json();
  if (!json.ok) throw new Error(json.description || 'sendPhoto failed');
  return json;
}

function parseDataUrl(dataUrl) {
  if (!dataUrl) return null;
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  return { mime: match[1], buffer: Buffer.from(match[2], 'base64') };
}

function answerCallback(callbackQueryId, text = '') {
  return axios.post(`${API}/answerCallbackQuery`, {
    callback_query_id: callbackQueryId,
    text,
  });
}

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

async function getVerifiedTrainerOrAdmin(initData) {
  const user = verifyInitData(initData || '');
  if (!user) return null;

  const trainer = await db.collection('trainers').findOne({ telegramId: user.id });
  const isOwner = user.id === ADMIN_ID || !!(trainer && trainer.isOwner);
  if (isOwner) return { user, isOwner: true, isTrainer: true, isAdmin: true };
  if (trainer) return { user, isOwner: false, isTrainer: true, isAdmin: false };
  return null;
}

async function getVerifiedOwner(initData) {
  const auth = await getVerifiedTrainerOrAdmin(initData || '');
  if (!auth || !auth.isOwner) return null;
  return auth;
}

// ===================== API ДЛЯ MINI APP =====================

app.get('/api/me', async (req, res) => {
  const user = verifyInitData(req.query.initData || '');
  if (!user) return res.status(401).json({ error: 'unauthorized' });

  // Авто-обновление никнейма и имени суперадмина если он входит через MiniApp
  if (user.id === ADMIN_ID) {
    await db.collection('trainers').updateOne(
      { telegramId: ADMIN_ID },
      { $set: { username: user.username || null, name: user.first_name || 'Владелец' } }
    );
  }

  const trainer = await db.collection('trainers').findOne({ telegramId: user.id });
  const isOwner = user.id === ADMIN_ID || !!(trainer && trainer.isOwner);
  res.json({ id: user.id, username: user.username || null, isOwner, isTrainer: !!trainer, isAdmin: isOwner });
});

app.get('/api/directions', async (req, res) => {
  const list = await db.collection('directions').find({}).sort({ name: 1 }).toArray();
  res.json(list);
});

app.post('/api/admin/directions', async (req, res) => {
  const auth = await getVerifiedTrainerOrAdmin(req.body.initData);
  if (!auth) return res.status(403).json({ error: 'forbidden' });

  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name_required' });

  try {
    await db.collection('directions').insertOne({ name, addedBy: auth.user.id, addedAt: new Date() });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'already_exists' });
    res.status(500).json({ error: 'server_error' });
  }
});

app.delete('/api/admin/directions/:name', async (req, res) => {
  const auth = await getVerifiedTrainerOrAdmin(req.query.initData);
  if (!auth) return res.status(403).json({ error: 'forbidden' });

  const dirName = decodeURIComponent(req.params.name);
  const dir = await db.collection('directions').findOne({ name: dirName });
  if (!dir) return res.status(404).json({ error: 'not_found' });

  // Обычный тренер удаляет только свои направления; владелец — любые
  if (!auth.isOwner && dir.addedBy !== auth.user.id) {
    return res.status(403).json({ error: 'forbidden' });
  }

  await db.collection('directions').deleteOne({ name: dirName });
  res.json({ ok: true });
});

app.get('/api/admin/trainers', async (req, res) => {
  const owner = await getVerifiedOwner(req.query.initData);
  if (!owner) return res.status(403).json({ error: 'forbidden' });

  const trainers = await db.collection('trainers').find({}).sort({ addedAt: 1 }).toArray();
  res.json(trainers);
});

app.post('/api/admin/trainers', async (req, res) => {
  const owner = await getVerifiedOwner(req.body.initData);
  if (!owner) return res.status(403).json({ error: 'forbidden' });

  const telegramId = parseInt(req.body.telegramId, 10);
  const name = (req.body.name || '').trim();
  const username = (req.body.username || '').trim().replace(/^@/, '') || null;
  const makeOwner = !!req.body.isOwner;
  if (!telegramId || !name) return res.status(400).json({ error: 'invalid_input' });

  try {
    await db.collection('trainers').insertOne({
      telegramId, name, username, isOwner: makeOwner, addedBy: owner.user.id, addedAt: new Date(),
    });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'already_exists' });
    res.status(500).json({ error: 'server_error' });
  }
});

app.delete('/api/trainers/:id', async (req, res) => {
  const owner = await getVerifiedOwner(req.query.initData);
  if (!owner) return res.status(403).json({ error: 'forbidden' });

  const telegramId = parseInt(req.params.id, 10);
  if (telegramId === ADMIN_ID) return res.status(400).json({ error: 'cannot_delete_owner' });

  await db.collection('trainers').deleteOne({ telegramId });
  res.json({ ok: true });
});

app.post('/api/admin/classes/clear-all', async (req, res) => {
  const owner = await getVerifiedOwner(req.body.initData);
  if (!owner) return res.status(403).json({ error: 'forbidden' });

  const classesCount = await db.collection('classes').countDocuments({});
  await db.collection('classes').deleteMany({});
  await db.collection('classBookings').deleteMany({});
  await db.collection('applications').updateMany(
    {},
    { $set: { status: 'pending' }, $unset: { confirmedClassId: '', confirmedClassIds: '', confirmedAt: '' } }
  );

  res.json({ ok: true, deleted: classesCount });
});

app.get('/api/admin/classes', async (req, res) => {
  const auth = await getVerifiedTrainerOrAdmin(req.query.initData);
  if (!auth) return res.status(403).json({ error: 'forbidden' });

  const filter = req.query.day ? { day: req.query.day } : {};
  const classes = await db.collection('classes').find(filter).sort({ time: 1 }).toArray();
  res.json(classes);
});

app.post('/api/admin/classes', async (req, res) => {
  const auth = await getVerifiedTrainerOrAdmin(req.body.initData);
  if (!auth) return res.status(403).json({ error: 'forbidden' });

  const { day, direction, trainerId, group, applicationId } = req.body;
  const time = normalizeTime(req.body.time);
  const room = normalizeRoom(req.body.room);

  if (!day || !time || room == null || !direction || trainerId == null || trainerId === '') {
    return res.status(400).json({
      error: 'invalid_input',
      details: { day: !!day, time: !!time, room: room != null, direction: !!direction, trainerId: trainerId != null && trainerId !== '' },
    });
  }

  let application = null;
  if (applicationId) {
    try {
      application = await db.collection('applications').findOne({ _id: parseObjectId(applicationId) });
      if (!application) return res.status(404).json({ error: 'application_not_found' });
    } catch (err) {
      console.error('Invalid applicationId:', applicationId, err.message);
      return res.status(400).json({ error: 'invalid_application_id' });
    }
  }

  const dayClasses = await db.collection('classes').find({ day }).toArray();
  const conflict = dayClasses.find(c => isSameSlot(c, day, time, room));
  if (conflict) {
    return res.status(409).json({ error: 'slot_taken', existing: conflict });
  }

  const trainer = await db.collection('trainers').findOne({ telegramId: Number(trainerId) });
  const trainerName = trainer ? trainer.name : 'Неизвестно';

  try {
    const result = await db.collection('classes').insertOne({
      day, time, room,
      direction,
      trainerId: Number(trainerId),
      trainerName,
      trainerUsername: trainer ? trainer.username : null,
      group: group || null,
      createdBy: auth.user.id,
      createdAt: new Date(),
    });

    if (application) {
      try {
        await bindApplicationToClass(application, result.insertedId);
      } catch (bindErr) {
        console.error('Class created but participant bind failed:', bindErr);
        return res.status(500).json({
          error: 'bind_failed',
          classId: result.insertedId,
          message: bindErr.message,
        });
      }
    }

    res.json({ ok: true, id: result.insertedId, classId: result.insertedId });
  } catch (err) {
    console.error('POST /api/admin/classes failed:', err);
    if (err.code === 11000) {
      // Логируем keyPattern/keyValue — если это не { day, time, room },
      // значит в базе есть лишний/устаревший unique-индекс.
      console.error('Duplicate key on index:', err.keyPattern, err.keyValue);
      const existing = dayClasses.find(c => isSameSlot(c, day, time, room))
        || await db.collection('classes').findOne({ day, time, room });
      return res.status(409).json({ error: 'slot_taken', existing });
    }
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/admin/classes/by-ids', async (req, res) => {
  const auth = await getVerifiedTrainerOrAdmin(req.query.initData);
  if (!auth) return res.status(403).json({ error: 'forbidden' });

  const ids = (req.query.ids || '').split(',').filter(Boolean);
  if (!ids.length) return res.json([]);

  const classes = await db.collection('classes').find({ _id: { $in: ids.map(id => new ObjectId(id)) } }).toArray();
  res.json(classes);
});

app.delete('/api/admin/classes/:id', async (req, res) => {
  const auth = await getVerifiedTrainerOrAdmin(req.query.initData);
  if (!auth) return res.status(403).json({ error: 'forbidden' });

  const classId = req.params.id;
  const cls = await db.collection('classes').findOne({ _id: new ObjectId(classId) });
  if (!cls) return res.status(404).json({ error: 'not_found' });

  // Обычный тренер удаляет только свои занятия; владелец — любые
  if (!auth.isOwner && cls.createdBy !== auth.user.id) {
    return res.status(403).json({ error: 'forbidden' });
  }

  await db.collection('classes').deleteOne({ _id: new ObjectId(classId) });
  await db.collection('classBookings').deleteMany({ classId });
  await db.collection('applications').updateMany(
    { $or: [{ confirmedClassIds: classId }, { confirmedClassId: new ObjectId(classId) }] },
    { $pull: { confirmedClassIds: classId }, $unset: { confirmedClassId: '', confirmedAt: '' } }
  );
  await db.collection('applications').updateMany(
    { status: 'confirmed', $or: [{ confirmedClassIds: { $size: 0 } }, { confirmedClassIds: { $exists: false } }] },
    { $set: { status: 'pending' } }
  );
  res.json({ ok: true });
});

const CALENDAR_WEEKDAY_MAP = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

app.get('/api/admin/calendar', async (req, res) => {
  const auth = await getVerifiedTrainerOrAdmin(req.query.initData);
  if (!auth) return res.status(403).json({ error: 'forbidden' });

  const dateStr = req.query.date;
  if (!dateStr) return res.status(400).json({ error: 'date_required' });

  const jsDate = new Date(dateStr + 'T00:00:00');
  const dayKey = CALENDAR_WEEKDAY_MAP[jsDate.getDay()];

  const classes = await db.collection('classes').find({ day: dayKey }).sort({ time: 1 }).toArray();
  const normalizedClasses = classes.map(c => ({ ...c, time: normalizeTime(c.time), room: normalizeRoom(c.room) ?? c.room }));

  const withParticipants = await Promise.all(normalizedClasses.map(async (c) => {
    const canView = auth.isOwner || c.trainerId === auth.user.id;
    const participants = canView
      ? await db.collection('classBookings').find({ classId: String(c._id) }).toArray()
      : [];
    return {
      ...c,
      canViewParticipants: canView,
      participants: participants.map(p => ({
        name: p.firstName || (p.username ? '@' + p.username : 'Без имени'),
        username: p.username,
        chatId: p.chatId,
        group: p.group || null,
      })),
    };
  }));

  const events = await db.collection('events').find({ date: dateStr }, { projection: { imageData: 0 } }).toArray();

  res.json({ date: dateStr, day: dayKey, classes: withParticipants, events: events.map(e => ({ ...e, hasImage: !!e.imageMime })) });
});

app.get('/api/trainers', async (req, res) => {
  const trainers = await db.collection('trainers').find({}).sort({ addedAt: 1 }).toArray();
  res.json(trainers.map(t => ({ 
    telegramId: t.telegramId, 
    name: formatTrainerName(t.name, t.username),
    rawName: t.name,
    username: t.username || null 
  })));
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

app.post('/api/apply', async (req, res) => {
  const user = verifyInitData(req.body.initData || '');
  if (!user) return res.status(401).json({ error: 'unauthorized' });

  const { direction, trainerId, group, availability, name, phone, usernameOverride } = req.body;
  if (!direction || !group || !name || !phone || !Array.isArray(availability) || !availability.length) {
    return res.status(400).json({ error: 'invalid_input' });
  }

  let trainer = null;
  if (trainerId) {
    trainer = await db.collection('trainers').findOne({ telegramId: Number(trainerId) });
  }

  const isTrainerOrAdmin = user.id === ADMIN_ID || !!(await db.collection('trainers').findOne({ telegramId: user.id }));
  const cleanOverride = (usernameOverride || '').trim().replace(/^@/, '');
  const finalUsername = isTrainerOrAdmin && cleanOverride ? cleanOverride : (user.username || null);

  const doc = {
    chatId: user.id,
    username: finalUsername,
    submittedByAdmin: isTrainerOrAdmin && !!cleanOverride,
    firstName: user.first_name || '',
    name: String(name).trim(),
    phone: String(phone).trim(),
    direction,
    trainerId: trainer ? trainer.telegramId : null,
    trainerName: trainer ? formatTrainerName(trainer.name, trainer.username) : null,
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
        `Тренер: ${trainer ? formatTrainerName(trainer.name, trainer.username) : 'не выбран (главный админ)'}\n\n` +
        `Доступное время:\n${formatAvailability(availability)}`,
      { inline_keyboard: [[{ text: '🗓 Открыть заявку в приложении', web_app: { url: `${WEBAPP_URL}/?app=${result.insertedId}` } }]] }
    );
  } catch (err) {
    console.error('Не удалось уведомить о заявке:', err.message);
  }

  res.json({ ok: true, id: result.insertedId });
});

app.get('/api/myapplications', async (req, res) => {
  const user = verifyInitData(req.query.initData || '');
  if (!user) return res.status(401).json({ error: 'unauthorized' });

  const apps = await db.collection('applications').find({ chatId: user.id }).sort({ createdAt: -1 }).toArray();
  res.json(apps);
});

const WEEKDAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
function sortByWeekdayThenTime(list) {
  return list.sort((a, b) => {
    const dayDiff = WEEKDAY_ORDER.indexOf(a.day) - WEEKDAY_ORDER.indexOf(b.day);
    if (dayDiff !== 0) return dayDiff;
    return (a.time || '').localeCompare(b.time || '');
  });
}

app.get('/api/myschedule', async (req, res) => {
  const user = verifyInitData(req.query.initData || '');
  if (!user) return res.status(401).json({ error: 'unauthorized' });

  const trainer = await db.collection('trainers').findOne({ telegramId: user.id });

  if (trainer) {
    const classes = sortByWeekdayThenTime(
      await db.collection('classes').find({ trainerId: user.id }).toArray()
    );
    const classIds = classes.map(c => String(c._id));
    const bookings = classIds.length
      ? await db.collection('classBookings').find({ classId: { $in: classIds } }).toArray()
      : [];

    const merged = classes.map(c => ({
      ...c,
      dayLabel: WEEKDAYS.find(d => d.key === c.day)?.label || c.day,
      participants: bookings
        .filter(b => b.classId === String(c._id))
        .map(b => ({ name: b.firstName || (b.username ? '@' + b.username : 'Без имени'), username: b.username, group: b.group || null })),
    }));
    return res.json(merged);
  }

  const bookings = await db.collection('classBookings').find({ chatId: user.id }).toArray();
  const classIds = bookings.map(b => new ObjectId(b.classId));
  const classes = classIds.length
    ? await db.collection('classes').find({ _id: { $in: classIds } }).toArray()
    : [];

  const merged = sortByWeekdayThenTime(classes.map(c => ({
    ...c,
    dayLabel: WEEKDAYS.find(d => d.key === c.day)?.label || c.day,
  })));
  res.json(merged);
});

app.get('/api/admin/applications', async (req, res) => {
  const auth = await getVerifiedTrainerOrAdmin(req.query.initData);
  if (!auth) return res.status(403).json({ error: 'forbidden' });

  const status = req.query.status || 'pending';
  
  // Владелец видит все заявки, обычный тренер — только на него или без тренера
  let query = { status };
  if (!auth.isOwner) {
    query.$or = [{ trainerId: auth.user.id }, { trainerId: null }];
  }

  const apps = await db.collection('applications').find(query).sort({ createdAt: 1 }).toArray();
  res.json(apps);
});

async function bindApplicationToClass(application, classId) {
  const cls = await db.collection('classes').findOne({ _id: new ObjectId(classId) });
  if (!cls) return null;
  if (!application.chatId) throw new Error('application_missing_chat_id');

  try {
    await db.collection('classBookings').insertOne({
      classId: String(cls._id),
      chatId: application.chatId,
      username: application.username,
      firstName: application.firstName || application.name || '',
      group: application.group,
      applicationId: application._id,
      bookedAt: new Date(),
    });
  } catch (err) {
    if (err.code !== 11000) throw err;
  }

  await db.collection('applications').updateOne(
    { _id: application._id },
    { $addToSet: { confirmedClassIds: String(cls._id) } }
  );

  return cls;
}

function getConfirmedClassIds(application) {
  const ids = new Set();
  if (Array.isArray(application.confirmedClassIds)) {
    application.confirmedClassIds.forEach(id => ids.add(String(id)));
  }
  if (application.confirmedClassId) ids.add(String(application.confirmedClassId));
  return [...ids];
}

app.post('/api/admin/applications/:id/send-confirmation', async (req, res) => {
  const auth = await getVerifiedTrainerOrAdmin(req.body.initData);
  if (!auth) return res.status(403).json({ error: 'forbidden' });

  const application = await db.collection('applications').findOne({ _id: new ObjectId(req.params.id) });
  if (!application) return res.status(404).json({ error: 'not_found' });

  const classIds = getConfirmedClassIds(application);
  if (!classIds.length) return res.status(400).json({ error: 'not_bound' });

  const classes = await db.collection('classes')
    .find({ _id: { $in: classIds.map(id => new ObjectId(id)) } })
    .toArray();
  if (!classes.length) return res.status(404).json({ error: 'class_not_found' });

  const trainerIds = [...new Set(classes.map(c => c.trainerId))];
  const trainers = await db.collection('trainers').find({ telegramId: { $in: trainerIds } }).toArray();
  const trainerByTgId = new Map(trainers.map(t => [t.telegramId, t]));

  const blocks = classes.map(cls => {
    const dayLbl = WEEKDAYS.find(d => d.key === cls.day)?.label || cls.day;
    const trainer = trainerByTgId.get(cls.trainerId);
    const trainerLabel = trainerLinkHtml(trainer ? trainer.name : cls.trainerName, trainer ? trainer.username : cls.trainerUsername);
    return `${dayLbl}, ${cls.time} — ${cls.direction}\nТренер: ${trainerLabel}`;
  });

  try {
    await sendMessage(
      application.chatId,
      `✅ <b>Вас записали на занятие!</b>\n\n${blocks.join('\n\n')}\n\n` +
        `Адрес: ${studioAddressHtml()}`
    );
  } catch (err) {
    return res.status(500).json({ error: 'send_failed' });
  }

  await db.collection('applications').updateOne(
    { _id: application._id },
    { $set: { status: 'confirmed', confirmedAt: new Date() } }
  );

  res.json({ ok: true });
});

app.post('/api/admin/applications/:id/no-slots', async (req, res) => {
  const auth = await getVerifiedTrainerOrAdmin(req.body.initData);
  if (!auth) return res.status(403).json({ error: 'forbidden' });

  const application = await db.collection('applications').findOne({ _id: new ObjectId(req.params.id) });
  if (!application) return res.status(404).json({ error: 'not_found' });

  try {
    await sendMessage(
      application.chatId,
      `К сожалению, по указанным вами дням и времени нет свободных часов 😔\n\n` +
        `Пожалуйста, попробуйте указать более широкий диапазон дат/времени, либо обратитесь по телефону: ${OWNER_PHONE}`
    );
  } catch (err) {
    return res.status(500).json({ error: 'send_failed' });
  }

  await db.collection('applications').updateOne(
    { _id: application._id },
    { $set: { status: 'no_slots', noSlotsSentAt: new Date() } }
  );

  res.json({ ok: true });
});

app.get('/api/admin/applications/:id', async (req, res) => {
  const auth = await getVerifiedTrainerOrAdmin(req.query.initData);
  if (!auth) return res.status(403).json({ error: 'forbidden' });

  const application = await db.collection('applications').findOne({ _id: new ObjectId(req.params.id) });
  if (!application) return res.status(404).json({ error: 'not_found' });
  res.json(application);
});

app.delete('/api/admin/applications/:id', async (req, res) => {
  const auth = await getVerifiedTrainerOrAdmin(req.query.initData);
  if (!auth) return res.status(403).json({ error: 'forbidden' });

  await db.collection('applications').deleteOne({ _id: new ObjectId(req.params.id) });
  res.json({ ok: true });
});

app.get('/api/admin/agenda', async (req, res) => {
  const auth = await getVerifiedTrainerOrAdmin(req.query.initData);
  if (!auth) return res.status(403).json({ error: 'forbidden' });

  const { day, room } = req.query;
  if (!day || room == null || room === '') return res.status(400).json({ error: 'invalid_input' });

  const normRoom = normalizeRoom(room);
  if (normRoom == null) return res.status(400).json({ error: 'invalid_input' });

  const dayClasses = await db.collection('classes').find({ day }).toArray();
  const classes = dayClasses
    .filter(c => normalizeRoom(c.room) === normRoom)
    .sort((a, b) => normalizeTime(a.time).localeCompare(normalizeTime(b.time)));
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

app.patch('/api/admin/classes/:id', async (req, res) => {
  const auth = await getVerifiedTrainerOrAdmin(req.body.initData);
  if (!auth) return res.status(403).json({ error: 'forbidden' });

  const updates = {};
  if (req.body.group !== undefined) updates.group = req.body.group;
  if (req.body.direction !== undefined) updates.direction = req.body.direction;
  if (req.body.trainerId !== undefined) {
    const trainer = await db.collection('trainers').findOne({ telegramId: Number(req.body.trainerId) });
    updates.trainerId = Number(req.body.trainerId);
    updates.trainerName = trainer ? trainer.name : 'Неизвестно';
    updates.trainerUsername = trainer ? trainer.username : null;
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'invalid_input' });

  await db.collection('classes').updateOne({ _id: new ObjectId(req.params.id) }, { $set: updates });
  res.json({ ok: true });
});

app.post('/api/admin/classes/:id/participants', async (req, res) => {
  const auth = await getVerifiedTrainerOrAdmin(req.body.initData);
  if (!auth) return res.status(403).json({ error: 'forbidden' });

  let application;
  try {
    application = await db.collection('applications').findOne({ _id: parseObjectId(req.body.applicationId) });
  } catch (err) {
    return res.status(400).json({ error: 'invalid_application_id' });
  }
  if (!application) return res.status(404).json({ error: 'not_found' });

  await bindApplicationToClass(application, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/classes/:id/participants/:chatId', async (req, res) => {
  const auth = await getVerifiedTrainerOrAdmin(req.query.initData);
  if (!auth) return res.status(403).json({ error: 'forbidden' });

  await db.collection('classBookings').deleteOne({ classId: req.params.id, chatId: Number(req.params.chatId) });
  res.json({ ok: true });
});

// ===================== УЧАСТНИКИ И РАССЫЛКА =====================

app.get('/api/admin/participants', async (req, res) => {
  const auth = await getVerifiedTrainerOrAdmin(req.query.initData);
  if (!auth) return res.status(403).json({ error: 'forbidden' });

  const classFilter = auth.isOwner ? {} : { trainerId: auth.user.id };
  const classes = await db.collection('classes').find(classFilter).toArray();
  if (!classes.length) return res.json([]);

  const classById = new Map(classes.map(c => [String(c._id), c]));
  const classIds = [...classById.keys()];
  const bookings = await db.collection('classBookings').find({ classId: { $in: classIds } }).toArray();

  const byChatId = new Map();
  for (const b of bookings) {
    const cls = classById.get(b.classId);
    if (!cls) continue;
    if (!byChatId.has(b.chatId)) {
      byChatId.set(b.chatId, {
        chatId: b.chatId,
        username: b.username || null,
        name: b.firstName || (b.username ? '@' + b.username : 'Без имени'),
        directions: new Set(),
        trainers: new Set(),
      });
    }
    const entry = byChatId.get(b.chatId);
    entry.directions.add(cls.direction);
    entry.trainers.add(formatTrainerName(cls.trainerName, cls.trainerUsername));
  }

  res.json([...byChatId.values()].map(p => ({
    chatId: p.chatId,
    username: p.username,
    name: p.name,
    directions: [...p.directions].join(', '),
    trainers: [...p.trainers].join(', '),
  })));
});

app.post('/api/admin/broadcast', async (req, res) => {
  const auth = await getVerifiedTrainerOrAdmin(req.body.initData);
  if (!auth) return res.status(403).json({ error: 'forbidden' });

  const text = (req.body.text || '').trim();
  const imageData = parseDataUrl(req.body.imageBase64);
  if (!text && !imageData) return res.status(400).json({ error: 'empty_message' });

  const classFilter = auth.isOwner ? {} : { trainerId: auth.user.id };
  const classes = await db.collection('classes').find(classFilter).toArray();
  const classIds = classes.map(c => String(c._id));
  if (!classIds.length) return res.json({ ok: true, sent: 0, failed: 0, total: 0 });

  const bookings = await db.collection('classBookings').find({ classId: { $in: classIds } }).toArray();
  const chatIds = [...new Set(bookings.map(b => b.chatId))];

  let sent = 0, failed = 0;
  for (const chatId of chatIds) {
    try {
      if (imageData) await sendPhoto(chatId, imageData, text);
      else await sendMessage(chatId, text);
      sent++;
    } catch (err) {
      failed++;
      console.error('Рассылка: не удалось отправить', chatId, err.message);
    }
    await new Promise(r => setTimeout(r, 40)); // мягкая защита от лимитов Telegram
  }

  res.json({ ok: true, sent, failed, total: chatIds.length });
});

// ===================== МЕРОПРИЯТИЯ (только владелец) =====================

app.post('/api/admin/events', async (req, res) => {
  const owner = await getVerifiedOwner(req.body.initData);
  if (!owner) return res.status(403).json({ error: 'forbidden' });

  const text = (req.body.text || '').trim();
  const date = (req.body.date || '').trim();
  if (!text || !date) return res.status(400).json({ error: 'invalid_input' });

  const imageData = parseDataUrl(req.body.imageBase64);

  const result = await db.collection('events').insertOne({
    text,
    date,
    imageMime: imageData ? imageData.mime : null,
    imageData: imageData ? imageData.buffer : null,
    createdBy: owner.user.id,
    createdAt: new Date(),
  });

  res.json({ ok: true, id: result.insertedId });
});

app.get('/api/admin/events', async (req, res) => {
  const owner = await getVerifiedOwner(req.query.initData);
  if (!owner) return res.status(403).json({ error: 'forbidden' });

  const list = await db.collection('events').find({}, { projection: { imageData: 0 } }).sort({ date: -1 }).toArray();
  const { dateStr: today } = nowInStudioTZ();
  res.json(list.map(e => ({ ...e, active: e.date >= today, hasImage: !!e.imageMime })));
});

app.delete('/api/admin/events/:id', async (req, res) => {
  const owner = await getVerifiedOwner(req.query.initData);
  if (!owner) return res.status(403).json({ error: 'forbidden' });

  await db.collection('events').deleteOne({ _id: new ObjectId(req.params.id) });
  res.json({ ok: true });
});

app.get('/api/events/active', async (req, res) => {
  const user = verifyInitData(req.query.initData || '');
  if (!user) return res.status(401).json({ error: 'unauthorized' });

  const { dateStr: today } = nowInStudioTZ();
  const list = await db.collection('events')
    .find({ date: { $gte: today } }, { projection: { imageData: 0 } })
    .sort({ date: 1 })
    .toArray();
  res.json(list.map(e => ({ ...e, hasImage: !!e.imageMime })));
});

app.get('/api/events/:id/image', async (req, res) => {
  const user = verifyInitData(req.query.initData || '');
  if (!user) return res.status(401).send('unauthorized');

  const event = await db.collection('events').findOne({ _id: new ObjectId(req.params.id) });
  if (!event || !event.imageData) return res.status(404).send('not_found');

  const buf = Buffer.isBuffer(event.imageData) ? event.imageData : Buffer.from(event.imageData.buffer || event.imageData);
  res.set('Content-Type', event.imageMime || 'image/jpeg');
  res.send(buf);
});

const STUDIO_TIMEZONE = 'Europe/Minsk';
const sentReminders = new Set();
const reminderReplySessions = new Map();

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
            `⏰ Сегодня у вас тренировка в ${cls.time} (${cls.direction}).\nАдрес: ${studioAddressHtml()}\nВы будете?`,
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

async function handleStart(chatId) {
  const removeMarkup = { remove_keyboard: true };

  await sendMessage(
    chatId, 
    '👋 Привет! Я бот для записи на занятия.\n\nВсё управление и запись теперь находятся внутри нашего мини-приложения.\n\nНажми кнопку «Запись» в самом низу экрана (слева от поля ввода), чтобы войти!', 
    { reply_markup: removeMarkup }
  );
}

const adminSessions = new Map();

const WEEKDAYS = [
  { key: 'mon', label: 'Понедельник' },
  { key: 'tue', label: 'Вторник' },
  { key: 'wed', label: 'Среда' },
  { key: 'thu', label: 'Четверг' },
  { key: 'fri', label: 'Пятница' },
  { key: 'sat', label: 'Суббота' },
  { key: 'sun', label: 'Воскресенье' },
];

async function handleSetUsernameCommand(chatId) {
  const trainer = await db.collection('trainers').findOne({ telegramId: chatId });
  if (!trainer) return await sendMessage(chatId, 'Эта команда доступна только тренерам/админам.');
  adminSessions.set(chatId, { flow: 'set_username', data: {} });
  await sendMessage(chatId, 'Пришли свой ник в Telegram (без @) — он будет кликабельной ссылкой в сообщениях участникам о записи.');
}

async function handleSetUsernameText(chatId, text) {
  const raw = text.trim().replace(/^@/, '');
  const trainer = await db.collection('trainers').findOne({ telegramId: chatId });
  
  if (trainer) {
    await db.collection('trainers').updateOne({ telegramId: chatId }, { $set: { username: raw } });
    await db.collection('classes').updateMany({ trainerId: chatId }, { $set: { trainerUsername: raw } });
  }

  adminSessions.delete(chatId);
  await sendMessage(chatId, `✅ Готово! Твой ник сохранён: @${raw}`);
}

app.post(WEBHOOK_PATH, async (req, res) => {
  const update = req.body;
  const msg = update.message;

  try {
    if (msg?.text) {
      const chatId = msg.chat.id;

      if (adminSessions.has(chatId) && !msg.text.startsWith('/')) {
        const session = adminSessions.get(chatId);
        if (session.flow === 'set_username') await handleSetUsernameText(chatId, msg.text);
        return res.sendStatus(200);
      }

      if (msg.text === '/start') await handleStart(chatId);
      else if (msg.text === '/setusername') await handleSetUsernameCommand(chatId);
    }
  } catch (e) {
    console.error('Ошибка webhook:', e);
  }
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});