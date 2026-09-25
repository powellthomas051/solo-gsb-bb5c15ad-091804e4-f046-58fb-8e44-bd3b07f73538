/*
 * terms.js —— 双语术语核对：对照表解析 + 逐段中英出现次数核对（无 DOM 依赖）
 *
 * 录入格式：每行「中文术语=英文译名」（半角等号，仅第一个 = 起分隔作用）。
 *   1. 空行忽略；
 *   2. 缺等号、中文/英文为空（去掉行首尾空白后）、中文术语含空白、
 *      英文译名含字母/数字/空格/连字符/撇号以外字符等格式问题逐行报错；
 *   3. 中文术语重复（重复行自身也报错）；英文译名允许同义重复。
 *
 * 计数规则（仅由 UI 在「段落对齐开启且中英非空段落数一致」时调用）：
 *   - 中文术语：每个段落内最长优先、同长按录入顺序，命中区间不重叠计数；
 *   - 英文译名：忽略大小写、按完整词组边界计数——译名首尾字符的相邻位置
 *     不得是字母/数字/撇号，因此 art 不会计入 artist，连字符视为边界。
 *
 * 段落拆分与排版核心 LabelLayout.tokenize 的分段结果一致：
 * 去首尾空白、合并连续空白后为空的段不计。
 *
 * 可在浏览器（window.LabelTerm）与 Node（module.exports，配合 require('./layout')）中运行。
 */
