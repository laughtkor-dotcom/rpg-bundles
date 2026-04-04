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
  for (const q of queries) {
    try {
      return await fetchTable(table, q);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`REST ${table} failed for all query variants:\n${errors.join('\n')}`);
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

function q(select, order) {
  return `select=${select}&order=${order}`;
}

function sortBySortOrderThen(rows, field = 'name') {
  return [...rows].sort((a, b) => {
    const left = Number(a?.sort_order ?? 100);
    const right = Number(b?.sort_order ?? 100);
    if (left !== right) return left - right;
    return String(a?.[field] ?? a?.title ?? '').localeCompare(String(b?.[field] ?? b?.title ?? ''), 'ru');
  });
}

function normalizeOptionalKeys(rows, keys) {
  return rows.map((row) => {
    const next = { ...row };
    for (const key of keys) {
      if (!(key in next)) next[key] = null;
    }
    return next;
  });
}

function withDefaultSortOrder(rows) {
  return rows.map((row, index) => ({
    sort_order: row?.sort_order ?? (index + 1) * 10,
    ...row,
  }));
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
    fetchTableWithFallbacks('races', [
      q('id,name,description,summary,content_html,image_url,sort_order,is_active', 'sort_order.asc.nullslast,name.asc'),
      q('id,name,description,image_url,is_active', 'name.asc'),
    ]),
    fetchTableWithFallbacks('subraces', [
      q('id,race_id,name,description,summary,content_html,image_url,sort_order,is_active', 'sort_order.asc.nullslast,name.asc'),
      q('id,race_id,name,description,image_url,is_active', 'name.asc'),
    ]),
    fetchTableWithFallbacks('factions', [
      q('id,name,description,summary,content_html,image_url,sort_order,is_active', 'sort_order.asc.nullslast,name.asc'),
      q('id,name,description,image_url,is_active', 'name.asc'),
    ]),
    fetchTableWithFallbacks('professions', [
      q('id,name,description,summary,content_html,image_url,sort_order,is_active', 'sort_order.asc.nullslast,name.asc'),
      q('id,name,description,image_url,is_active', 'name.asc'),
    ]),
    fetchTableWithFallbacks('skill_categories', [
      q('id,name,description,summary,content_html,image_url,sort_order,is_active', 'sort_order.asc.nullslast,name.asc'),
      q('id,name,summary,content_html,image_url,sort_order,is_active', 'sort_order.asc.nullslast,name.asc'),
      q('id,name,description,summary,content_html,image_url,is_active', 'name.asc'),
      q('id,name,summary,content_html,image_url,is_active', 'name.asc'),
      q('id,name,image_url,is_active', 'name.asc'),
    ]),
    fetchTableWithFallbacks('skills', [
      q('id,category_id,name,description,summary,content_html,image_url,is_metamagic,sort_order,is_active,required_race_id,required_subrace_id,required_profession_id,required_profession_level', 'sort_order.asc.nullslast,name.asc'),
      q('id,category_id,name,description,image_url,is_metamagic,is_active,required_race_id,required_subrace_id,required_profession_id,required_profession_level', 'name.asc'),
    ]),
    fetchTableWithFallbacks('magic_branches', [
      q('id,name,description,summary,content_html,image_url,sort_order,is_active,required_faction_id,required_reputation_value,is_hidden_until_unlocked', 'sort_order.asc.nullslast,name.asc'),
      q('id,name,description,image_url,is_active,required_faction_id,required_reputation_value,is_hidden_until_unlocked', 'name.asc'),
    ]),
    fetchTableWithFallbacks('spells', [
      q('id,branch_id,name,description,summary,content_html,image_url,sort_order,is_active,required_race_id,required_subrace_id,required_profession_id,required_profession_level', 'sort_order.asc.nullslast,name.asc'),
      q('id,branch_id,name,description,image_url,is_active,required_race_id,required_subrace_id,required_profession_id,required_profession_level', 'name.asc'),
    ]),
    fetchTableWithFallbacks('state_definitions', [
      q('id,name,summary,description,content_html,image_url,sort_order,is_active', 'sort_order.asc.nullslast,name.asc'),
      q('id,name,summary,content_html,image_url,sort_order,is_active', 'sort_order.asc.nullslast,name.asc'),
      q('id,name,description,summary,content_html,image_url,is_active', 'name.asc'),
      q('id,name,summary,content_html,image_url,is_active', 'name.asc'),
      q('id,name,content_html,image_url,is_active', 'name.asc'),
      q('id,name,image_url,is_active', 'name.asc'),
    ]),
  ]);

  return {
    generated_at: new Date().toISOString(),
    races: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(races), ['description', 'summary', 'content_html', 'image_url', 'is_active'])),
    subraces: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(subraces), ['description', 'summary', 'content_html', 'image_url', 'is_active'])),
    factions: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(factions), ['description', 'summary', 'content_html', 'image_url', 'is_active'])),
    professions: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(professions), ['description', 'summary', 'content_html', 'image_url', 'is_active'])),
    skill_categories: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(skillCategories), ['description', 'summary', 'content_html', 'image_url', 'is_active'])),
    skills: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(skills), ['description', 'summary', 'content_html', 'image_url', 'is_active'])),
    magic_branches: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(branches), ['description', 'summary', 'content_html', 'image_url', 'is_active'])),
    spells: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(spells), ['description', 'summary', 'content_html', 'image_url', 'is_active'])),
    state_definitions: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(stateDefinitions), ['description', 'summary', 'content_html', 'image_url', 'is_active'])),
  };
}

