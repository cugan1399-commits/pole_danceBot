// Разовый скрипт: показывает все индексы коллекции classes
// и удаляет "старые" уникальные индексы, которые не включают room.
//
// Запуск: node check_indexes.js
// (нужен тот же MONGODB_URI, что и у бота — можно временно
//  положить рядом .env с этой переменной, или подставить строку напрямую)

import 'dotenv/config';
import { MongoClient } from 'mongodb';

const MONGODB_URI = process.env.MONGODB_URI;

async function main() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db('pole_dance'); // то же имя базы, что использует бот в index.js

  const indexes = await db.collection('classes').indexes();
  console.log('Текущие индексы коллекции classes:');
  console.log(JSON.stringify(indexes, null, 2));

  // Ищем "плохие" индексы: unique, но без поля room
  const badIndexes = indexes.filter(ix =>
    ix.unique &&
    Object.prototype.hasOwnProperty.call(ix.key, 'day') &&
    Object.prototype.hasOwnProperty.call(ix.key, 'time') &&
    !Object.prototype.hasOwnProperty.call(ix.key, 'room')
  );

  if (badIndexes.length === 0) {
    console.log('\nСтарых индексов без room не найдено. Проблема в чём-то другом.');
  } else {
    console.log('\nНайдены проблемные индексы (unique, без room):');
    for (const ix of badIndexes) {
      console.log(' -', ix.name, JSON.stringify(ix.key));
      await db.collection('classes').dropIndex(ix.name);
      console.log('   удалён.');
    }
    console.log('\nГотово. Проверь ещё раз через getIndexes(), должен остаться только day_1_time_1_room_1.');
  }

  await client.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
