/** Debug: getTimetableForDate 'Thrusday' match kyun fail ho raha hai. */
const s = require('../src/scraper');
const tt = s.parseTimetableApiState([
  { 'Days/Period': 'Thrusday', '(P2)09:55 - 10:50': 'Scala (CS35365) (A-203),BHANU' },
]);
const d = s.dateFromAny('17/09/2026');
const wd = d.getDay();
const name = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][wd].toLowerCase();
console.log('wd:', wd, '| name:', name, '| slice3:', JSON.stringify(name.slice(0, 3)));
console.log('row day:', JSON.stringify(tt.days[0].day), '| startsWith thu:', tt.days[0].day.toLowerCase().startsWith(name.slice(0, 3)));
const filtered = tt.days[0].periods.filter((p) => p.text && p.text.length > 2 && !/break|lunch|^free/i.test(p.text));
console.log('filtered periods:', filtered.length);
console.log('result:', JSON.stringify(s.getTimetableForDate(tt, '17/09/2026')));