async function buildContentBundle() {
  const [contentPages, libraryEntries, npcEntries, bestiaryEntries] = await Promise.all([
    fetchTableWithFallbacks('content_pages', [
      q('id,slug,title,content,summary,content_html,image_url,external_url,sort_order,is_published,updated_at', 'sort_order.asc.nullslast,id.asc'),
      q('id,slug,title,content,summary,image_url,external_url,sort_order,is_published,updated_at', 'sort_order.asc.nullslast,id.asc'),
      q('id,slug,title,content,summary,image_url,external_url,is_published,updated_at', 'id.asc'),
    ]),
    fetchTableWithFallbacks('library_entries', [
      q('id,title,entry_type,summary,content,content_html,image_url,external_url,sort_order,is_published', 'sort_order.asc.nullslast,id.asc'),
      q('id,title,entry_type,summary,content,image_url,external_url,sort_order,is_published', 'sort_order.asc.nullslast,id.asc'),
      q('id,title,entry_type,summary,content,image_url,external_url,is_published', 'id.asc'),
    ]),
    fetchTableWithFallbacks('npc_entries', [
      q('id,name,npc_type,faction_id,summary,description,content,content_html,image_url,external_url,sort_order,is_published', 'sort_order.asc.nullslast,id.asc'),
      q('id,name,npc_type,faction_id,summary,content,content_html,image_url,external_url,sort_order,is_published', 'sort_order.asc.nullslast,id.asc'),
      q('id,name,npc_type,faction_id,summary,description,content,image_url,external_url,is_published', 'id.asc'),
      q('id,name,npc_type,faction_id,summary,content,image_url,external_url,is_published', 'id.asc'),
    ]),
    fetchTableWithFallbacks('bestiary_entries', [
      q('id,name,creature_type,danger_level,summary,description,content,content_html,image_url,external_url,sort_order,is_published', 'sort_order.asc.nullslast,id.asc'),
      q('id,name,creature_type,danger_level,summary,content,content_html,image_url,external_url,sort_order,is_published', 'sort_order.asc.nullslast,id.asc'),
      q('id,name,creature_type,danger_level,summary,description,content,image_url,external_url,is_published', 'id.asc'),
      q('id,name,creature_type,danger_level,summary,content,image_url,external_url,is_published', 'id.asc'),
    ]),
  ]);

  return {
    generated_at: new Date().toISOString(),
    content_pages: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(contentPages), ['content', 'summary', 'content_html', 'image_url', 'external_url', 'is_published', 'updated_at']), 'title'),
    library_entries: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(libraryEntries), ['entry_type', 'summary', 'content', 'content_html', 'image_url', 'external_url', 'is_published']), 'title'),
    npc_entries: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(npcEntries), ['npc_type', 'faction_id', 'summary', 'description', 'content', 'content_html', 'image_url', 'external_url', 'is_published'])),
    bestiary_entries: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(bestiaryEntries), ['creature_type', 'danger_level', 'summary', 'description', 'content', 'content_html', 'image_url', 'external_url', 'is_published'])),
  };
}

async function buildCharacterCardsBundle() {
  let visibleRows = await callRpc('list_public_approved_character_sheets');
  let rows = Array.isArray(visibleRows) ? visibleRows : [];

  if (rows.length === 0) {
    const [characters, profiles] = await Promise.all([
      fetchTableWithFallbacks('characters', [
        q('id,owner_id,full_name,status,updated_at', 'updated_at.desc.nullslast'),
        q('id,owner_id,full_name,status', 'full_name.asc'),
      ]),
      fetchTableWithFallbacks('profiles', [
        q('id,nickname', 'nickname.asc'),
      ]),
    ]);

    const nicknameByProfileId = new Map((profiles ?? []).map((row) => [row.id, row.nickname ?? null]));
    rows = (characters ?? [])
      .filter((row) => String(row.status ?? '') === 'approved')
      .map((row) => ({
        id: row.id,
        owner_id: row.owner_id,
        owner_nickname: nicknameByProfileId.get(row.owner_id) ?? null,
      }));
  }

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
