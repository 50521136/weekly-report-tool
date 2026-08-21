const express = require('express');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const { requireAdmin, requireSuperAdmin } = require('../middleware/auth');
const { Users, Submissions, Settings, WeeklyReports, getMondayOf, addDays, db } = require('../db');
const {
  EXPORT_DIR,
  buildLabels,
  generateWeeklyReports,
  normalizeLines,
} = require('../services/weeklyExport');
const { sendTestEmail } = require('../services/reminder');
const SUPER_ADMIN_USERNAME = process.env.DEFAULT_ADMIN_USERNAME || 'admin';

// ============== 管理后台 ==============

function buildWeekOverview(weekStart) {
  const weekRows = Submissions.getByWeek(weekStart);
  const submissionIds = weekRows.flatMap(r => [r.this_id, r.next_id]).filter(Boolean);
  const allItems = Submissions.itemsBySubmissionIds(submissionIds);
  const itemsBySubId = {};
  allItems.forEach(it => {
    itemsBySubId[it.submission_id] = itemsBySubId[it.submission_id] || [];
    itemsBySubId[it.submission_id].push(it);
  });

  const rows = weekRows.map(r => {
    const thisItems = r.this_id ? (itemsBySubId[r.this_id] || []) : [];
    const nextItems = r.next_id ? (itemsBySubId[r.next_id] || []) : [];
    return {
      ...r,
      thisSubmitted: thisItems.length > 0,
      nextSubmitted: nextItems.length > 0,
      thisItems,
      nextItems,
    };
  });

  return { rows, itemsBySubId };
}

function itemText(item) {
  const project = (item.project_name || '').trim();
  const content = (item.content || '').trim();
  return project ? `${project}：${content}` : content;
}

const PROJECT_SIMILARITY_THRESHOLD = 0.8;
const ORDINAL_PREFIX = /^(?:一是|二是|三是|四是|五是|六是|七是|八是|九是|十是|十一是|十二是|十三是|十四是|十五是|十六是|十七是|十八是|十九是|二十是)\s*/;
const ORDINAL_GLOBAL = /(?:一是|二是|三是|四是|五是|六是|七是|八是|九是|十是|十一是|十二是|十三是|十四是|十五是|十六是|十七是|十八是|十九是|二十是)\s*/g;

function cleanProjectTitle(project) {
  return String(project || '')
    .replace(/^[\[\【]\s*/, '')
    .replace(/\s*[\]\】]$/, '')
    .replace(/^(?:持续)?(?:推进|开展|完成|实施|配合|协助)\s*/, '')
    .replace(/[，,:：；;。.\s]+$/g, '')
    .trim();
}

function normalizeProjectName(project) {
  return cleanProjectTitle(project)
    .replace(/[\s\[\]【】（）()《》<>“”"‘’'`]/g, '')
    .replace(/[，,:：；;、。．.\-_/\\|]/g, '')
    .toLowerCase();
}

function levenshteinSimilarity(a, b) {
  const left = Array.from(a || '');
  const right = Array.from(b || '');
  if (!left.length && !right.length) return 1;
  if (!left.length || !right.length) return 0;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost
      );
    }
    previous = current;
  }
  const distance = previous[right.length];
  return 1 - (distance / Math.max(left.length, right.length));
}

function diceSimilarity(a, b) {
  const left = Array.from(a || '');
  const right = Array.from(b || '');
  if (!left.length && !right.length) return 1;
  if (left.length < 2 || right.length < 2) return left.join('') === right.join('') ? 1 : 0;

  const grams = chars => {
    const map = new Map();
    for (let i = 0; i < chars.length - 1; i += 1) {
      const gram = chars[i] + chars[i + 1];
      map.set(gram, (map.get(gram) || 0) + 1);
    }
    return map;
  };

  const leftGrams = grams(left);
  const rightGrams = grams(right);
  let overlap = 0;
  leftGrams.forEach((count, gram) => {
    overlap += Math.min(count, rightGrams.get(gram) || 0);
  });
  return (2 * overlap) / ((left.length - 1) + (right.length - 1));
}

function projectSimilarity(a, b) {
  const left = normalizeProjectName(a);
  const right = normalizeProjectName(b);
  if (!left || !right) return 0;
  if (left === right) return 1;

  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  const containment = longer.includes(shorter) ? shorter.length / longer.length : 0;

  return Math.max(
    levenshteinSimilarity(left, right),
    diceSimilarity(left, right),
    containment
  );
}

