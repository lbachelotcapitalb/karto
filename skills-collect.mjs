#!/usr/bin/env node
// skills-collect.mjs — inventorie les skills perso de Owner (~/.claude/skills/*/SKILL.md) en
// données softcode pour karto. EXTRACTION SEULEMENT (aucune pédagogie figée ici) : on lit le
// frontmatter `name` + `description`, et on scinde la description en « ce que c'est » (summary)
// et « quand l'utiliser » (trigger). La pédagogie affichée (famille, verbe, phrase) est GÉNÉRÉE
// côté dashboard depuis data/skills_taxonomy.json — même principe que automation_taxonomy pour
// les automatisations. Régénérer : `node skills-collect.mjs` (inclus dans karto-index.mjs).
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dir = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(homedir(), '.claude', 'skills');
const OUT = join(__dir, 'data', 'skills_inventory.json');

// --- parse minimal du frontmatter YAML : name + description -----------------
// Gère : `desc: une ligne`, `desc: "quotée"`, et le scalaire plié `desc: >-` multi-lignes.
function frontmatter(md) {
  if (!md.startsWith('---')) return null;
  const end = md.indexOf('\n---', 3);
  if (end < 0) return null;
  const lines = md.slice(3, end).split('\n');
  const fields = {};
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    let val = m[2];
    if (['>-', '>', '|', '|-'].includes(val.trim()) || val.trim() === '') {
      const buf = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s/.test(lines[j]) || lines[j].trim() === '') buf.push(lines[j].trim());
        else break;
      }
      val = buf.join(' ').replace(/\s+/g, ' ').trim();
    } else {
      val = val.replace(/^["']|["']$/g, '').trim();
    }
    fields[m[1]] = val;
  }
  return fields;
}

// --- scinde la description : avant le marqueur = summary, à partir de lui = trigger ----
const MARKERS = [/utilise[\s-]le\s+quand/i, /utilise[\s-]le\s+pour/i, /utilise[\s-]le\s+si/i,
                 /use\s+it\s+when/i, /use\s+when/i, /trigger\s+with/i];
function splitDesc(desc) {
  for (const re of MARKERS) {
    const m = desc.match(re);
    if (m) return { summary: desc.slice(0, m.index).trim().replace(/[.\s—-]+$/, '') + '.',
                    trigger: desc.slice(m.index).trim() };
  }
  return { summary: desc.trim(), trigger: '' };
}

const skills = [];
if (existsSync(SKILLS_DIR)) {
  for (const name of readdirSync(SKILLS_DIR).sort()) {
    const dir = join(SKILLS_DIR, name);
    const sp = join(dir, 'SKILL.md');
    if (!existsSync(sp) || !statSync(dir).isDirectory()) continue;
    const fm = frontmatter(readFileSync(sp, 'utf8'));
    if (!fm || !fm.description) continue;
    const { summary, trigger } = splitDesc(fm.description);
    skills.push({ name: fm.name || name, summary, trigger, path: `~/.claude/skills/${name}` });
  }
}

writeFileSync(OUT, JSON.stringify({
  _doc: 'Inventaire softcode des skills perso de Owner, auto-extrait de ~/.claude/skills/*/SKILL.md (frontmatter). EXTRACTION SEULEMENT : name + description scindée en summary (ce que c\'est) / trigger (quand l\'utiliser). La pédagogie (famille, verbe, phrase) est générée côté dashboard depuis data/skills_taxonomy.json. Régénérer : node skills-collect.mjs (inclus dans karto-index.mjs).',
  generated: new Date().toISOString(),
  skills,
}, null, 2) + '\n');
(await import('./karto-sources.mjs')).touchSource(__dir, 'skills');
console.log(`✓ ${skills.length} skills → data/skills_inventory.json`);
