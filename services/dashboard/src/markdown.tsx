// Minimal Markdown for chat answers: headings, lists, paragraphs, **bold**, *italic*, `code`.
// It builds React elements (never HTML strings), so model output cannot inject markup.
import type { ReactNode } from 'react';

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g;
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) out.push(<strong key={`${key}-${i++}`}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`')) out.push(<code key={`${key}-${i++}`} className="rounded bg-sidebar px-1 py-0.5 font-mono text-[12.5px]">{tok.slice(1, -1)}</code>);
    else out.push(<em key={`${key}-${i++}`}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, '').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0, b = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim() || /^-{3,}$/.test(line.trim())) { i++; continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { blocks.push(<p key={b++} className="pt-1 text-[14.5px] font-semibold">{inline(h[2]!, `h${b}`)}</p>); i++; continue; }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: ReactNode[] = [];
      while (i < lines.length && (/^\s*([-*]|\d+\.)\s+/.test(lines[i]!) || /^\s{2,}\S/.test(lines[i]!))) {
        const l = lines[i]!;
        if (/^\s*([-*]|\d+\.)\s+/.test(l) && !/^\s{2,}([-*]|\d+\.)/.test(l)) items.push(<li key={items.length}>{inline(l.replace(/^\s*([-*]|\d+\.)\s+/, ''), `li${b}-${items.length}`)}</li>);
        else items.push(<li key={items.length} className="ml-4 list-[circle]">{inline(l.trim().replace(/^([-*]|\d+\.)\s+/, ''), `sub${b}-${items.length}`)}</li>);
        i++;
      }
      blocks.push(ordered
        ? <ol key={b++} className="grid list-decimal gap-1 pl-5 marker:text-muted">{items}</ol>
        : <ul key={b++} className="grid list-disc gap-1 pl-5 marker:text-line-strong">{items}</ul>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,4})\s|^\s*([-*]|\d+\.)\s+/.test(lines[i]!)) para.push(lines[i++]!);
    blocks.push(<p key={b++}>{inline(para.join(' '), `p${b}`)}</p>);
  }
  return <div className="grid gap-2.5 text-[14px] leading-relaxed">{blocks}</div>;
}