function findSimilarGroup(groups, project) {
  let best = null;
  groups.forEach(group => {
    const score = projectSimilarity(group.project, project);
    if (score >= PROJECT_SIMILARITY_THRESHOLD && (!best || score > best.score)) {
      best = { group, score };
    }
  });
  return best ? best.group : null;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripProjectPrefix(content, project) {
  let text = String(content || '').trim();
  const exactProject = cleanProjectTitle(project);
  if (exactProject) {
    text = text.replace(
      new RegExp(`^(?:持续)?(?:推进|开展|完成|实施|配合|协助)?\\s*${escapeRegExp(exactProject)}[，,:：；;\\s]*`),
      ''
    );
  }
  return text;
}

// 把“1. 2. 3.”“一是/二是/三是”等枚举标记统一整理为“；”分隔的短语
function mergeEnumerationMarks(text) {
  return String(text || '')
    .replace(/(?:^|[\s；;、，,])(?:[-•●])\s*/g, '；')
    .replace(/(?:^|[\s；;、，,])\d+[、)）]\s*/g, '；')
    .replace(/(?:^|[\s；;、，,])\d+．\s*/g, '；')
    .replace(/(?:^|[\s；;、，,])\d+\.(?=\s|$)/g, '；')
    .replace(ORDINAL_GLOBAL, '')
    .replace(/^[；;、，,\s]+/, '')
    .replace(/[；;]\s*[，,]/g, '；')
    .replace(/[，,]\s*[；;]/g, '；')
    .replace(/[；;][；;]+/g, '；')
    .replace(/([；;])[ \t　]+/g, '$1')
    .replace(/[，,][，,]+/g, '，')
    .replace(/[；;，,]+$/g, '')
    .trim();
}

function cleanWorkContent(content, project) {
  let text = mergeEnumerationMarks(stripProjectPrefix(content, project));
  const title = cleanProjectTitle(project);
  if (title) {
    // 删除内容小项里重复出现的项目名（例如“2. 九江…项目画施工草图”），只处理片段开头
    text = text.replace(
      new RegExp(`(^|[；;、，,])\\s*(?:持续)?(?:推进|开展|完成|实施|配合|协助)?\\s*${escapeRegExp(title)}`, 'g'),
      '$1'
    );
  }
  return text
    .replace(/^[，,:：；;\s]+/, '')
    .replace(/[；;。.\s]+$/g, '')
    .trim();
}

function uniqueContents(contents, project) {
  const seen = new Set();
  const unique = [];
  contents.forEach(content => {
    const cleaned = cleanWorkContent(content, project);
    const key = cleaned.replace(/[，,；;、。．.\s]/g, '');
    if (cleaned && !seen.has(key)) {
      seen.add(key);
      unique.push(cleaned);
    }
  });
  return unique;
}

function formatProjectLine(project, contents) {
  const title = cleanProjectTitle(project);
  const unique = uniqueContents(contents, title);
  const body = unique.join('；')
    .replace(/[；;]{2,}/g, '；')
    .replace(/[。．.]{2,}/g, '。')
    .replace(/[；;。.\s]+$/g, '');
  if (!title) return body;
  return body ? `${title}，${body}` : title;
}

function addProjectGroup(groups, loose, project, content) {
  const title = cleanProjectTitle(project);
  if (!title) {
    const cleaned = cleanWorkContent(content, '');
    if (cleaned) loose.push(cleaned);
    return;
  }

  let group = findSimilarGroup(groups, title);
  if (!group) {
    group = { project: title, contents: [] };
    groups.push(group);
  } else if (normalizeProjectName(title).length > normalizeProjectName(group.project).length) {
    group.project = title;
  }

  const cleaned = cleanWorkContent(content, group.project);
  if (cleaned) group.contents.push(cleaned);
}

function looksLikeProjectName(value) {
  const text = cleanProjectTitle(value);
  return text.length >= 4
    && text.length <= 100
    && /(项目|工程|系统|平台|场站|中心|基地|阀室|站|采购|改造|建设|检测)/.test(text);
}

