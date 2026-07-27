#!/usr/bin/env node
// skills-collect.mjs — inventorie les skills perso de Owner (~/.claude/skills/*/SKILL.md) en
// données softcode pour karto. EXTRACTION SEULEMENT (aucune pédagogie figée ici) : on lit le
// frontmatter `name` + `description`, et on scinde la description en « ce que c'est » (summary)
// et « quand l'utiliser » (trigger). La pédagogie affichée (famille, verbe, phrase) est GÉNÉRÉE
// côté dashboard depuis data/skills_taxonomy.json — même principe que automation_taxonomy pour
// les automatisations. Régénérer : `node skills-collect.mjs` (inclus dans karto-index.mjs).
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { extraireReferences } from './karto-refs.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const cfg = (() => { try { return JSON.parse(readFileSync(join(__dir, 'karto.config.json'), 'utf8')); } catch { return {}; } })();
const SKILLS_DIR = (cfg.skills?.dir || '~/.claude/skills').replace(/^~/, HOME);
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

/* ---------------- D4 — le collecteur était MUET : 37 entités, 0 arête ----------------
 * Il ne lisait que le frontmatter, donc karto savait qu'un skill EXISTE et rien de ce qu'il
 * TOUCHE : 31 skills sur 37 étaient sans aucune arête. Le corps du SKILL.md, lui, cite
 * nommément ce sur quoi le skill travaille — chemins, dépôts, serveurs MCP, domaines.
 *
 * On extrait des CANDIDATS d'identifiant, jamais des noms (extraction et résolution vivent
 * dans karto-refs.mjs, partagé avec karto-db.mjs — deux extracteurs écrits séparément
 * divergent au premier ajustement). La résolution vers une entité a lieu en fin de build,
 * quand toutes les entités existent. Un candidat qui ne correspond à rien n'écrit rien :
 * l'échec produit une arête ABSENTE — visible —, jamais une arête inventée (règle D2). */
/* --- où le skill est-il VERSIONNÉ ? (principe A1 : « tous les skills doivent vivre dans des
 * repos git ») — mesuré, pas déduit : `git rev-parse` sur le chemin RÉEL (7 skills sont des
 * liens symboliques vers d'autres dépôts), sinon sur la copie de sauvegarde déclarée en
 * config. Un skill qu'aucun dépôt ne porte reste sans arête, et c'est l'information utile. */
const gitRemote = dir => {
  try {
    const top = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const url = execFileSync('git', ['-C', top, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = url.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
    return m ? { repo: m[1], top } : null;
  } catch { return null; }
};
const BACKUP_REPOS = (cfg.skills?.backupRepos || []).map(p => p.replace(/^~/, HOME));

const skills = [];
if (existsSync(SKILLS_DIR)) {
  for (const name of readdirSync(SKILLS_DIR).sort()) {
    const dir = join(SKILLS_DIR, name);
    const sp = join(dir, 'SKILL.md');
    if (!existsSync(sp) || !statSync(dir).isDirectory()) continue;
    const md = readFileSync(sp, 'utf8');
    const fm = frontmatter(md);
    if (!fm || !fm.description) continue;
    const { summary, trigger } = splitDesc(fm.description);
    const refs = extraireReferences(md, HOME);
    // (1) le dossier réel est-il DANS un dépôt ? (cas des skills liés vers un projet)
    let vcs = gitRemote(realpathSync(dir));
    let via = vcs ? 'source' : null;
    // (2) sinon : une copie du skill est-elle versionnée dans un dépôt de sauvegarde ?
    if (!vcs) for (const b of BACKUP_REPOS) {
      if (!existsSync(join(b, 'skills', name, 'SKILL.md'))) continue;
      vcs = gitRemote(b); if (vcs) { via = 'sauvegarde'; break; }
    }
    skills.push({
      name: fm.name || name, summary, trigger, path: `~/.claude/skills/${name}`,
      repo: vcs?.repo || null, repoVia: via,
      refs,
    });
  }
}

writeFileSync(OUT, JSON.stringify({
  _doc: 'Inventaire softcode des skills perso de Owner, auto-extrait de ~/.claude/skills/*/SKILL.md. EXTRACTION SEULEMENT : name + description scindée en summary / trigger, + `refs` (identifiants CITÉS dans le corps : chemins, dépôts, serveurs MCP, domaines) et `repo` (dépôt git qui porte réellement le skill, mesuré par git rev-parse). Les refs sont des CANDIDATS : karto-db.mjs ne crée une arête que si le candidat correspond à une entité existante — un candidat orphelin n\'écrit rien, il n\'invente pas de nœud. La pédagogie (famille, verbe, phrase) est générée côté dashboard depuis data/skills_taxonomy.json. Régénérer : node skills-collect.mjs (inclus dans karto-index.mjs).',
  generated: new Date().toISOString(),
  skills,
}, null, 2) + '\n');
(await import('./karto-sources.mjs')).touchSource(__dir, 'skills');
const nRefs = skills.filter(s => s.refs.paths.length + s.refs.repos.length + s.refs.mcp.length + s.refs.domains.length).length;
const sansRepo = skills.filter(s => !s.repo).map(s => s.name);
console.log(`✓ ${skills.length} skills → data/skills_inventory.json  (${nRefs} avec ≥1 référence citée · ${skills.length - sansRepo.length} versionnés)`);
if (sansRepo.length) console.warn(`  ⚠ ${sansRepo.length} skill(s) dans AUCUN dépôt git (principe A1) : ${sansRepo.join(', ')}`);
