#!/usr/bin/env node
// make-site.mjs — assemble le site public déployable (landing + installeurs + dist) dans `site/`,
// en tamponnant le DOMAINE et le CHECKSUM. Cible : hébergement statique gratuit (Cloudflare Pages /
// Netlify). Le placeholder `get.karto.app` est remplacé partout par --host.
//
//   node make-site.mjs [--host usekarto.com] [--version 0.1.0]
//   → site/ : index.html (landing), install.sh, install.ps1, karto-dist.tar.gz/.zip (alias stable),
//             karto-<version>.tar.gz/.zip (versionné, lien de téléchargement + checksum).
//
// Déployer ensuite :
//   Cloudflare Pages : npx wrangler pages deploy site --project-name karto
//   Netlify         : netlify deploy --prod --dir site   (ou via netlify.toml publish="site")

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const arg = f => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : null; };
const HOST = arg('--host') || 'get.karto.app';
const VERSION = arg('--version') || '0.1.0';
const PLACEHOLDER = 'get.karto.app';
const SITE = join(DIR, 'site');

const tgz = join(DIR, 'dist', `karto-${VERSION}.tar.gz`);
const zip = join(DIR, 'dist', `karto-${VERSION}.zip`);
for (const f of [tgz, zip]) if (!existsSync(f)) { console.error(`✗ ${f} absent — lance d'abord : node make-dist.mjs --version ${VERSION}`); process.exit(1); }
for (const f of [join(DIR, 'landing/index.html'), join(DIR, 'install.sh'), join(DIR, 'install.ps1')]) if (!existsSync(f)) { console.error(`✗ ${f} absent.`); process.exit(1); }

const sha = f => createHash('sha256').update(readFileSync(f)).digest('hex');
const stampHost = s => s.split(PLACEHOLDER).join(HOST);

console.log(`\n  make-site → host=${HOST} · version=${VERSION}\n`);
rmSync(SITE, { recursive: true, force: true });
mkdirSync(SITE, { recursive: true });

// landing : domaine + checksum + version tamponnés
const shaTgz = sha(tgz);
let html = stampHost(readFileSync(join(DIR, 'landing/index.html'), 'utf8'));
html = html.replace(/var SHA256 = '[^']*';/, `var SHA256 = '${shaTgz}';`)
           .replace(/var VERSION = '[^']*';/, `var VERSION = '${VERSION}';`);
writeFileSync(join(SITE, 'index.html'), html);

// installeurs : domaine tamponné (DIST_URL pointe sur l'alias stable du même host)
writeFileSync(join(SITE, 'install.sh'), stampHost(readFileSync(join(DIR, 'install.sh'), 'utf8')));
writeFileSync(join(SITE, 'install.ps1'), stampHost(readFileSync(join(DIR, 'install.ps1'), 'utf8')));

// archives : versionnées + alias stable (l'installeur fetch karto-dist.*)
copyFileSync(tgz, join(SITE, `karto-${VERSION}.tar.gz`));
copyFileSync(zip, join(SITE, `karto-${VERSION}.zip`));
copyFileSync(tgz, join(SITE, 'karto-dist.tar.gz'));
copyFileSync(zip, join(SITE, 'karto-dist.zip'));

// fichier de checksums publiable
writeFileSync(join(SITE, 'SHA256SUMS.txt'), `${shaTgz}  karto-${VERSION}.tar.gz\n${sha(zip)}  karto-${VERSION}.zip\n`);

console.log(`  ✓ site/ assemblé :`);
for (const f of ['index.html', 'install.sh', 'install.ps1', 'karto-dist.tar.gz', 'karto-dist.zip', `karto-${VERSION}.tar.gz`, `karto-${VERSION}.zip`, 'SHA256SUMS.txt']) console.log('     ' + f);
console.log(`\n  sha256(tar.gz) = ${shaTgz}`);
if (HOST === PLACEHOLDER) console.log(`\n  ⚠ host = placeholder. Quand le domaine est choisi : node make-site.mjs --host <domaine>`);
console.log(`\n  Déployer : npx wrangler pages deploy site --project-name karto   (ou)   netlify deploy --prod --dir site\n`);