function parseProjectLine(line) {
  const text = stripOrdinalText(line)
    .replace(/^\[([^\]]+)\]\s*/, '$1，')
    .trim();

  const colon = text.match(/^(.+?)[：:]\s*(.+)$/);
  if (colon) {
    return { project: cleanProjectTitle(colon[1]), content: colon[2].trim() };
  }

  const comma = text.match(/^(.+?)[，,]\s*(.+)$/);
  if (comma && looksLikeProjectName(comma[1])) {
    return { project: cleanProjectTitle(comma[1]), content: comma[2].trim() };
  }

  return { project: '', content: text };
}

function findProjectMention(line, sourceProjects) {
  const normalizedLine = normalizeProjectName(line);
  return sourceProjects.find(source => source.normalized && normalizedLine.includes(source.normalized));
}

function aggregateProjectLines(items) {
  const grouped = [];
  const loose = [];

  items.forEach(item => {
    const text = item.text || '';
    const { project, content } = parseProjectLine(text);
    addProjectGroup(grouped, loose, project, content);
  });

  return grouped
    .map(group => formatProjectLine(group.project, group.contents))
    .filter(Boolean)
    .concat(uniqueContents(loose, ''));
}

function stripOrdinalText(line) {
  return String(line || '')
    .replace(/^(?:本周|下周)?项目开展方面[，,:：]?\s*/, '')
    .replace(ORDINAL_PREFIX, '')
    .replace(/[；;。.\s]+$/g, '')
    .trim();
}

function compactSummaryLines(aiLines, sourceItems) {
  const sourceLines = fallbackSourceLines(sourceItems);
  const cleaned = normalizeLines(aiLines).map(stripOrdinalText).filter(Boolean);
  if (!cleaned.length) return sourceLines;

  const sourceProjects = sourceLines
    .map(line => {
      const parsed = parseProjectLine(line);
      return parsed.project
        ? { ...parsed, line, normalized: normalizeProjectName(parsed.project) }
        : null;
    })
    .filter(Boolean);

  if (sourceProjects.length && cleaned.length > sourceProjects.length) {
    return sourceLines;
  }

  const grouped = [];
  const loose = [];
  cleaned.forEach(line => {
    const parsed = parseProjectLine(line);
    if (parsed.project) {
      const sourceProject = sourceProjects.find(p => projectSimilarity(p.project, parsed.project) >= PROJECT_SIMILARITY_THRESHOLD);
      const project = sourceProject ? sourceProject.project : parsed.project;
      addProjectGroup(grouped, loose, project, parsed.content);
      return;
    }

    const matchedProject = findProjectMention(line, sourceProjects);
    if (matchedProject) {
      addProjectGroup(grouped, loose, matchedProject.project, stripProjectPrefix(line, matchedProject.project));
    } else {
      loose.push(line);
    }
  });

  const merged = grouped
    .map(group => formatProjectLine(group.project, group.contents))
    .filter(Boolean);

  return sanitizeSummaryLines(merged.concat(loose));
}

function sanitizeSummaryLines(lines) {
  const grouped = [];
  const loose = [];
  normalizeLines(lines).forEach(line => {
    const parsed = parseProjectLine(line);
    addProjectGroup(grouped, loose, parsed.project, parsed.content);
  });

  return grouped
    .map(group => formatProjectLine(group.project, group.contents))
    .filter(Boolean)
    .concat(uniqueContents(loose, ''))
    .map(line => line.replace(/^\[([^\]]+)\]\s*/, '$1，')
      .replace(/[；;]{2,}/g, '；')
      .replace(/[。．.]{2,}/g, '。')
      .replace(/[；;。.\s]+$/g, '')
      .trim())
    .filter(Boolean);
}

function collectCycleSource(rows) {
  const thisWeek = [];
  const nextWeek = [];

  rows.forEach(row => {
    row.thisItems.forEach(item => {
      thisWeek.push({ user: row.user_name, text: itemText(item) });
    });
    row.nextItems.forEach(item => {
      nextWeek.push({ user: row.user_name, text: itemText(item) });
    });
  });

  return { thisWeek, nextWeek };
}

function sourceToPromptText(items) {
  if (!items.length) return '无';
  const merged = aggregateProjectLines(items);
  return merged.map((line, index) => `${index + 1}. ${line}`).join('\n');
}

