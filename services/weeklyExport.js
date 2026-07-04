const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const PizZip = require('pizzip');
require('./timezone');

const ROOT_DIR = path.join(__dirname, '..');
const TEMPLATE_DIR = path.join(ROOT_DIR, 'templates');
const EXPORT_DIR = path.join(ROOT_DIR, 'data', 'exports');
const XLSX_TEMPLATE = path.join(TEMPLATE_DIR, 'weekly-template.xlsx');
const DOCX_TEMPLATE = path.join(TEMPLATE_DIR, 'weekly-template.docx');

function pad2(n) {
  return String(n).padStart(2, '0');
}

function parseDateOnly(yyyyMmDd) {
  const [year, month, day] = String(yyyyMmDd).split('-').map(Number);
  if (!year || !month || !day) {
    throw new Error('周期日期格式不正确');
  }
  const d = new Date(year, month - 1, day);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(yyyyMmDd, days) {
  const d = parseDateOnly(yyyyMmDd);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatWordDate(date) {
  return `${date.getFullYear()}.${date.getMonth() + 1}.${pad2(date.getDate())}`;
}

function formatFileDate(date) {
  return `${date.getMonth() + 1}.${date.getDate()}`;
}

function buildLabels(weekStart) {
  const start = parseDateOnly(weekStart);
  const end = parseDateOnly(addDays(weekStart, 6));
  const friday = parseDateOnly(addDays(weekStart, 4));
  const weekOfMonth = Math.ceil(friday.getDate() / 7);

  return {
    weekStart,
    weekEnd: `${end.getFullYear()}-${pad2(end.getMonth() + 1)}-${pad2(end.getDate())}`,
    weekRange: `${formatWordDate(start)}-${formatWordDate(end)}`,
    excelTitle: `产业数字化板块工作周报统计表\n（${friday.getFullYear()}年${friday.getMonth() + 1}月第${weekOfMonth}周)`,
    fileDate: formatFileDate(friday),
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function normalizeLines(lines) {
  const source = Array.isArray(lines) ? lines : String(lines || '').split(/\r?\n/);
  return source
    .flatMap(line => String(line || '').split(/\r?\n/))
    .map(line => line.replace(/^\s*(?:\d+[、.．)]|[-•●])\s*/, '').trim())
    .filter(Boolean);
}

function formatExcelList(lines) {
  const normalized = normalizeLines(lines);
  if (!normalized.length) return '无';
  return normalized.map((line, index) => `${index + 1}.${line}`).join('\n');
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function getParagraphText(xml) {
  const texts = [];
  for (const match of xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)) {
    texts.push(decodeXml(match[1]));
  }
  return texts.join('');
}

function replaceParagraphText(templateXml, text) {
  let replaced = false;
  const withoutIds = templateXml
    .replace(/\s+w14:paraId="[^"]*"/g, '')
    .replace(/\s+w14:textId="[^"]*"/g, '');

  return withoutIds.replace(/<w:t\b([^>]*)>[\s\S]*?<\/w:t>/g, (match, attrs) => {
    if (replaced) return `<w:t${attrs}></w:t>`;
    replaced = true;
    return `<w:t${attrs}>${escapeXml(text)}</w:t>`;
  });
}

function findParagraph(paragraphs, startIndex, predicate) {
  for (let i = startIndex; i < paragraphs.length; i += 1) {
    if (predicate(paragraphs[i].text, paragraphs[i], i)) return i;
  }
  return -1;
}

function applyXmlReplacements(xml, replacements) {
  const ordered = replacements.slice().sort((a, b) => a.start - b.start);
  let output = '';
  let cursor = 0;
  ordered.forEach(rep => {
    output += xml.slice(cursor, rep.start);
    output += rep.content;
    cursor = rep.end;
  });
  output += xml.slice(cursor);
  return output;
}

function replaceWordBlocks(documentXml, labels, thisWeekLines, nextWeekLines) {
  const paragraphs = [];
  for (const match of documentXml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)) {
    paragraphs.push({
      xml: match[0],
      start: match.index,
      end: match.index + match[0].length,
      text: getParagraphText(match[0]),
    });
  }

  const dateIndex = findParagraph(paragraphs, 0, text => text.startsWith('（时间：'));
  const deptIndex = findParagraph(paragraphs, 0, text => text.trim() === '三、工控事业部');
  const thisHeadingIndex = findParagraph(paragraphs, deptIndex + 1, text => text.includes('本周工作完成情况'));
  const unfinishedIndex = findParagraph(paragraphs, thisHeadingIndex + 1, text => text.includes('未完成情况'));
  const nextHeadingIndex = findParagraph(paragraphs, unfinishedIndex + 1, text => text.includes('下周计划开展'));
  const nextDeptIndex = findParagraph(paragraphs, nextHeadingIndex + 1, text => text.trim().startsWith('四、能源事业部'));

  if ([dateIndex, deptIndex, thisHeadingIndex, unfinishedIndex, nextHeadingIndex, nextDeptIndex].some(i => i < 0)) {
    throw new Error('Word 模板结构不符合预期，无法定位工控事业部内容块');
  }

  const thisTemplate = paragraphs[thisHeadingIndex + 1]?.xml;
  const nextTemplate = paragraphs[nextHeadingIndex + 1]?.xml;
  if (!thisTemplate || !nextTemplate) {
    throw new Error('Word 模板缺少可复制的正文段落');
  }

  const thisParagraphs = normalizeLines(thisWeekLines).map(line => replaceParagraphText(thisTemplate, line)).join('');
  const nextParagraphs = normalizeLines(nextWeekLines).map(line => replaceParagraphText(nextTemplate, line)).join('');

  return applyXmlReplacements(documentXml, [
    {
      start: paragraphs[dateIndex].start,
      end: paragraphs[dateIndex].end,
      content: replaceParagraphText(paragraphs[dateIndex].xml, `（时间：${labels.weekRange}）`),
    },
    {
      start: paragraphs[thisHeadingIndex + 1].start,
      end: paragraphs[unfinishedIndex].start,
      content: thisParagraphs || replaceParagraphText(thisTemplate, '无'),
    },
    {
      start: paragraphs[nextHeadingIndex + 1].start,
      end: paragraphs[nextDeptIndex].start,
      content: nextParagraphs || replaceParagraphText(nextTemplate, '无'),
    },
  ]);
}

async function generateExcel(outPath, labels, thisWeekLines, nextWeekLines) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(XLSX_TEMPLATE);

  const sheet = workbook.getWorksheet('Sheet1') || workbook.worksheets[0];
  workbook.worksheets
    .filter(ws => ws.id !== sheet.id)
    .map(ws => ws.id)
    .forEach(id => workbook.removeWorksheet(id));

  sheet.getCell('A1').value = labels.excelTitle;
  sheet.getCell('C4').value = formatExcelList(thisWeekLines);
  sheet.getCell('D4').value = formatExcelList(nextWeekLines);

  ['A1', 'C4', 'D4'].forEach(address => {
    const cell = sheet.getCell(address);
    cell.alignment = { ...(cell.alignment || {}), wrapText: true, vertical: 'middle' };
  });
  sheet.getCell('C4').alignment = { ...(sheet.getCell('C4').alignment || {}), wrapText: true, vertical: 'top' };
  sheet.getCell('D4').alignment = { ...(sheet.getCell('D4').alignment || {}), wrapText: true, vertical: 'top' };

  await workbook.xlsx.writeFile(outPath);
}

function generateWord(outPath, labels, thisWeekLines, nextWeekLines) {
  const zip = new PizZip(fs.readFileSync(DOCX_TEMPLATE));
  const docFile = zip.file('word/document.xml');
  if (!docFile) throw new Error('Word 模板缺少 document.xml');

  const updatedXml = replaceWordBlocks(docFile.asText(), labels, thisWeekLines, nextWeekLines);
  zip.file('word/document.xml', updatedXml);
  fs.writeFileSync(outPath, zip.generate({ type: 'nodebuffer' }));
}

async function generateWeeklyReports({ weekStart, thisWeekLines, nextWeekLines }) {
  ensureDir(EXPORT_DIR);
  const labels = buildLabels(weekStart);
  const baseName = `产业数字化板块工作周报统计表${labels.fileDate}`;
  const xlsxName = `${baseName}.xlsx`;
  const docxName = `${baseName}.docx`;
  const xlsxPath = path.join(EXPORT_DIR, xlsxName);
  const docxPath = path.join(EXPORT_DIR, docxName);

  await generateExcel(xlsxPath, labels, thisWeekLines, nextWeekLines);
  generateWord(docxPath, labels, thisWeekLines, nextWeekLines);

  return {
    labels,
    files: [
      { type: 'xlsx', filename: xlsxName, path: xlsxPath },
      { type: 'docx', filename: docxName, path: docxPath },
    ],
  };
}

module.exports = {
  EXPORT_DIR,
  buildLabels,
  generateWeeklyReports,
  normalizeLines,
};
