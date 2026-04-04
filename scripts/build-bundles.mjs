
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function buildRestUrl(table, query) {
  return `${SUPABASE_URL}/rest/v1/${table}?${query}`;
}

async function fetchTable(table, query, attempts = 4) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(buildRestUrl(table, query), { headers });
      if (!res.ok) {
        const text = await res.text();
        const error = new Error(`REST ${table} failed: ${res.status} ${text}`);
        if (isRetryableStatus(res.status) && attempt < attempts) {
          await sleep(400 * attempt);
          lastError = error;
          continue;
        }
        throw error;
      }
      return await res.json();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt >= attempts) break;
      await sleep(400 * attempt);
    }
  }

  throw lastError ?? new Error(`REST ${table} failed`);
}

async function fetchOptionalTable(table, queries, defaultValue = []) {
  try {
    return await fetchTableWithFallbacks(table, queries);
  } catch (_error) {
    return defaultValue;
  }
}

async function fetchTableWithFallbacks(table, queries) {
  const errors = [];
  for (const qv of queries) {
    try {
      return await fetchTable(table, qv);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`REST ${table} failed for all query variants:\n${errors.join('\n')}`);
}

function q(select, order = 'id.asc') {
  return `select=${encodeURIComponent(select)}&order=${encodeURIComponent(order)}`;
}

function sortBySortOrderThen(rows, field = 'name') {
  return [...rows].sort((a, b) => {
    const left = Number(a?.sort_order ?? 100);
    const right = Number(b?.sort_order ?? 100);
    if (left !== right) return left - right;
    return String(a?.[field] ?? a?.title ?? a?.label ?? '').localeCompare(
      String(b?.[field] ?? b?.title ?? b?.label ?? ''),
      'ru',
    );
  });
}

function normalizeOptionalKeys(rows, keys) {
  return (rows ?? []).map((row) => {
    const next = { ...row };
    for (const key of keys) {
      if (!(key in next)) next[key] = null;
    }
    return next;
  });
}

function withDefaultSortOrder(rows) {
  return (rows ?? []).map((row, index) => ({
    ...row,
    sort_order: row?.sort_order ?? (index + 1) * 10,
  }));
}

function buildPublicBundleEntry(name, generatedAt) {
  return {
    path: `bundles/${name}.json`,
    public_url: `${BUNDLE_PUBLIC_BASE_URL}/bundles/${name}.json`,
    generated_at: generatedAt,
  };
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
    fetchTableWithFallbacks('races', [q('*', 'id.asc'), q('id,name,description,image_url,is_active', 'id.asc')]),
    fetchTableWithFallbacks('subraces', [q('*', 'id.asc'), q('id,race_id,name,description,image_url,is_active', 'id.asc')]),
    fetchTableWithFallbacks('factions', [q('*', 'id.asc'), q('id,name,description,image_url,is_active', 'id.asc')]),
    fetchTableWithFallbacks('professions', [q('*', 'id.asc'), q('id,name,description,image_url,is_active', 'id.asc')]),
    fetchTableWithFallbacks('skill_categories', [q('*', 'id.asc'), q('id,name,image_url,is_active', 'id.asc')]),
    fetchTableWithFallbacks('skills', [q('*', 'id.asc'), q('id,category_id,name,description,image_url,is_metamagic', 'id.asc')]),
    fetchTableWithFallbacks('magic_branches', [q('*', 'id.asc'), q('id,name,description,image_url,is_active', 'id.asc')]),
    fetchTableWithFallbacks('spells', [q('*', 'id.asc'), q('id,branch_id,name,description,image_url,is_active', 'id.asc')]),
    fetchTableWithFallbacks('state_definitions', [q('*', 'id.asc'), q('id,name,image_url,is_active', 'id.asc')]),
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
    fetchOptionalTable('content_pages', [q('*', 'id.asc')]),
    fetchOptionalTable('library_entries', [q('*', 'id.asc')]),
    fetchOptionalTable('npc_entries', [q('*', 'id.asc')]),
    fetchOptionalTable('bestiary_entries', [q('*', 'id.asc')]),
  ]);

  return {
    generated_at: new Date().toISOString(),
    content_pages: sortBySortOrderThen(withDefaultSortOrder(contentPages), 'title'),
    library_entries: sortBySortOrderThen(withDefaultSortOrder(libraryEntries), 'title'),
    npc_entries: sortBySortOrderThen(withDefaultSortOrder(npcEntries), 'name'),
    bestiary_entries: sortBySortOrderThen(withDefaultSortOrder(bestiaryEntries), 'name'),
  };
}