function fallbackSourceLines(items) {
  return aggregateProjectLines(items);
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value || '');
  } catch (err) {
    return fallback;
  }
}

function reportToResponse(report) {
  if (!report) return null;
  const files = safeJsonParse(report.files_json, []);
  return {
    exists: true,
    weekRange: report.week_range,
    generatedAt: report.updated_at || report.created_at,
    providerName: report.provider_name,
    model: report.model,
    summary: {
      thisWeek: sanitizeSummaryLines(safeJsonParse(report.this_week_summary, [])),
      nextWeek: sanitizeSummaryLines(safeJsonParse(report.next_week_summary, [])),
    },
    files: files.map(file => ({
      ...file,
      url: `/admin/exports/${encodeURIComponent(file.filename)}`,
    })),
    aiRaw: report.ai_raw,
  };
}

function sameStringArray(a, b) {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

async function repairCachedReportIfNeeded(report, generatedBy) {
  if (!report) return null;

  const rawThisWeek = safeJsonParse(report.this_week_summary, []);
  const rawNextWeek = safeJsonParse(report.next_week_summary, []);
  const thisWeekLines = sanitizeSummaryLines(rawThisWeek);
  const nextWeekLines = sanitizeSummaryLines(rawNextWeek);
  const files = safeJsonParse(report.files_json, []);
  const hasLegacyBrackets = [...rawThisWeek, ...rawNextWeek].some(line => /^\s*\[[^\]]+\]/.test(String(line || '')));
  const filesMissing = !files.length || files.some(file => !file.filename || !fs.existsSync(path.join(EXPORT_DIR, file.filename)));

  if (!hasLegacyBrackets && !filesMissing && sameStringArray(rawThisWeek, thisWeekLines) && sameStringArray(rawNextWeek, nextWeekLines)) {
    return report;
  }

  const regenerated = await generateWeeklyReports({
    weekStart: report.week_start,
    thisWeekLines,
    nextWeekLines,
  });

  return WeeklyReports.upsert({
    weekStart: report.week_start,
    weekRange: regenerated.labels.weekRange || report.week_range,
    thisWeekSummary: thisWeekLines,
    nextWeekSummary: nextWeekLines,
    aiRaw: report.ai_raw,
    providerName: report.provider_name,
    model: report.model,
    files: regenerated.files.map(file => ({ type: file.type, filename: file.filename })),
    generatedBy: generatedBy || report.generated_by,
  });
}

function parseProviderLines(settings) {
  const raw = String(settings.ai_providers || '').trim();
  if (raw.startsWith('[')) {
    const parsed = safeJsonParse(raw, []);
    const providers = parsed
      .map((provider, index) => ({
        name: provider.name || `API ${index + 1}`,
        baseUrl: provider.baseUrl || provider.base_url || '',
        apiKey: provider.apiKey || provider.api_key || '',
        models: Array.isArray(provider.models)
          ? provider.models.map(model => String(model).trim()).filter(Boolean)
          : String(provider.models || '').split(/[,，\n]/).map(model => model.trim()).filter(Boolean),
        priority: Number(provider.priority || index + 1),
      }))
      .filter(provider => provider.baseUrl && provider.apiKey && provider.models.length)
      .sort((a, b) => a.priority - b.priority);
    if (providers.length) return providers;
  }

  const lines = raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));

  const providers = lines.map((line, index) => {
    const parts = line.split('|').map(part => part.trim());
    if (parts.length < 4) return null;
    return {
      name: parts[0] || `API ${index + 1}`,
      baseUrl: parts[1],
      apiKey: parts[2],
      models: parts.slice(3).join('|').split(/[,，]/).map(model => model.trim()).filter(Boolean),
    };
  }).filter(provider => provider && provider.baseUrl && provider.apiKey && provider.models.length);

  if (providers.length) return providers;
  if (settings.ai_base_url && settings.ai_api_key && settings.ai_model) {
    return [{
      name: '默认 API',
      baseUrl: settings.ai_base_url,
      apiKey: settings.ai_api_key,
      models: String(settings.ai_model).split(/[,，]/).map(model => model.trim()).filter(Boolean),
    }];
  }
  return [];
}

function providersForSettings(settings) {
  return parseProviderLines(settings).map(provider => ({
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    modelsText: provider.models.join(','),
    priority: provider.priority || 1,
  }));
}

function ensureArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function buildProvidersFromBody(body) {
  const names = ensureArray(body.ai_provider_name);
  const baseUrls = ensureArray(body.ai_provider_base_url);
  const apiKeys = ensureArray(body.ai_provider_api_key);
  const models = ensureArray(body.ai_provider_models);
  const priorities = ensureArray(body.ai_provider_priority);

  return names.map((name, index) => ({
    name: String(name || '').trim() || `API ${index + 1}`,
    baseUrl: String(baseUrls[index] || '').trim(),
    apiKey: String(apiKeys[index] || '').trim(),
    models: String(models[index] || '').split(/[,，\n]/).map(model => model.trim()).filter(Boolean),
    priority: Number(priorities[index] || index + 1),
  })).filter(provider => provider.baseUrl && provider.apiKey && provider.models.length)
    .sort((a, b) => a.priority - b.priority);
}

function parseJsonFromAiText(content) {
  const text = String(content || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  if (!candidate || !candidate.trim().startsWith('{')) return null;
  try {
    return JSON.parse(candidate);
  } catch (err) {
    return null;
  }
}

function valueToLines(value) {
  if (Array.isArray(value)) return normalizeLines(value);
  if (value && typeof value === 'object') return normalizeLines(Object.values(value));
  return normalizeLines(value || '');
}

function parseAiExportContent(content) {
  const parsed = parseJsonFromAiText(content);
  if (parsed) {
    const thisWeek = valueToLines(parsed.this_week || parsed.thisWeek || parsed['本周工作'] || parsed['本周内容']);
    const nextWeek = valueToLines(parsed.next_week || parsed.nextWeek || parsed['下周计划'] || parsed['下周工作计划']);
    if (thisWeek.length || nextWeek.length) return { thisWeek, nextWeek };
  }

  const text = String(content || '');
  const thisMatch = text.match(/本周(?:工作|内容|完成情况)?[：:\n]\s*([\s\S]*?)(?=\n\s*(?:下周|下周计划|下周工作)|$)/);
  const nextMatch = text.match(/下周(?:计划|工作计划|工作)?[：:\n]\s*([\s\S]*)/);
  return {
    thisWeek: valueToLines(thisMatch ? thisMatch[1] : ''),
    nextWeek: valueToLines(nextMatch ? nextMatch[1] : ''),
  };
}

async function requestAiCompletion({ provider, model, finalPrompt }) {
  const baseUrl = provider.baseUrl.replace(/\/+$/, '');
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: '你是部门项目周报整理助手。输出必须适合直接写入正式周报，不按人员分组。' },
        { role: 'user', content: finalPrompt },
      ],
      temperature: 0.25,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`${provider.name}/${model}: ${response.status} - ${errText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callAiForExport(settings, labels, source) {
  const providers = parseProviderLines(settings);
  if (!providers.length) {
    throw new Error('请先在「系统设置」中配置至少一个可用的 AI API 厂家和模型');
  }

  const promptTemplate = settings.ai_export_prompt || '请汇总以下周报，输出 JSON：{{this_week}}{{next_week}}';
  const finalPrompt = promptTemplate
    .replace(/\{\{week_range\}\}/g, labels.weekRange)
    .replace(/\{\{this_week\}\}/g, sourceToPromptText(source.thisWeek))
    .replace(/\{\{next_week\}\}/g, sourceToPromptText(source.nextWeek));

  const errors = [];
  for (const provider of providers) {
    for (const model of provider.models) {
      try {
        const content = await requestAiCompletion({ provider, model, finalPrompt });
        const parsed = parseAiExportContent(content);
        if (parsed.thisWeek.length || parsed.nextWeek.length) {
          return {
            raw: content,
            parsed,
            providerName: provider.name,
            model,
          };
        }
        errors.push(`${provider.name}/${model}: 返回内容无法解析为周报 JSON`);
      } catch (err) {
        errors.push(err.message);
      }
    }
  }

  throw new Error(`所有 AI API/模型均生成失败：${errors.join('；')}`);
}

router.get('/admin', requireAdmin, (req, res) => {
  const thisMonday = getMondayOf();
  const { rows } = buildWeekOverview(thisMonday);

  const allUserCount = Users.all().filter(u => u.username !== SUPER_ADMIN_USERNAME).length;
  const thisWeekSubmittedCount = rows.filter(r => r.thisSubmitted).length;
  const nextWeekSubmittedCount = rows.filter(r => r.nextSubmitted).length;

  res.render('admin', {
    thisMonday,
    weekEnd: addDays(thisMonday, 6),
    nextMonday: addDays(thisMonday, 7),
    rows,
    report: reportToResponse(WeeklyReports.getByWeek(thisMonday)),
    stats: {
      total: allUserCount,
      thisWeekSubmitted: thisWeekSubmittedCount,
      thisWeekMissing: allUserCount - thisWeekSubmittedCount,
      nextWeekSubmitted: nextWeekSubmittedCount,
      nextWeekMissing: allUserCount - nextWeekSubmittedCount,
    },
  });
});

// 查看历史周
router.get('/admin/week/:weekStart', requireAdmin, (req, res) => {
  const { weekStart } = req.params;
  const { rows } = buildWeekOverview(weekStart);

  res.render('admin-week', {
    thisMonday: weekStart,
    weekEnd: addDays(weekStart, 6),
    nextMonday: addDays(weekStart, 7),
    rows,
  });
});

// ============== 用户管理 ==============

router.get('/admin/users', requireSuperAdmin, (req, res) => {
  const users = Users.all();
  res.render('admin-users', { users });
});

router.post('/admin/users/create', requireSuperAdmin, async (req, res) => {
  const { username, password, name, role } = req.body;
  if (!username || !password || !name) {
    req.session.flash = { type: 'error', message: '请填写完整信息' };
    return res.redirect('/admin/users');
  }

  if (Users.findByUsername(username.trim())) {
    req.session.flash = { type: 'error', message: '账号已存在' };
    return res.redirect('/admin/users');
  }

  const hash = await bcrypt.hash(password, 10);
  Users.create(username.trim(), hash, name.trim(), role === 'admin' ? 'admin' : 'user');
  req.session.flash = { type: 'success', message: `已添加用户：${name}` };
  res.redirect('/admin/users');
});

router.post('/admin/users/delete', requireSuperAdmin, (req, res) => {
  const { user_id } = req.body;
  const id = parseInt(user_id);
  if (id === req.session.userId) {
    req.session.flash = { type: 'error', message: '不能删除自己' };
    return res.redirect('/admin/users');
  }
  Users.delete(id);
  req.session.flash = { type: 'success', message: '用户已删除' };
  res.redirect('/admin/users');
});

router.post('/admin/users/reset-password', requireSuperAdmin, async (req, res) => {
  const { user_id, password } = req.body;
  if (!password || password.length < 6) {
    req.session.flash = { type: 'error', message: '密码长度至少 6 位' };
    return res.redirect('/admin/users');
  }
  const hash = await bcrypt.hash(password, 10);
  Users.resetPassword(parseInt(user_id), hash);
  req.session.flash = { type: 'success', message: '密码已重置，用户下次登录需修改密码' };
  res.redirect('/admin/users');
});

router.post('/admin/users/update-role', requireSuperAdmin, (req, res) => {
  const { user_id, role } = req.body;
  const id = parseInt(user_id);
  const target = Users.findById(id);
  if (!target) {
    req.session.flash = { type: 'error', message: '用户不存在' };
    return res.redirect('/admin/users');
  }
  if (target.username === SUPER_ADMIN_USERNAME) {
    req.session.flash = { type: 'error', message: '不能修改最高管理员角色' };
    return res.redirect('/admin/users');
  }
  Users.updateRole(id, role === 'admin' ? 'admin' : 'user');
  req.session.flash = { type: 'success', message: '角色权限已更新' };
  res.redirect('/admin/users');
});

// ============== 所有提交查看 ==============

router.get('/admin/submissions', requireAdmin, (req, res) => {
  const { week = getMondayOf(), user_id } = req.query;
  const allUsers = Users.all().filter(u => u.username !== SUPER_ADMIN_USERNAME);

  let rows;
  if (user_id) {
    rows = [Users.findById(parseInt(user_id))].filter(Boolean);
  } else {
    rows = allUsers;
  }

  const enriched = rows.map(u => {
    const thisSub = db.prepare(
      'SELECT * FROM submissions WHERE user_id = ? AND week_type = ? AND week_start = ?'
    ).get(u.id, 'this_week', week);
    const nextSub = db.prepare(
      'SELECT * FROM submissions WHERE user_id = ? AND week_type = ? AND week_start = ?'
    ).get(u.id, 'next_week', week);
    return {
      user: u,
      thisSub: thisSub || null,
      nextSub: nextSub || null,
      thisItems: thisSub ? Submissions.getItems(thisSub.id) : [],
      nextItems: nextSub ? Submissions.getItems(nextSub.id) : [],
    };
  });

  res.render('admin-submissions', {
    week,
    user_id: user_id || '',
    users: allUsers,
    rows: enriched,
  });
});

// ============== 本周期模板导出 ==============

router.post('/admin/export-weekly', requireAdmin, async (req, res) => {
  const { week_start = getMondayOf() } = req.body;
  const regenerate = req.body.regenerate === true || req.body.regenerate === '1' || req.body.regenerate === 'true';
  const settings = Settings.getAll();

  const existing = WeeklyReports.getByWeek(week_start);
  if (existing && !regenerate) {
    try {
      const repaired = await repairCachedReportIfNeeded(existing, req.session.userId);
      return res.json({ ok: true, fromCache: true, report: reportToResponse(repaired), ...reportToResponse(repaired) });
    } catch (err) {
      return res.json({ ok: false, error: '读取已生成文件失败：' + err.message });
    }
  }

  try {
    const labels = buildLabels(week_start);
    const { rows } = buildWeekOverview(week_start);
    const source = collectCycleSource(rows);

    if (!source.thisWeek.length && !source.nextWeek.length) {
      return res.json({ ok: false, error: '该周期还没有任何可汇总的填写内容' });
    }

    const aiResult = await callAiForExport(settings, labels, source);
    const thisWeekLines = compactSummaryLines(aiResult.parsed.thisWeek, source.thisWeek);
    const nextWeekLines = compactSummaryLines(aiResult.parsed.nextWeek, source.nextWeek);

    const report = await generateWeeklyReports({
      weekStart: week_start,
      thisWeekLines,
      nextWeekLines,
    });

    const saved = WeeklyReports.upsert({
      weekStart: week_start,
      weekRange: labels.weekRange,
      thisWeekSummary: thisWeekLines,
      nextWeekSummary: nextWeekLines,
      aiRaw: aiResult.raw,
      providerName: aiResult.providerName,
      model: aiResult.model,
      files: report.files.map(file => ({ type: file.type, filename: file.filename })),
      generatedBy: req.session.userId,
    });

    res.json({
      ok: true,
      fromCache: false,
      report: reportToResponse(saved),
      ...reportToResponse(saved),
    });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

router.get('/admin/export-weekly/status', requireAdmin, (req, res) => {
  const { week_start = getMondayOf() } = req.query;
  const report = WeeklyReports.getByWeek(week_start);
  res.json({ ok: true, report: reportToResponse(report) });
});

router.get('/admin/exports/:filename', requireAdmin, (req, res) => {
  const filename = path.basename(req.params.filename);
  if (filename !== req.params.filename) {
    return res.status(400).send('文件名不正确');
  }

  const filePath = path.join(EXPORT_DIR, filename);
  if (!filePath.startsWith(EXPORT_DIR) || !fs.existsSync(filePath)) {
    return res.status(404).send('文件不存在');
  }

  res.download(filePath, filename);
});

// ============== 设置（AI & 模板）==============

router.get('/admin/settings', requireSuperAdmin, (req, res) => {
  const settings = Settings.getAll();
  res.render('admin-settings', { settings, aiProviders: providersForSettings(settings) });
});

router.post('/admin/settings', requireSuperAdmin, (req, res) => {
  const {
    ai_base_url,
    ai_api_key,
    ai_model,
    ai_prompt,
    ai_export_prompt,
    email_required,
    reminder_enabled,
    reminder_day,
    reminder_time,
    reminder_interval_minutes,
    smtp_host,
    smtp_port,
    smtp_secure,
    smtp_user,
    smtp_pass,
    smtp_from,
    deadline_enabled,
  } = req.body;

  const aiProviders = buildProvidersFromBody(req.body);
  const payload = {
    ai_base_url,
    ai_api_key,
    ai_model,
    ai_providers: JSON.stringify(aiProviders),
    ai_prompt,
    ai_export_prompt,
    email_required: email_required ? '1' : '0',
    reminder_enabled: reminder_enabled ? '1' : '0',
    reminder_day: reminder_day || '5',
    reminder_time: reminder_time || '09:00',
    reminder_interval_minutes: reminder_interval_minutes || '60',
    smtp_host,
    smtp_port,
    smtp_secure: smtp_secure ? '1' : '0',
    smtp_user,
    smtp_pass,
    smtp_from,
  };
  // deadline_enabled 是 checkbox：存在即开启
  payload.deadline_enabled = deadline_enabled ? '1' : '0';

  Settings.setMany(payload);
  req.session.flash = { type: 'success', message: '设置已保存' };
  res.redirect('/admin/settings');
});

router.post('/admin/settings/test-smtp', requireSuperAdmin, async (req, res) => {
  try {
    const settings = {
      smtp_host: req.body.smtp_host,
      smtp_port: req.body.smtp_port || '465',
      smtp_secure: req.body.smtp_secure ? '1' : '0',
      smtp_user: req.body.smtp_user,
      smtp_pass: req.body.smtp_pass,
      smtp_from: req.body.smtp_from,
    };
    await sendTestEmail(settings, String(req.body.test_email || '').trim());
    res.json({ ok: true, message: '测试邮件已发送' });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ============== AI 汇总 ==============

router.post('/admin/ai-summary', requireAdmin, async (req, res) => {
  const { week_start, summary_type = 'this_week' } = req.body;
  const settings = Settings.getAll();

  if (!settings.ai_api_key) {
    return res.json({ ok: false, error: '请先在「设置」中配置 AI API Key' });
  }

  const weekRows = Submissions.getByWeek(week_start);
  const submissionIds = weekRows.flatMap(r => [r.this_id, r.next_id]).filter(Boolean);
  const items = Submissions.itemsBySubmissionIds(submissionIds);

  const itemsBySubId = {};
  items.forEach(it => {
    itemsBySubId[it.submission_id] = itemsBySubId[it.submission_id] || [];
    itemsBySubId[it.submission_id].push(it);
  });

  // 构造 prompt 数据
  const sections = [];
  weekRows.forEach(r => {
    if (summary_type === 'this_week' || summary_type === 'all') {
      const sub = r.this_id;
      if (!sub) return;
      const its = itemsBySubId[sub] || [];
      if (!its.length) return;
      sections.push({
        name: r.user_name,
        type: '本周工作',
        items: its.map(i => ({
          project_name: i.project_name,
          content: i.content,
        })),
      });
    }
    if (summary_type === 'next_week' || summary_type === 'all') {
      const sub = r.next_id;
      if (!sub) return;
      const its = itemsBySubId[sub] || [];
      if (!its.length) return;
      sections.push({
        name: r.user_name,
        type: '下周计划',
        items: its.map(i => ({
          project_name: i.project_name,
          content: i.content,
        })),
      });
    }
  });

  if (!sections.length) {
    return res.json({ ok: false, error: '该周没有任何提交内容' });
  }

  let submissionsText = '';
  sections.forEach(s => {
    submissionsText += `\n## ${s.name} - ${s.type}\n`;
    s.items.forEach((it, i) => {
      const proj = it.project_name ? `【${it.project_name}】` : '【无项目】';
      submissionsText += `${i + 1}. ${proj} ${it.content}\n`;
    });
  });

  const promptTemplate = settings.ai_prompt || '请汇总以下周报：\n{{submissions}}';
  const finalPrompt = promptTemplate.replace(/\{\{submissions\}\}/g, submissionsText);

  // 调用 OpenAI 兼容 API
  try {
    const baseUrl = (settings.ai_base_url || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.ai_api_key}`,
      },
      body: JSON.stringify({
        model: settings.ai_model || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: '你是周报汇总助手，回答使用中文。' },
          { role: 'user', content: finalPrompt },
        ],
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.json({ ok: false, error: `AI 调用失败: ${response.status} - ${errText}` });
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    res.json({ ok: true, content, submissionsText });
  } catch (err) {
    res.json({ ok: false, error: '请求失败: ' + err.message });
  }
});

module.exports = router;
