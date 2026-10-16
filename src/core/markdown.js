const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Markdown as Claude writes it, rendered safely: everything is escaped first,
 * then headings, lists, fenced code, inline code, bold, italics and tables
 * are rebuilt from the escaped text. Links show their text; nothing is
 * clickable, since a click must never navigate this window.
 */
export function md(source) {
  const inline = (t) => t
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,:;!?]|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '<u>$1</u>');
  const lines = escapeHtml(source).split('\n');
  const out = [];
  let list = null;
  let sub = null;
  let para = [];
  let table = [];
  const flush = () => {
    if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; }
    if (sub) { out.push(`</${sub}></li>`); sub = null; }
    if (list) { out.push(`</${list}>`); list = null; }
    if (table.length) {
      const [head, ...body] = table;
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      table = [];
    }
  };
  for (let k = 0; k < lines.length; k += 1) {
    const line = lines[k];
    if (/^```/.test(line)) {
      flush();
      const code = [];
      for (k += 1; k < lines.length && !/^```/.test(lines[k]); k += 1) code.push(lines[k]);
      out.push(`<pre><code>${code.join('\n')}</code></pre>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (para.length || list) { const t = table; table = []; flush(); table = t; }
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
      table.push(line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
      continue;
    }
    if (table.length) flush();
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (h) { flush(); out.push(`<h4>${inline(h[2])}</h4>`); }
    else if (ul || ol) {
      if (para.length) { const keep = list; list = null; flush(); list = keep; }
      const kind = ul ? 'ul' : 'ol';
      const indented = /^\s{2,}/.test(line);
      // One level of nesting: an indented item opens a list inside the item above.
      if (indented && list && !sub) {
        out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, '');
        out.push(`<${kind}>`);
        sub = kind;
      } else if (!indented && sub) {
        out.push(`</${sub}></li>`);
        sub = null;
      }
      if (!sub && list !== kind) { if (list) out.push(`</${list}>`); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline((ul ?? ol)[1])}</li>`);
    } else if (!line.trim()) flush();
    else { if (sub) { out.push(`</${sub}></li>`); sub = null; } if (list) { out.push(`</${list}>`); list = null; } para.push(line); }
  }
  flush();
  return out.join('');
}