async function buildCharacterCardsBundle() {
  const [characters, profiles, characterSkills, skills, characterSpells, spells, characterProfessions, characterStates, stateDefinitions] = await Promise.all([
    fetchTableWithFallbacks('characters', [q('*', 'updated_at.desc.nullslast'), q('id,owner_id,full_name,status,updated_at', 'updated_at.desc.nullslast')]),
    fetchOptionalTable('profiles', [q('id,nickname,vk_user_id', 'nickname.asc')]),
    fetchOptionalTable('character_skills', [q('*', 'character_id.asc')]),
    fetchOptionalTable('skills', [q('*', 'id.asc')]),
    fetchOptionalTable('character_spells', [q('*', 'character_id.asc')]),
    fetchOptionalTable('spells', [q('*', 'id.asc')]),
    fetchOptionalTable('character_professions', [q('*', 'character_id.asc')]),
    fetchOptionalTable('character_states', [q('*', 'character_id.asc')]),
    fetchOptionalTable('state_definitions', [q('*', 'id.asc')]),
  ]);

  const approvedCharacters = (characters ?? []).filter((row) => String(row.status ?? '') === 'approved');
  const profileById = new Map((profiles ?? []).map((row) => [row.id, row]));
  const skillById = new Map((skills ?? []).map((row) => [row.id, row]));
  const spellById = new Map((spells ?? []).map((row) => [row.id, row]));
  const stateDefinitionById = new Map((stateDefinitions ?? []).map((row) => [row.id, row]));

  const skillLinksByCharacterId = new Map();
  for (const row of characterSkills ?? []) {
    const current = skillLinksByCharacterId.get(row.character_id) ?? [];
    current.push(row.skill_id);
    skillLinksByCharacterId.set(row.character_id, current);
  }

  const spellLinksByCharacterId = new Map();
  for (const row of characterSpells ?? []) {
    const current = spellLinksByCharacterId.get(row.character_id) ?? [];
    current.push(row.spell_id);
    spellLinksByCharacterId.set(row.character_id, current);
  }

  const professionsByCharacterId = new Map();
  for (const row of characterProfessions ?? []) {
    const current = professionsByCharacterId.get(row.character_id) ?? [];
    current.push(row);
    professionsByCharacterId.set(row.character_id, current);
  }

  const statesByCharacterId = new Map();
  for (const row of characterStates ?? []) {
    const current = statesByCharacterId.get(row.character_id) ?? [];
    current.push({
      ...row,
      state: stateDefinitionById.get(row.state_id) ?? null,
    });
    statesByCharacterId.set(row.character_id, current);
  }

  const cards = approvedCharacters.map((row) => {
    const profile = profileById.get(row.owner_id) ?? null;
    return {
      id: row.id,
      owner_id: row.owner_id,
      owner_vk_user_id: profile?.vk_user_id ?? null,
      owner_nickname: profile?.nickname ?? null,
      source: 'approved_snapshot',
      character: { ...row },
      skills: (skillLinksByCharacterId.get(row.id) ?? []).map((skillId) => skillById.get(skillId)).filter(Boolean),
      spells: (spellLinksByCharacterId.get(row.id) ?? []).map((spellId) => spellById.get(spellId)).filter(Boolean),
      professions: professionsByCharacterId.get(row.id) ?? [],
      states: statesByCharacterId.get(row.id) ?? [],
    };
  });

  cards.sort((a, b) => String(a.character?.full_name ?? '').localeCompare(String(b.character?.full_name ?? ''), 'ru'));

  return {
    generated_at: new Date().toISOString(),
    cards,
  };
}

async function buildMapsPublicBundle() {
  const [maps, locations] = await Promise.all([
    fetchOptionalTable('maps', [q('*', 'id.asc'), q('id,title,slug,image_url,is_active', 'id.asc')]),
    fetchOptionalTable('locations', [q('*', 'id.asc'), q('id,map_id,title,slug,image_url,is_active', 'id.asc')]),
  ]);

  return {
    generated_at: new Date().toISOString(),
    maps: sortBySortOrderThen(withDefaultSortOrder(maps), 'title'),
    locations: sortBySortOrderThen(withDefaultSortOrder(locations), 'title'),
  };
}