(function (global) {
  'use strict';

  var APOS = '’'; // 右单引号 U+2019（撇号的弯引号形式，用于中文提示文案）

  // 换行（\n/\r，已按行切分）以外的 Unicode 空白
  function isWhitespaceCp(ch) {
    if (ch === 0x20 || ch === 0x09 || ch === 0x0b || ch === 0x0c ||
        ch === 0xa0 || ch === 0x1680 || ch === 0x2028 || ch === 0x2029 ||
        ch === 0x202f || ch === 0x205f || ch === 0x3000 || ch === 0xfeff) {
      return true;
    }
    return ch >= 0x2000 && ch <= 0x200a;
  }

  // 英文译名允许字符（正则字符类内容，全部转义书写）：
  // 拉丁字母（含扩展区）、数字、空白、连字符（U+002D/U+2010..U+2014）、
  // 撇号（U+0027/U+2019）。
  var EN_DASHES = '\\u002d\\u2010\\u2011\\u2012\\u2013\\u2014';
  var EN_PHRASE_ALLOWED =
    'A-Za-z\\u00aa\\u00b5\\u00ba\\u00c0-\\u00d6\\u00d8-\\u00f6\\u00f8-\\u02b0' +
    '\\u1e00-\\u1eff\\u2c60-\\u2c7f\\ua720-\\ua7ff0-9\\s' +
    EN_DASHES + '\\u0027\\u2019';

  function normalizeEnPhrase(raw) {
    return String(raw == null ? '' : raw)
      .replace(/\s+/g, ' ')
      .trim();
  }

  function hasInternalWhitespace(s) {
    var cps = Array.from(s);
    for (var i = 0; i < cps.length; i++) {
      if (isWhitespaceCp(cps[i].codePointAt(0))) return true;
    }
    return false;
  }

  /**
   * 解析术语核对表。
   * @param {string} raw 文本域原始内容
   * @returns {{entries:Array<{zh:string,en:string,idx:number}>, errors:string[]}}
   *   任一行格式错误都会记录在 errors（含行号），调用方据此禁用核对与打印。
   */
  function parseTermTable(raw) {
    var lines = String(raw == null ? '' : raw).split(/\r\n?|\n/);
    var entries = [];
    var errors = [];
    var seen = Object.create(null);
    var invalidRe = new RegExp('[^' + EN_PHRASE_ALLOWED + ']', 'g');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line === '') continue; // 空行忽略

      var eq = line.indexOf('=');
      if (eq < 0) {
        errors.push('第 ' + (i + 1) + ' 行「' + line +
          '」缺少半角等号：请按「中文术语=英文译名」填写。');
        continue;
      }
      var zh = line.slice(0, eq).trim();
      var en = normalizeEnPhrase(line.slice(eq + 1));
      if (!zh) {
        errors.push('第 ' + (i + 1) + ' 行中文术语为空：等号左侧需填写中文术语。');
        continue;
      }
      if (hasInternalWhitespace(zh)) {
        errors.push('第 ' + (i + 1) + ' 行中文术语「' + zh + '」含有空白字符，' +
          '请删除术语内的空格、制表符等。');
        continue;
      }
      if (!en) {
        errors.push('第 ' + (i + 1) + ' 行「' + zh +
          '=」的英文译名为空：等号右侧需填写英文译名。');
        continue;
      }
      var badChars = en.match(invalidRe);
      invalidRe.lastIndex = 0;
      if (badChars) {
        var uniq = Array.from(new Set(badChars)).join('');
        errors.push('第 ' + (i + 1) + ' 行英文译名「' + en + '」含有无法按完整词组' +
          '识别的字符「' + uniq + '」：仅允许字母、数字、空格、连字符（-）与撇号（' +
          APOS + '）。');
        continue;
      }
      if (seen[zh]) {
        errors.push('第 ' + (i + 1) + ' 行中文术语「' + zh + '」与第 ' +
          seen[zh] + ' 行重复：一个中文术语只能对应一条译名。');
        continue;
      }
      seen[zh] = String(i + 1);
      entries.push({ zh: zh, en: en, idx: entries.length });
    }
    return { entries: entries, errors: errors };
  }

  // 正则元字符转义，供英文译名做完整词组边界匹配
  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // 英文计数正则中译名首尾需要剥掉的字符（空白与撇号/连字符）
  var EDGE_TRIM = new RegExp(
    '^[\\s\\u0027\\u2019' + EN_DASHES + ']+|[\\s\\u0027\\u2019' + EN_DASHES + ']+$',
    'g'
  );

  /**
   * 英文译名在一段译文中的出现次数：忽略大小写、按完整词组边界计数。
   * 词组边界 = 译名首尾字符之外的相邻位置不是「字母/数字/撇号」；
   * 连字符视为边界（well-known 中不会命中 well），标点自然隔开两侧。
   */
  function countEnInParagraph(para, en) {
    var core = escapeRegExp(en).replace(EDGE_TRIM, '');
    if (!core) return 0;
    var re = new RegExp(
      "(?:^|[^A-Za-z0-9\\u0027\\u2019])" + core +
      "(?=$|[^A-Za-z0-9\\u0027\\u2019])",
      'gi'
    );
    var count = 0;
    String(para).toLowerCase().replace(re, function () { count++; return ''; });
    return count;
  }

  /**
   * 各中文术语在一段正文中的出现次数：最长优先、命中区间不重叠。
   * @returns {number[]} 与 entries 同序的次数数组
   */
  function countZhInParagraph(para, entries) {
    var chars = Array.from(String(para == null ? '' : para));
    var n = chars.length;
    var terms = entries.map(function (e) {
      return { cps: Array.from(e.zh), idx: e.idx };
    });
    // 长词优先，同长按术语表录入顺序
    terms.sort(function (a, b) {
      return b.cps.length - a.cps.length || a.idx - b.idx;
    });
    var counts = new Array(entries.length).fill(0);
    var used = new Array(n).fill(false);
    var pos = 0;
    while (pos < n) {
      if (used[pos]) { pos++; continue; }
      var hitIdx = -1, hitLen = 0;
      for (var k = 0; k < terms.length; k++) {
        var cps = terms[k].cps;
        if (cps.length <= hitLen || pos + cps.length > n) continue;
        var ok = true;
        for (var m = 0; m < cps.length; m++) {
          if (used[pos + m] || chars[pos + m] !== cps[m]) { ok = false; break; }
        }
        if (ok) { hitIdx = terms[k].idx; hitLen = cps.length; }
      }
      if (hitIdx >= 0) {
        for (var u = 0; u < hitLen; u++) used[pos + u] = true;
        counts[hitIdx]++;
        pos += hitLen; // 命中区间不再参与后续计数
      } else {
        pos++;
      }
    }
    return counts;
  }

  // 非空段落（拼接 token 文本）：与排版核心 tokenize 的分段结果一致
  function splitParagraphs(LabelLayout, text) {
    return LabelLayout.tokenize(text || '').map(function (tokens) {
      return tokens.map(function (tk) { return tk.t; }).join('');
    });
  }

  /**
   * 逐段核对。调用前应确认段落对齐开启且中英非空段落数一致。
   * @param {object} LabelLayout 排版核心（tokenize）
   * @param {string} zhText 当前选定成品版本（原稿或修订稿）的中文正文
   * @param {string} enText 共用的英文译文
   * @param {Array} entries parseTermTable 得到的有效条目
   * @returns {{paraCount:number, rows:Array<{para,idx,zh,en,zhCount,enCount,bad}>}}
   *   rows 只含两侧次数不一致的条目，按段号、录入顺序排列。
   */
  function checkTerms(LabelLayout, zhText, enText, entries) {
    var zhParas = splitParagraphs(LabelLayout, zhText);
    var enParas = splitParagraphs(LabelLayout, enText);
    var rows = [];
    if (zhParas.length !== enParas.length || !zhParas.length) {
      return { paraCount: zhParas.length, rows: rows };
    }
    for (var p = 0; p < zhParas.length; p++) {
      var zhCounts = countZhInParagraph(zhParas[p], entries);
      for (var t = 0; t < entries.length; t++) {
        var enCount = countEnInParagraph(enParas[p], entries[t].en);
        if (zhCounts[t] !== enCount) {
          rows.push({
            para: p + 1, idx: t,
            zh: entries[t].zh, en: entries[t].en,
            zhCount: zhCounts[t], enCount: enCount, bad: true
          });
        }
      }
    }
    return { paraCount: zhParas.length, rows: rows };
  }

  var api = {
    parseTermTable: parseTermTable,
    countEnInParagraph: countEnInParagraph,
    countZhInParagraph: countZhInParagraph,
    splitParagraphs: splitParagraphs,
    checkTerms: checkTerms
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.LabelTerm = api;
})(typeof window !== 'undefined' ? window : globalThis);
