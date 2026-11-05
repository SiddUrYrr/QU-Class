/**
 * PART 2 pre-check: parseTimetableCell ko 4 REAL examples pe test karo
 * INTEGRATION se pehle (user requirement).
 *   node test/parse-cell-check.js
 */
const path = require('path');
const scraper = require(path.join(__dirname, '..', 'src', 'scraper'));

const EXAMPLES = [
  // [raw, expected {subject, subjectCode, room, teacher}]
  ['Design and Analysis of Algorithm (CS35303) (A-004),RAJ KUMAR',
    { subject: 'Design and Analysis of Algorithm', subjectCode: 'CS35303', room: 'A-004', teacher: 'RAJ KUMAR' }],
  ['Design and Analysis of Algorithm Lab(CS35363) (E-202)(B),RAJ KUMAR',
    { subject: 'Design and Analysis of Algorithm Lab', subjectCode: 'CS35363', room: 'E-202B', teacher: 'RAJ KUMAR' }],
  ['R Programming(CS3026/CS30364) (A-102),TEACHER NAME',
    { subject: 'R Programming', subjectCode: 'CS3026/CS30364', room: 'A-102', teacher: 'TEACHER NAME' }],
  ['Robotic Industry 4.0(MT3015) (A-010),ANKUR JAIN',
    { subject: 'Robotic Industry 4.0', subjectCode: 'MT3015', room: 'A-010', teacher: 'ANKUR JAIN' }],
  // bonus edges: commas inside subject name + no-space parens
  ['Advance Machine Learning Practical with Python, Scikit-learn, TensorFlow(CS35364) (L-101),DR. RAO',
    { subject: 'Advance Machine Learning Practical with Python, Scikit-learn, TensorFlow', subjectCode: 'CS35364', room: 'L-101', teacher: 'DR. RAO' }],
  ['Mini Project - III(CS35378) (A-213),ABHISHEK KUMAR',
    { subject: 'Mini Project - III', subjectCode: 'CS35378', room: 'A-213', teacher: 'ABHISHEK KUMAR' }],
];

let fails = 0;
for (const [raw, expected] of EXAMPLES) {
  const got = scraper.parseTimetableCell(raw);
  const pass = JSON.stringify(got) === JSON.stringify(expected);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${raw.slice(0, 60)}${raw.length > 60 ? '…' : ''}`);
  console.log(`      -> ${JSON.stringify(got)}`);
  if (!pass) {
    console.log(`      expected: ${JSON.stringify(expected)}`);
    fails += 1;
  }
}
console.log(fails === 0 ? '\nALL CELL CHECKS PASSED — integration safe' : `\n${fails} CHECK(S) FAILED`);
process.exit(fails ? 1 : 0);