async function buildShopCatalogBundle() {
  const [shopItems, items, thresholds, effectDefinitions, factions] = await Promise.all([
    fetchOptionalTable('shop_items', [q('*', 'id.asc')]),
    fetchOptionalTable('items', [q('*', 'id.asc')]),
    fetchOptionalTable('reputation_thresholds', [q('*', 'id.asc')]),
    fetchOptionalTable('effect_definitions', [q('*', 'id.asc')]),
    fetchOptionalTable('factions', [q('*', 'id.asc')]),
  ]);

  return {
    generated_at: new Date().toISOString(),
    shop_items: shopItems ?? [],
    items: items ?? [],
    thresholds: thresholds ?? [],
    effect_definitions: effectDefinitions ?? [],
    factions: factions ?? [],
  };
}

async function buildCraftCatalogBundle() {
  const [
    items,
    skills,
    professions,
    recipes,
    recipeIngredients,
    recipeSkillRequirements,
    recipeSpellRequirements,
    spells,
    metamagicOptions,
    thresholds,
    effectDefinitions,
  ] = await Promise.all([
    fetchOptionalTable('items', [q('*', 'id.asc')]),
    fetchOptionalTable('skills', [q('*', 'id.asc')]),
    fetchOptionalTable('professions', [q('*', 'id.asc')]),
    fetchOptionalTable('recipes', [q('*', 'id.asc')]),
    fetchOptionalTable('recipe_ingredients', [q('*', 'id.asc')]),
    fetchOptionalTable('recipe_skill_requirements', [q('*', 'id.asc')]),
    fetchOptionalTable('recipe_spell_requirements', [q('*', 'id.asc')]),
    fetchOptionalTable('spells', [q('*', 'id.asc')]),
    fetchOptionalTable('metamagic_options', [q('*', 'id.asc')]),
    fetchOptionalTable('reputation_thresholds', [q('*', 'id.asc')]),
    fetchOptionalTable('effect_definitions', [q('*', 'id.asc')]),
  ]);

  return {
    generated_at: new Date().toISOString(),
    items: items ?? [],
    skills: skills ?? [],
    professions: professions ?? [],
    recipes: recipes ?? [],
    recipe_ingredients: recipeIngredients ?? [],
    recipe_skill_requirements: recipeSkillRequirements ?? [],
    recipe_spell_requirements: recipeSpellRequirements ?? [],
    spells: spells ?? [],
    metamagic_options: metamagicOptions ?? [],
    thresholds: thresholds ?? [],
    effect_definitions: effectDefinitions ?? [],
  };
}

function buildManifest({ reference, content, characterCards, mapsPublic, shopCatalog, craftCatalog }) {
  return {
    generated_at: new Date().toISOString(),
    bucket: 'github-pages',
    bundles: {
      reference: buildPublicBundleEntry('reference', reference.generated_at),
      content: buildPublicBundleEntry('content', content.generated_at),
      'character-cards': buildPublicBundleEntry('character-cards', characterCards.generated_at),
      'maps-public': buildPublicBundleEntry('maps-public', mapsPublic.generated_at),
      'shop-catalog': buildPublicBundleEntry('shop-catalog', shopCatalog.generated_at),
      'craft-catalog': buildPublicBundleEntry('craft-catalog', craftCatalog.generated_at),
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
      <li><a href="./bundles/maps-public.json">maps-public.json</a></li>
      <li><a href="./bundles/shop-catalog.json">shop-catalog.json</a></li>
      <li><a href="./bundles/craft-catalog.json">craft-catalog.json</a></li>
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

  const reference = await buildReferenceBundle();
  const content = await buildContentBundle();
  const characterCards = await buildCharacterCardsBundle();
  const mapsPublic = await buildMapsPublicBundle();
  const shopCatalog = await buildShopCatalogBundle();
  const craftCatalog = await buildCraftCatalogBundle();

  const manifest = buildManifest({ reference, content, characterCards, mapsPublic, shopCatalog, craftCatalog });

  await Promise.all([
    writeJson(path.join(BUNDLES_DIR, 'reference.json'), reference),
    writeJson(path.join(BUNDLES_DIR, 'content.json'), content),
    writeJson(path.join(BUNDLES_DIR, 'character-cards.json'), characterCards),
    writeJson(path.join(BUNDLES_DIR, 'maps-public.json'), mapsPublic),
    writeJson(path.join(BUNDLES_DIR, 'shop-catalog.json'), shopCatalog),
    writeJson(path.join(BUNDLES_DIR, 'craft-catalog.json'), craftCatalog),
    writeJson(path.join(BUNDLES_DIR, 'manifest.json'), manifest),
    writeSupportPages(),
  ]);

  console.log('Bundles generated successfully');
  console.log(`Public base URL: ${BUNDLE_PUBLIC_BASE_URL}`);
}

await main();
