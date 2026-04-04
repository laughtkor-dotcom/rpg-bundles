import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/+$/, '') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const OUTPUT_DIR = process.env.OUTPUT_DIR ?? 'dist';
const BUNDLES_DIR = path.join(OUTPUT_DIR, 'bundles');
const BUNDLE_PUBLIC_BASE_URL = resolvePublicBaseUrl();

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

const headers = {
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

function resolvePublicBaseUrl() {
  const explicit = String(process.env.BUNDLE_PUBLIC_BASE_URL ?? '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const repository = String(process.env.GITHUB_REPOSITORY ?? '').trim();
  if (!repository.includes('/')) {
    throw new Error('Missing BUNDLE_PUBLIC_BASE_URL and unable to infer from GITHUB_REPOSITORY');
  }

  const [owner, repo] = repository.split('/');
  return `https://${owner}.github.io/${repo}`;
}

function buildRestUrl(table, query) {
  return `${SUPABASE_URL}/rest/v1/${table}?${query}`;
}

async function fetchTable(table, query) {
  const res = await fetch(buildRestUrl(table, query), { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`REST ${table} failed: ${res.status} ${text}`);
  }
  return await res.json();
}

async function fetchTableWithFallbacks(table, queries) {
  const errors = [];
  for (const query of queries) {
    try {
      return await fetchTable(table, query);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`REST ${table} failed for all query variants:
${errors.join('
')}`);
}

async function callRpc(name, body = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RPC ${name} failed: ${res.status} ${text}`);
  }

  return await res.json();
}

function sortBySortOrderThen(rows, field = 'name') {
  return [...rows].sort((a, b) => {
    const left = Number(a?.sort_order ?? 100);
    const right = Number(b?.sort_order ?? 100);
    if (left !== right) return left - right;
    return String(a?.[field] ?? a?.title ?? '').localeCompare(String(b?.[field] ?? b?.title ?? ''), 'ru');
  });
}

async function buildReferenceBundle() {
  const [
    races,
    subraces,
    factions,
    professions,
    skillCategories,
    skills,
    branches,
    spells,
    stateDefinitions,
  ] = await Promise.all([
    fetchTable('races', 'select=id,name,description,summary,content_html,image_url,sort_order,is_active&order=sort_order.asc.nullslast,name.asc'),
    fetchTable('subraces', 'select=id,race_id,name,description,summary,content_html,image_url,sort_order,is_active&order=sort_order.asc.nullslast,name.asc'),
    fetchTable('factions', 'select=id,name,description,summary,content_html,image_url,sort_order,is_active&order=sort_order.asc.nullslast,name.asc'),
    fetchTable('professions', 'select=id,name,description,summary,content_html,image_url,sort_order,is_active&order=sort_order.asc.nullslast,name.asc'),
    fetchTable('skill_categories', 'select=id,name,description,summary,content_html,image_url,sort_order,is_active&order=sort_order.asc.nullslast,name.asc'),
    fetchTable('skills', 'select=id,category_id,name,description,summary,content_html,image_url,is_metamagic,sort_order,is_active,required_race_id,required_subrace_id,required_profession_id,required_profession_level&order=sort_order.asc.nullslast,name.asc'),
    fetchTable('magic_branches', 'select=id,name,description,summary,content_html,image_url,sort_order,is_active,required_faction_id,required_reputation_value,is_hidden_until_unlocked&order=sort_order.asc.nullslast,name.asc'),
    fetchTable('spells', 'select=id,branch_id,name,description,summary,content_html,image_url,sort_order,is_active,required_race_id,required_subrace_id,required_profession_id,required_profession_level&order=sort_order.asc.nullslast,name.asc'),
    fetchTableWithFallbacks('state_definitions', [
      'select=id,name,summary,description,content_html,image_url,sort_order,is_active&order=sort_order.asc.nullslast,name.asc',
      'select=id,name,summary,content_html,image_url,sort_order,is_active&order=sort_order.asc.nullslast,name.asc',
    ]),
  ]);

  return {
    generated_at: new Date().toISOString(),
    races: sortBySortOrderThen(races),
    subraces: sortBySortOrderThen(subraces),
    factions: sortBySortOrderThen(factions),
    professions: sortBySortOrderThen(professions),
    skill_categories: sortBySortOrderThen(skillCategories),
    skills: sortBySortOrderThen(skills),
    magic_branches: sortBySortOrderThen(branches),
    spells: sortBySortOrderThen(spells),
    state_definitions: sortBySortOrderThen(stateDefinitions),
  };
}

async function buildContentBundle() {
  const [contentPages, libraryEntries, npcEntries, bestiaryEntries] = await Promise.all([
    fetchTable('content_pages', 'select=id,slug,title,content,summary,content_html,image_url,external_url,sort_order,is_published,updated_at&order=sort_order.asc.nullslast,id.asc'),
    fetchTable('library_entries', 'select=id,title,entry_type,summary,content,content_html,image_url,external_url,sort_order,is_published&order=sort_order.asc.nullslast,id.asc'),
    fetchTable('npc_entries', 'select=id,name,npc_type,faction_id,summary,description,content,content_html,image_url,external_url,sort_order,is_published&order=sort_order.asc.nullslast,id.asc'),
    fetchTable('bestiary_entries', 'select=id,name,creature_type,danger_level,summary,description,content,content_html,image_url,external_url,sort_order,is_published&order=sort_order.asc.nullslast,id.asc'),
  ]);

  return {
    generated_at: new Date().toISOString(),
    content_pages: sortBySortOrderThen(contentPages, 'title'),
    library_entries: sortBySortOrderThen(libraryEntries, 'title'),
    npc_entries: sortBySortOrderThen(npcEntries),
    bestiary_entries: sortBySortOrderThen(bestiaryEntries),
  };
}

async function buildCharacterCardsBundle() {
  const visibleRows = await callRpc('list_public_approved_character_sheets');
  const rows = Array.isArray(visibleRows) ? visibleRows : [];

  const cards = [];
  for (const row of rows) {
    const payload = await callRpc('get_visible_character_sheet', { p_character_id: row.id });
    if (!payload || !payload.character) continue;

    cards.push({
      id: row.id,
      owner_id: row.owner_id,
      owner_nickname: row.owner_nickname ?? null,
      source: String(payload.source ?? 'approved_snapshot'),
      character: payload.character ?? null,
      skills: Array.isArray(payload.skills) ? payload.skills : [],
      spells: Array.isArray(payload.spells) ? payload.spells : [],
      professions: Array.isArray(payload.professions) ? payload.professions : [],
      states: Array.isArray(payload.states) ? payload.states : [],
    });
  }

  cards.sort((a, b) => String(a.character?.full_name ?? '').localeCompare(String(b.character?.full_name ?? ''), 'ru'));

  return {
    generated_at: new Date().toISOString(),
    cards,
  };
}

function buildManifest({ reference, content, characterCards }) {
  const generatedAt = new Date().toISOString();
  return {
    generated_at: generatedAt,
    bucket: 'github-pages',
    bundles: {
      reference: {
        path: 'bundles/reference.json',
        public_url: `${BUNDLE_PUBLIC_BASE_URL}/bundles/reference.json`,
        generated_at: reference.generated_at,
      },
      content: {
        path: 'bundles/content.json',
        public_url: `${BUNDLE_PUBLIC_BASE_URL}/bundles/content.json`,
        generated_at: content.generated_at,
      },
      'character-cards': {
        path: 'bundles/character-cards.json',
        public_url: `${BUNDLE_PUBLIC_BASE_URL}/bundles/character-cards.json`,
        generated_at: characterCards.generated_at,
      },
    },
  };
}

async function writeJson(filePath, value) {
  await writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

async function writeSupportPages() {
  const indexHtml = `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>RPG Bundles Mirror</title>
    <style>
      body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 40px auto; max-width: 860px; padding: 0 16px; line-height: 1.5; }
      code { background: #f3f5f8; padding: 2px 6px; border-radius: 6px; }
    </style>
  </head>
  <body>
    <h1>RPG Bundles Mirror</h1>
    <p>Этот сайт раздаёт публичные JSON-бандлы для приложения.</p>
    <ul>
      <li><a href="./bundles/reference.json">reference.json</a></li>
      <li><a href="./bundles/content.json">content.json</a></li>
      <li><a href="./bundles/character-cards.json">character-cards.json</a></li>
      <li><a href="./bundles/manifest.json">manifest.json</a></li>
    </ul>
  </body>
</html>`;

  const notFoundHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Not found</title></head><body><h1>404</h1></body></html>`;
  await writeFile(path.join(OUTPUT_DIR, 'index.html'), indexHtml, 'utf8');
  await writeFile(path.join(OUTPUT_DIR, '404.html'), notFoundHtml, 'utf8');
}

async function main() {
  await mkdir(BUNDLES_DIR, { recursive: true });

  const [reference, content, characterCards] = await Promise.all([
    buildReferenceBundle(),
    buildContentBundle(),
    buildCharacterCardsBundle(),
  ]);

  const manifest = buildManifest({ reference, content, characterCards });

  await Promise.all([
    writeJson(path.join(BUNDLES_DIR, 'reference.json'), reference),
    writeJson(path.join(BUNDLES_DIR, 'content.json'), content),
    writeJson(path.join(BUNDLES_DIR, 'character-cards.json'), characterCards),
    writeJson(path.join(BUNDLES_DIR, 'manifest.json'), manifest),
    writeSupportPages(),
  ]);

  console.log('Bundles generated successfully');
  console.log(`Public base URL: ${BUNDLE_PUBLIC_BASE_URL}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
