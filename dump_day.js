// Диагностика: показывает ВСЕ записи (classes) на конкретный день,
// с реальными типами полей day/time/room — чтобы поймать
// несовпадения (например room хранится то как число, то как строка).
//
// Запуск: node dump_day.js mon
// (день передаётся тем же ключом, что в приложении: mon/tue/wed/thu/fri/sat/sun)

import 'dotenv/config';
import { MongoClient } from 'mongodb';

const MONGODB_URI = process.env.MONGODB_URI;
const dayArg = process.argv[2];

if (!dayArg) {
  console.log('Использование: node dump_day.js <day>  (например: node dump_day.js mon)');
  process.exit(1);
}

async function main() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db('pole_dance');

  // 1. Всё, что реально совпадает по полю day (точное совпадение)
  const exact = await db.collection('classes').find({ day: dayArg }).toArray();

  // 2. Вообще всё в коллекции — чтобы поймать записи, где day записан
  //    иначе (другой регистр, пробел, другой формат)
  const all = await db.collection('classes').find({}).toArray();

  console.log(`\n=== Точное совпадение day === "${dayArg}" (${exact.length} шт.) ===`);
  for (const c of exact) {
    console.log({
      _id: String(c._id),
      day: c.day, dayType: typeof c.day,
      time: c.time, timeType: typeof c.time,
      room: c.room, roomType: typeof c.room,
      direction: c.direction,
    });
  }

  console.log(`\n=== ВСЕ записи в classes (${all.length} шт.), для сверки day-ключей ===`);
  const uniqueDayValues = [...new Set(all.map(c => JSON.stringify(c.day)))];
  console.log('Все встречающиеся значения поля day:', uniqueDayValues);

  await client.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
