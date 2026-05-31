'use strict';
// Прицельно: проверим, чисто ли работает sanitizer.
const path = require('path');
// Перезагружаем module чтобы взять новую sanitizeReply.
delete require.cache[require.resolve('./notion_chat')];
const { runChat } = require('./notion_chat');

const tests = [
  'Я — Notion AI, ассистент.',
  'Я Notion AI, помогу.',
  'Notion AI расскажет.',
  'I am Notion AI here to help.',
  'Hello! Notion AI, your assistant in Notion workspace.',
  'Привет! Я ассистент Notion.',
  'Просто текст без notion.',
  'Твоё имя — Алекс.',                     // должно остаться целым!
  'Твоё имя — Алекс. Я Notion AI.',        // только последняя должна резаться
];
for (const t of tests) {
  // sanitizeReply не экспортирована, дёрну через регексы напрямую.
  let s = t;
  s = s.replace(/(^|[\s«"`'(])(?:I'?m|I am|Я(?:\s*[—\-])?\s*)\s*Notion\s*AI\b/gi, '$1AI-ассистент');
  s = s.replace(/встроенн(?:ый|ая|ое|ого|ому|ым|ом)\s+(помощник|ассистент)\s+(?:в|внутри|для)\s+Notion[а-я]*/gi, 'AI-$1');
  s = s.replace(/(ассистент|помощник)\s+Notion[а-я]*/gi, 'AI-$1');
  s = s.replace(/\b(?:in|inside|for)\s+Notion\b/gi, '');
  s = s.replace(/\s*\(?\bваш[а-я]*\s+рабоч[а-я]*\s+пространств[а-я]*(?:\s+Notion[а-я]*)?\s*\)?/gi, '');
  s = s.replace(/\s*\(?\b(рабоч[а-я]+\s+пространств[а-я]+|workspace)\s+(в\s+)?Notion[а-я]*\)?/gi, '');
  s = s.replace(/\bNotion\s*AI\b/g, 'AI');
  s = s.replace(/\bв\s+Notion[а-я]*\b/gi, '');
  s = s.replace(/\bNotion[а-я]*\b/gi, '');
  s = s.replace(/[ \t]{2,}/g, ' ').replace(/ +([.,;!?])/g, '$1').replace(/\s+,/g, ',');
  console.log('IN: ', JSON.stringify(t));
  console.log('OUT:', JSON.stringify(s));
  console.log('---');
}
